import crypto from "node:crypto";

import type { CompiledProviderMessage } from "./prompt-compiler.ts";
import { promptCompilerModule } from "./prompt-compiler.ts";
import type { ProviderAdapter, ProviderTurnInput, RepairInvalidResponseInput } from "./provider.ts";
import type { ProviderFailure as ProviderFailureType } from "./provider-failure.ts";
import { providerFailureModule } from "./provider-failure.ts";

const { ProviderFailure, classifyProviderTransportError, withProviderRecovery } =
  providerFailureModule;
const { compileProviderTurn } = promptCompilerModule;
type UpstreamConversationBinding = {
  conversationId: string;
  parentId: string;
  runtimePlannerPrimed?: boolean;
};
interface SessionBindingStore {
  loadBinding(providerId: string, sessionId: string): Promise<UpstreamConversationBinding | null>;
  saveBinding(
    providerId: string,
    sessionId: string,
    binding: UpstreamConversationBinding
  ): Promise<void>;
  clearBinding(providerId: string, sessionId: string): Promise<void>;
}
type ProviderTransportRequest = {
  lane: "main" | "repair";
  providerId: string;
  modelId: string;
  sessionId: string;
  requestId: string;
  attempt: number;
  continuation: boolean;
  toolFollowUp: boolean;
  providerSessionReused: boolean;
  messages: CompiledProviderMessage[];
  upstreamBinding: Pick<UpstreamConversationBinding, "conversationId" | "parentId"> | null;
};
type ProviderTransportResponse = {
  content: string;
  upstreamBinding?: Pick<UpstreamConversationBinding, "conversationId" | "parentId"> | null;
};
interface ProviderTransport {
  completeChat(request: ProviderTransportRequest): Promise<ProviderTransportResponse>;
}
type SessionBoundProviderAdapterOptions = {
  providerId: string;
  modelId: string;
  transport: ProviderTransport;
  sessionBindingStore?: SessionBindingStore;
  sessionId?: string;
  bridgeRequestId?: string;
  onTraceEvent?: (type: string, detail: unknown) => void;
};
const MAX_SOFT_RETRIES = 1;
const MAX_SESSION_RESETS = 1;
class SessionBoundProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly #modelId: string;
  readonly #transport: ProviderTransport;
  readonly #sessionBindingStore: SessionBindingStore | undefined;
  readonly #sessionId: string;
  readonly #bridgeRequestId: string;
  readonly #onTraceEvent: ((type: string, detail: unknown) => void) | undefined;
  #providerTurnCount = 0;
  constructor(options: SessionBoundProviderAdapterOptions) {
    this.id = options.providerId;
    this.#modelId = options.modelId;
    this.#transport = options.transport;
    this.#sessionBindingStore = options.sessionBindingStore;
    this.#sessionId = options.sessionId ?? `bridge-runtime:${crypto.randomUUID()}`;
    this.#bridgeRequestId = options.bridgeRequestId ?? crypto.randomUUID();
    this.#onTraceEvent = options.onTraceEvent;
  }
  async completeTurn(input: ProviderTurnInput): Promise<string> {
    this.#providerTurnCount += 1;
    const providerTurnId = `${this.#bridgeRequestId}:provider-turn-${this.#providerTurnCount}`;
    const toolResultCount = input.conversation.entries.filter(
      (entry) => entry.type === "tool_result"
    ).length;
    const sessionHistoryTurns = input.conversation.sessionHistory?.length ?? 0;
    let binding = this.#sessionBindingStore
      ? await this.#sessionBindingStore.loadBinding(this.id, this.#sessionId).catch(() => null)
      : null;
    let forceReplay = false;
    let softRetryCount = 0;
    let sessionResetCount = 0;
    while (true) {
      const compiled = compileProviderTurn({
        conversation: input.conversation,
        availableTools: input.availableTools,
        runtimePlannerPrimed: binding?.runtimePlannerPrimed === true && !forceReplay,
        forceReplay
      });
      const messages = compiled.messages;
      const continuation = compiled.summary.turnType === "follow_up";
      const providerSessionReused = binding !== null;
      const attempt = softRetryCount + sessionResetCount + 1;
      const attemptStartedAt = Date.now();
      this.#onTraceEvent?.("provider_turn_started", {
        bridgeRequestId: this.#bridgeRequestId,
        providerTurnId,
        providerTurnIndex: this.#providerTurnCount,
        bridgeSessionId: this.#sessionId,
        providerId: this.id,
        modelId: this.#modelId,
        providerSessionId: binding?.conversationId ?? null,
        providerParentId: binding?.parentId ?? null,
        providerSessionReused,
        continuation,
        toolFollowUp: toolResultCount > 0,
        toolResultCount,
        sessionHistoryTurns,
        replayedFromBridgeSession: compiled.summary.replayedFromBridgeSession,
        attempt
      });
      try {
        const response = await this.#transport.completeChat({
          lane: "main",
          providerId: this.id,
          modelId: this.#modelId,
          sessionId: this.#sessionId,
          requestId: providerTurnId,
          attempt,
          continuation,
          toolFollowUp: toolResultCount > 0,
          providerSessionReused,
          messages,
          upstreamBinding: binding
            ? {
                conversationId: binding.conversationId,
                parentId: binding.parentId
              }
            : null
        });
        this.#assertNonEmptyResponse(response.content, {
          hasBinding: binding !== null
        });
        const nextBinding = response.upstreamBinding
          ? {
              ...response.upstreamBinding,
              runtimePlannerPrimed: Boolean(response.upstreamBinding.parentId)
            }
          : binding;
        if (this.#sessionBindingStore && nextBinding) {
          await this.#sessionBindingStore.saveBinding(this.id, this.#sessionId, nextBinding);
        }
        this.#onTraceEvent?.("provider_attempt_finished", {
          bridgeRequestId: this.#bridgeRequestId,
          providerTurnId,
          providerTurnIndex: this.#providerTurnCount,
          bridgeSessionId: this.#sessionId,
          providerId: this.id,
          modelId: this.#modelId,
          providerSessionId: nextBinding?.conversationId ?? null,
          providerParentId: nextBinding?.parentId ?? null,
          providerSessionReused,
          continuation,
          toolFollowUp: toolResultCount > 0,
          toolResultCount,
          sessionHistoryTurns,
          replayedFromBridgeSession: compiled.summary.replayedFromBridgeSession,
          attempt,
          latencyMs: Date.now() - attemptStartedAt,
          extractedOutputEmpty: false,
          recovery: {
            softRetryCount,
            sessionResetCount
          },
          outcome: "success"
        });
        return response.content;
      } catch (error) {
        const classified = withProviderRecovery(classifyProviderTransportError(error), {
          softRetryCount,
          sessionResetCount
        });
        const nextAction = selectRecoveryAction(classified, {
          softRetryCount,
          sessionResetCount,
          hasBinding: binding !== null
        });
        this.#onTraceEvent?.("provider_attempt_finished", {
          bridgeRequestId: this.#bridgeRequestId,
          providerTurnId,
          providerTurnIndex: this.#providerTurnCount,
          bridgeSessionId: this.#sessionId,
          providerId: this.id,
          modelId: this.#modelId,
          providerSessionId: binding?.conversationId ?? null,
          providerParentId: binding?.parentId ?? null,
          providerSessionReused,
          continuation,
          toolFollowUp: toolResultCount > 0,
          toolResultCount,
          sessionHistoryTurns,
          replayedFromBridgeSession: compiled.summary.replayedFromBridgeSession,
          attempt,
          latencyMs: Date.now() - attemptStartedAt,
          extractedOutputEmpty: classified.emptyOutput,
          failure: {
            kind: classified.kind,
            code: classified.code
          },
          recovery: {
            softRetryCount,
            sessionResetCount
          },
          outcome: nextAction
        });
        if (nextAction === "soft_retry") {
          softRetryCount += 1;
          continue;
        }
        if (nextAction === "session_reset") {
          if (!this.#sessionBindingStore) {
            throw classified;
          }
          try {
            await this.#sessionBindingStore.clearBinding(this.id, this.#sessionId);
          } catch (resetError) {
            throw withProviderRecovery(
              new ProviderFailure({
                kind: "permanent",
                code: "session_reset_failed",
                message: resetError instanceof Error ? resetError.message : String(resetError),
                displayMessage: "Provider session reset failed.",
                retryable: false,
                sessionResetEligible: false,
                cause: resetError
              }),
              {
                softRetryCount,
                sessionResetCount
              }
            );
          }
          sessionResetCount += 1;
          binding = null;
          forceReplay = true;
          this.#onTraceEvent?.("provider_session_reset", {
            bridgeRequestId: this.#bridgeRequestId,
            providerTurnId,
            providerTurnIndex: this.#providerTurnCount,
            bridgeSessionId: this.#sessionId,
            providerId: this.id,
            modelId: this.#modelId,
            reason: {
              kind: classified.kind,
              code: classified.code
            },
            recovery: {
              softRetryCount,
              sessionResetCount
            }
          });
          continue;
        }
        throw classified;
      }
    }
  }
  async repairInvalidResponse(input: RepairInvalidResponseInput): Promise<string> {
    const repairSessionId = `${this.#sessionId}:repair:${crypto.randomUUID()}`;
    const repairRequestId = `${this.#bridgeRequestId}:provider-turn-${this.#providerTurnCount}:repair`;
    const repairMessages = buildRepairMessages(input);
    const toolResultCount = input.conversation.entries.filter(
      (entry) => entry.type === "tool_result"
    ).length;
    this.#onTraceEvent?.("provider_repair_started", {
      bridgeRequestId: this.#bridgeRequestId,
      providerId: this.id,
      modelId: this.#modelId,
      bridgeSessionId: this.#sessionId,
      repairSessionId,
      repairRequestId,
      providerTurnIndex: this.#providerTurnCount
    });
    const startedAt = Date.now();
    try {
      const response = await this.#transport.completeChat({
        lane: "repair",
        providerId: this.id,
        modelId: this.#modelId,
        sessionId: repairSessionId,
        requestId: repairRequestId,
        attempt: 1,
        continuation: false,
        toolFollowUp: toolResultCount > 0,
        providerSessionReused: false,
        messages: repairMessages,
        upstreamBinding: null
      });
      this.#assertNonEmptyResponse(response.content, {
        hasBinding: false
      });
      this.#onTraceEvent?.("provider_repair_finished", {
        bridgeRequestId: this.#bridgeRequestId,
        providerId: this.id,
        modelId: this.#modelId,
        bridgeSessionId: this.#sessionId,
        repairSessionId,
        repairRequestId,
        providerTurnIndex: this.#providerTurnCount,
        latencyMs: Date.now() - startedAt,
        contentLength: response.content.length,
        outcome: "success"
      });
      return response.content;
    } catch (error) {
      const classified = classifyProviderTransportError(error);
      this.#onTraceEvent?.("provider_repair_failed", {
        bridgeRequestId: this.#bridgeRequestId,
        providerId: this.id,
        modelId: this.#modelId,
        bridgeSessionId: this.#sessionId,
        repairSessionId,
        repairRequestId,
        providerTurnIndex: this.#providerTurnCount,
        latencyMs: Date.now() - startedAt,
        failure: {
          kind: classified.kind,
          code: classified.code
        }
      });
      throw error;
    }
  }
  #assertNonEmptyResponse(
    content: string,
    context: {
      hasBinding: boolean;
    }
  ) {
    if (!content.trim()) {
      throw new ProviderFailure({
        kind: "transient",
        code: "empty_response",
        message: "Provider returned an empty response.",
        retryable: true,
        sessionResetEligible: context.hasBinding,
        emptyOutput: true
      });
    }
  }
}
function selectRecoveryAction(
  failure: ProviderFailureType,
  state: {
    softRetryCount: number;
    sessionResetCount: number;
    hasBinding: boolean;
  }
) {
  if (failure.retryable && state.softRetryCount < MAX_SOFT_RETRIES) {
    return "soft_retry" as const;
  }
  if (
    (failure.kind === "session_corruption" || failure.sessionResetEligible) &&
    state.sessionResetCount < MAX_SESSION_RESETS &&
    state.hasBinding
  ) {
    return "session_reset" as const;
  }
  return "failed" as const;
}
function buildRepairMessages(input: RepairInvalidResponseInput): CompiledProviderMessage[] {
  const latestToolResult = [...input.conversation.entries]
    .reverse()
    .find((entry) => entry.type === "tool_result");
  return [
    {
      role: "system",
      content: [
        "You are the bridge repair lane.",
        "Re-emit the same intent as exactly one valid bridge packet.",
        "Return exactly one block only.",
        "Use <final>...</final> for assistant text.",
        'Use <tool>{"name":"tool_name","arguments":{...}}</tool> for one tool call.',
        "No markdown.",
        "No backticks.",
        "No extra text before or after the block.",
        "If using <tool>, the JSON must contain only name and arguments.",
        "Do not invent new intent.",
        "Do not explain.",
        "Do not expose reasoning.",
        "Do not perform side effects. Only repair the packet encoding."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "Bridge packet protocol:",
        "Return exactly one valid packet block.",
        "The deterministic parser and tool schema validator are the final authority.",
        "Available tools:",
        renderRepairToolManifest(input.availableTools),
        `Latest user request:\n${getRepairUserMessage(input.conversation)}`,
        ...(latestToolResult ? [`Latest tool result:\n${latestToolResult.rawText}`] : []),
        `Raw invalid candidate output:\n${input.invalidResponse}`,
        `Validation error:\n${input.validationError}`,
        "Re-emit the same intent now as exactly one valid packet."
      ].join("\n\n")
    }
  ];
}
function getRepairUserMessage(conversation: RepairInvalidResponseInput["conversation"]) {
  const userEntry = conversation.entries.find((entry) => entry.type === "user_message");
  if (!userEntry) {
    throw new Error("Conversation state is missing the initial user message.");
  }
  return userEntry.content;
}
function renderRepairToolManifest(availableTools: RepairInvalidResponseInput["availableTools"]) {
  if (availableTools.length === 0) {
    return "(none)";
  }
  return availableTools
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      const required =
        tool.inputSchema.required.length > 0 ? tool.inputSchema.required.join(", ") : "(none)";
      const properties = Object.entries(tool.inputSchema.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, property]) => `${name}: ${property.type} - ${property.description}`)
        .join("; ");
      return `- ${tool.name}: ${tool.description} | required: ${required} | args: ${properties || "(none)"}`;
    })
    .join("\n");
}

export const sessionBoundProviderModule = {
  SessionBoundProviderAdapter
};

export type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse,
  SessionBindingStore,
  SessionBoundProviderAdapter,
  SessionBoundProviderAdapterOptions,
  UpstreamConversationBinding
};
