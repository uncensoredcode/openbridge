import crypto from "node:crypto";

import type {
  AssistantResponse,
  BridgeSessionTurn,
  CompiledProviderMessage,
  ProviderTransport,
  RuntimeOutcome,
  SerializedProviderFailure,
  SessionBindingStore,
  UpstreamConversationBinding,
  ZcPacket
} from "@uncensoredcode/openbridge/runtime";
import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";

import type { BridgeServerConfig } from "../config/index.ts";
import type {
  BridgeChatCompletionRequest,
  BridgeChatCompletionTool,
  BridgeMessageRequest,
  BridgeMessageResponse
} from "../shared/api-schema.ts";
import { bridgeApiErrorModule } from "../shared/bridge-api-error.ts";
import { outputModule } from "../shared/output.ts";
import { bridgeModelCatalogModule } from "./bridge-model-catalog.ts";
import { providerSessionResolverModule } from "./providers/provider-session-resolver.ts";
import type { ProviderStreamFragment } from "./providers/provider-streams.ts";
import { providerStreamsModule } from "./providers/provider-streams.ts";
import type { StreamingProviderTransport } from "./providers/web-provider-transport.ts";
import { webProviderTransportModule } from "./providers/web-provider-transport.ts";
import { fileBridgeStateStoreModule } from "./state/file-bridge-state-store.ts";
import type { ProviderRecord } from "./stores/provider-store.ts";
import type { SessionPackageStore } from "./stores/session-package-store.ts";

const {
  classifyProviderTransportError,
  compileProviderTurn,
  createMessagePacket,
  createToolRequestPacket,
  extractPacketCandidate,
  parseAssistantResponse,
  parseZcPacket,
  serializeAssistantResponse,
  normalizeProviderToolName,
  normalizeProviderPacket,
  ProviderFailure,
  SessionBoundProviderAdapter,
  runBridgeRuntime,
  serializeProviderFailure
} = bridgeRuntime;
const { BridgeApiError } = bridgeApiErrorModule;
const { sanitizeBridgeApiOutput } = outputModule;
const { defaultModelForProvider } = bridgeModelCatalogModule;
const { createBridgeProviderSessionResolver } = providerSessionResolverModule;
const { extractIncrementalPacketMessage } = providerStreamsModule;
const { WebProviderTransport } = webProviderTransportModule;
const { FileBridgeStateStore } = fileBridgeStateStoreModule;
type BridgeRuntimeServiceDependencies = {
  config: BridgeServerConfig;
  loadProvider?: (providerId: string) => ProviderRecord | null;
  sessionBindingStore?: SessionBindingStore;
  sessionPackageStore?: SessionPackageStore;
  transport?: ProviderTransport;
  onLog?: (event: BridgeRuntimeServiceLogEvent) => void;
};
type BridgeRuntimeService = ReturnType<typeof createBridgeRuntimeService>;
type BridgeRuntimeServiceLogEvent = {
  scope: "request" | "provider" | "runtime";
  event: string;
  requestId: string;
  detail: Record<string, unknown>;
};
type BridgeRuntimeExecutionRequest = {
  sessionId: string;
  input: string;
  providerId: string;
  modelId: string;
  metadata?: Record<string, unknown>;
  sessionHistory?: BridgeSessionTurn[];
  persistSession?: boolean;
};
type SuccessfulRuntimeOutcome = RuntimeOutcome & {
  mode: "final" | "ask_user";
};
type ChatCompletionPacketRequest = {
  sessionId: string;
  providerId: string;
  modelId: string;
  messages: CompiledProviderMessage[];
  tools: BridgeChatCompletionTool[];
  toolChoice?: BridgeChatCompletionRequest["tool_choice"];
  continuation: boolean;
  toolFollowUp: boolean;
  metadata?: Record<string, unknown>;
  persistSession?: boolean;
};
type RepairRecoverySummary = {
  attempted: boolean;
  attemptCount: number;
  outcome: "not_needed" | "valid" | "failed";
  failureReason?: "provider_failure" | "protocol_invalid";
  invalidCount: number;
};
type RequestRecoverySummary = {
  softRetryCount: number;
  providerSessionResetCount: number;
  repair: RepairRecoverySummary;
};
function createBridgeRuntimeService(dependencies: BridgeRuntimeServiceDependencies) {
  const stateStore = new FileBridgeStateStore(dependencies.config.stateRoot);
  const sessionBindingStore = dependencies.sessionBindingStore ?? stateStore;
  const emitLog = dependencies.onLog ?? defaultLogEvent;
  const transport =
    dependencies.transport ??
    new WebProviderTransport({
      providerSessionResolver: createBridgeProviderSessionResolver({
        sessionPackageStore: dependencies.sessionPackageStore,
        stateStore
      }),
      loadProvider: dependencies.loadProvider
    });
  return {
    async respond(
      request: BridgeMessageRequest,
      pathSessionId?: string
    ): Promise<BridgeMessageResponse> {
      const normalized = normalizeBridgeRequest(
        request,
        pathSessionId,
        dependencies.config,
        dependencies.loadProvider
      );
      const sessionHistory = await stateStore.loadSessionHistory(normalized.sessionId);
      return executeBridgeRequest({
        ...normalized,
        sessionHistory,
        persistSession: true
      });
    },
    async execute(request: BridgeRuntimeExecutionRequest): Promise<BridgeMessageResponse> {
      return executeBridgeRequest({
        sessionId: request.sessionId,
        input: request.input,
        providerId: request.providerId,
        modelId: request.modelId,
        metadata: request.metadata,
        sessionHistory: request.sessionHistory ?? [],
        persistSession: request.persistSession ?? false
      });
    },
    async completeChatCompletionPacket(request: ChatCompletionPacketRequest): Promise<{
      packet: AssistantResponse;
      providerBindingReused: boolean;
    }> {
      const bindingStore = request.persistSession
        ? sessionBindingStore
        : createInMemorySessionBindingStore();
      const providerBindingBefore = await bindingStore.loadBinding(
        request.providerId,
        request.sessionId
      );
      try {
        const completion = await completeValidatedChatCompletionPacket(
          request,
          providerBindingBefore,
          {
            mode: "complete",
            transport
          }
        );
        if (completion.nextBinding) {
          await bindingStore.saveBinding(
            request.providerId,
            request.sessionId,
            completion.nextBinding
          );
        }
        return {
          packet: completion.packet,
          providerBindingReused: providerBindingBefore !== null
        };
      } catch (error) {
        throw classifyChatCompletionPacketFailure(error, request, providerBindingBefore !== null);
      }
    },
    async streamChatCompletionPacket(request: ChatCompletionPacketRequest): Promise<{
      content: AsyncIterable<ProviderStreamFragment>;
      packet: Promise<AssistantResponse>;
      providerBindingReused: boolean;
    }> {
      const bindingStore = request.persistSession
        ? sessionBindingStore
        : createInMemorySessionBindingStore();
      const providerBindingBefore = await bindingStore.loadBinding(
        request.providerId,
        request.sessionId
      );
      const providerBindingReused = providerBindingBefore !== null;
      try {
        const completion = await completeValidatedChatCompletionPacket(
          request,
          providerBindingBefore,
          {
            mode: isStreamingProviderTransport(transport) ? "stream" : "complete",
            transport
          }
        );
        if (completion.nextBinding) {
          await bindingStore.saveBinding(
            request.providerId,
            request.sessionId,
            completion.nextBinding
          );
        }
        return {
          providerBindingReused,
          packet: Promise.resolve(completion.packet),
          content: singleProviderFragmentStream(serializeChatCompletionPacket(completion.packet))
        };
      } catch (error) {
        throw classifyChatCompletionPacketFailure(error, request, providerBindingReused);
      }
    },
    async streamChatCompletion(
      request: BridgeRuntimeExecutionRequest
    ): Promise<AsyncIterable<string>> {
      const normalized = {
        sessionId: request.sessionId,
        input: request.input,
        providerId: request.providerId,
        modelId: request.modelId,
        metadata: request.metadata,
        sessionHistory: request.sessionHistory ?? [],
        persistSession: request.persistSession ?? false
      };
      if (isStreamingProviderTransport(transport)) {
        const bindingStore = normalized.persistSession
          ? sessionBindingStore
          : createInMemorySessionBindingStore();
        try {
          const providerBindingBefore = await bindingStore.loadBinding(
            normalized.providerId,
            normalized.sessionId
          );
          const compiled = compileProviderTurn({
            conversation: {
              sessionHistory: normalized.sessionHistory,
              entries: [
                {
                  type: "user_message",
                  content: normalized.input
                }
              ]
            },
            availableTools: [],
            runtimePlannerPrimed: providerBindingBefore?.runtimePlannerPrimed === true,
            forceReplay: false
          });
          const stream = await transport.streamChat({
            lane: "main",
            providerId: normalized.providerId,
            modelId: normalized.modelId,
            sessionId: normalized.sessionId,
            requestId: crypto.randomUUID(),
            attempt: 1,
            continuation: compiled.summary.turnType === "follow_up",
            toolFollowUp: false,
            providerSessionReused: providerBindingBefore !== null,
            messages: compiled.messages,
            upstreamBinding: providerBindingBefore
              ? {
                  conversationId: providerBindingBefore.conversationId,
                  parentId: providerBindingBefore.parentId
                }
              : null
          });
          return (async function* () {
            let rawOutput = "";
            let emittedOutput = "";
            for await (const chunk of stream.content) {
              rawOutput += chunk.content;
              const visibleContent = extractIncrementalPacketMessage(rawOutput);
              if (
                visibleContent.startsWith(emittedOutput) &&
                visibleContent.length > emittedOutput.length
              ) {
                const delta = visibleContent.slice(emittedOutput.length);
                emittedOutput = visibleContent;
                yield delta;
              }
            }
            const upstreamBinding = await stream.upstreamBinding;
            if (upstreamBinding) {
              await bindingStore.saveBinding(normalized.providerId, normalized.sessionId, {
                ...upstreamBinding,
                runtimePlannerPrimed: Boolean(upstreamBinding.parentId)
              });
            }
            const output = sanitizeBridgeApiOutput(rawOutput).content;
            if (output.startsWith(emittedOutput) && output.length > emittedOutput.length) {
              yield output.slice(emittedOutput.length);
            } else if (!emittedOutput && output) {
              yield output;
            }
            if (normalized.persistSession && output) {
              await stateStore.appendSessionTurn(normalized.sessionId, {
                userMessage: normalized.input,
                assistantMessage: output,
                assistantMode: "final"
              });
            }
          })();
        } catch (error) {
          throw classifyProviderFailure(
            serializeProviderFailure(classifyProviderTransportError(error)),
            {
              sessionId: normalized.sessionId,
              provider: {
                id: normalized.providerId,
                model: normalized.modelId
              },
              steps: 1,
              recovery: {
                softRetryCount: 0,
                providerSessionResetCount: 0
              }
            }
          );
        }
      }
      const response = await executeBridgeRequest(normalized);
      return singleChunkStream(response.output);
    }
  };
  async function executeBridgeRequest(
    request: Required<
      Pick<BridgeRuntimeExecutionRequest, "sessionId" | "input" | "providerId" | "modelId">
    > & {
      metadata?: Record<string, unknown>;
      sessionHistory: BridgeSessionTurn[];
      persistSession: boolean;
    }
  ): Promise<BridgeMessageResponse> {
    const requestId = crypto.randomUUID();
    const bindingStore = request.persistSession
      ? sessionBindingStore
      : createInMemorySessionBindingStore();
    const providerBindingBefore = await bindingStore.loadBinding(
      request.providerId,
      request.sessionId
    );
    const recoverySummary = {
      softRetryCount: 0,
      providerSessionResetCount: 0,
      repair: createInitialRepairRecoverySummary()
    };
    emitLog({
      scope: "request",
      event: "bridge_request_started",
      requestId,
      detail: {
        bridgeSessionId: request.sessionId,
        providerId: request.providerId,
        modelId: request.modelId,
        sessionHistoryTurns: request.sessionHistory.length,
        providerBindingReused: providerBindingBefore !== null
      }
    });
    const provider = new SessionBoundProviderAdapter({
      providerId: request.providerId,
      modelId: request.modelId,
      sessionId: request.sessionId,
      bridgeRequestId: requestId,
      sessionBindingStore: bindingStore,
      transport,
      onTraceEvent(type, detail) {
        const record = asRecord(detail);
        if (record.outcome === "soft_retry") {
          recoverySummary.softRetryCount += 1;
        }
        if (type === "provider_session_reset") {
          recoverySummary.providerSessionResetCount += 1;
        }
        emitLog({
          scope: "provider",
          event: type,
          requestId,
          detail: record
        });
      }
    });
    const outcome = await runBridgeRuntime({
      userMessage: request.input,
      sessionHistory: request.sessionHistory,
      provider,
      availableTools: [],
      config: {
        maxSteps: dependencies.config.maxSteps,
        onEvent(event) {
          updateRepairRecoverySummary(recoverySummary.repair, event);
          emitLog({
            scope: "runtime",
            event: event.type,
            requestId,
            detail: summarizeRuntimeEvent(event)
          });
        }
      }
    });
    emitLog({
      scope: "request",
      event: "bridge_request_finished",
      requestId,
      detail: {
        bridgeSessionId: request.sessionId,
        providerId: request.providerId,
        modelId: request.modelId,
        outcomeMode: outcome.mode,
        steps: outcome.steps,
        recovery: recoverySummary
      }
    });
    if (outcome.mode === "fail") {
      throw classifyRuntimeFailure(
        request.sessionId,
        request.providerId,
        request.modelId,
        outcome,
        recoverySummary
      );
    }
    if (request.persistSession) {
      await stateStore.appendSessionTurn(request.sessionId, {
        userMessage: request.input,
        assistantMessage: outcome.message,
        assistantMode: outcome.mode
      });
    }
    const successfulOutcome = outcome as SuccessfulRuntimeOutcome;
    return buildBridgeMessageResponse(
      {
        sessionId: request.sessionId,
        providerId: request.providerId,
        modelId: request.modelId,
        metadata: request.metadata
      },
      successfulOutcome,
      providerBindingBefore !== null,
      recoverySummary
    );
  }
}
function isStreamingProviderTransport(
  transport: ProviderTransport
): transport is ProviderTransport & StreamingProviderTransport {
  return "streamChat" in transport && typeof transport.streamChat === "function";
}
async function* singleChunkStream(content: string) {
  if (content) {
    yield content;
  }
}
async function* singleProviderFragmentStream(
  content: string
): AsyncGenerator<ProviderStreamFragment> {
  if (content) {
    yield {
      content,
      responseId: "",
      conversationId: "",
      eventCountDelta: 0,
      fragmentCountDelta: 1
    };
  }
}
function serializeChatCompletionPacket(packet: AssistantResponse) {
  return serializeAssistantResponse(packet);
}
async function completeValidatedChatCompletionPacket(
  request: ChatCompletionPacketRequest,
  providerBindingBefore: UpstreamConversationBinding | null,
  options: {
    mode: "complete" | "stream";
    transport: ProviderTransport;
  }
) {
  let binding = providerBindingBefore;
  let currentRequest = request;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await executeChatCompletionTransportAttempt(
      currentRequest,
      binding,
      attempt,
      attempt === 1 ? options.mode : "complete",
      options.transport
    );
    const nextBinding = response.upstreamBinding
      ? {
          ...response.upstreamBinding,
          runtimePlannerPrimed: binding?.runtimePlannerPrimed
        }
      : binding;
    try {
      return {
        packet: validateChatCompletionPacket(
          response.content,
          currentRequest.providerId,
          currentRequest.toolFollowUp,
          currentRequest.tools,
          currentRequest.toolChoice
        ),
        nextBinding
      };
    } catch (error) {
      const repairHint = buildChatCompletionRepairHint(error);
      if (!repairHint || attempt === 3) {
        throw error;
      }
      currentRequest = {
        ...request,
        messages: buildChatCompletionRepairMessages(request.messages, repairHint)
      };
      binding = nextBinding;
    }
  }
  throw new Error("unreachable");
}
async function executeChatCompletionTransportAttempt(
  request: ChatCompletionPacketRequest,
  upstreamBinding: UpstreamConversationBinding | null,
  attempt: number,
  mode: "complete" | "stream",
  transport: ProviderTransport
) {
  const baseRequest = {
    lane: "main" as const,
    providerId: request.providerId,
    modelId: request.modelId,
    sessionId: request.sessionId,
    requestId: crypto.randomUUID(),
    attempt,
    continuation: request.continuation,
    toolFollowUp: request.toolFollowUp,
    providerSessionReused: upstreamBinding !== null,
    messages: request.messages,
    upstreamBinding: upstreamBinding
      ? {
          conversationId: upstreamBinding.conversationId,
          parentId: upstreamBinding.parentId
        }
      : null
  };
  if (mode === "stream" && isStreamingProviderTransport(transport)) {
    const stream = await transport.streamChat(baseRequest);
    let content = "";
    for await (const chunk of stream.content) {
      content += chunk.content;
    }
    return {
      content,
      upstreamBinding: await stream.upstreamBinding
    };
  }
  return await transport.completeChat(baseRequest);
}
function normalizeBridgeRequest(
  request: BridgeMessageRequest,
  pathSessionId: string | undefined,
  config: BridgeServerConfig,
  loadProvider?: (providerId: string) => ProviderRecord | null
) {
  if (!isRecord(request)) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "Request body must be a JSON object."
    });
  }
  const bodySessionId = optionalTrimmedString(request.sessionId, "sessionId");
  if (pathSessionId && bodySessionId && pathSessionId !== bodySessionId) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "sessionId in the request body must match the sessionId path parameter."
    });
  }
  const sessionId = pathSessionId ?? bodySessionId;
  if (!sessionId) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "sessionId is required."
    });
  }
  const input = resolveInput(request);
  const providerId = optionalTrimmedString(request.provider, "provider") ?? config.defaultProvider;
  if (!providerId) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "provider_required",
      message: "provider is required when BRIDGE_PROVIDER is not configured."
    });
  }
  const modelId =
    optionalTrimmedString(request.model, "model") ??
    config.defaultModel ??
    defaultModelForProvider(loadProvider?.(providerId) ?? null);
  if (!modelId) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "model_required",
      message: "model is required when BRIDGE_MODEL is not configured."
    });
  }
  const metadata = normalizeMetadata(request.metadata);
  return {
    sessionId,
    input,
    providerId,
    modelId,
    metadata
  };
}
function resolveInput(request: BridgeMessageRequest) {
  const input = optionalTrimmedString(request.input, "input");
  const message = optionalTrimmedString(request.message, "message");
  if (input && message && input !== message) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "input and message must match when both are provided."
    });
  }
  const resolved = input ?? message;
  if (!resolved) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "input is required."
    });
  }
  return resolved;
}
function normalizeMetadata(value: BridgeMessageRequest["metadata"]) {
  if (value === undefined) {
    return undefined;
  }
  if (isRecord(value)) {
    return value;
  }
  throw new BridgeApiError({
    statusCode: 400,
    code: "invalid_request",
    message: "metadata must be a JSON object."
  });
}
function classifyRuntimeFailure(
  sessionId: string,
  providerId: string,
  modelId: string,
  outcome: RuntimeOutcome,
  recoverySummary: RequestRecoverySummary
) {
  const details = {
    sessionId,
    provider: {
      id: providerId,
      model: modelId
    },
    steps: outcome.steps,
    recovery: recoverySummary
  };
  if (outcome.failure?.source === "provider") {
    return classifyProviderFailure(outcome.failure.provider, details);
  }
  if (outcome.failure?.source === "protocol") {
    return new BridgeApiError({
      statusCode: 502,
      code: "provider_protocol_failure",
      message: outcome.failure.message,
      details: {
        ...details,
        failure: {
          source: "protocol",
          code: outcome.failure.code
        }
      }
    });
  }
  if (outcome.failure?.source === "runtime" && outcome.failure.code === "max_steps_exhausted") {
    return new BridgeApiError({
      statusCode: 502,
      code: "runtime_exhausted",
      message: outcome.failure.message,
      details: {
        ...details,
        failure: {
          source: "runtime",
          code: outcome.failure.code
        }
      }
    });
  }
  return new BridgeApiError({
    statusCode: 502,
    code: "runtime_failure",
    message: outcome.message,
    details
  });
}
function buildBridgeMessageResponse(
  request: {
    sessionId: string;
    providerId: string;
    modelId: string;
    metadata?: Record<string, unknown>;
  },
  outcome: SuccessfulRuntimeOutcome,
  providerBindingReused: boolean,
  recoverySummary: RequestRecoverySummary
): BridgeMessageResponse {
  const sanitized = sanitizeBridgeApiOutput(outcome.message);
  return {
    sessionId: request.sessionId,
    output: sanitized.content,
    outcome: {
      mode: outcome.mode,
      steps: outcome.steps
    },
    provider: {
      id: request.providerId,
      model: request.modelId
    },
    session: {
      providerBindingReused
    },
    meta: {
      outputSanitized: sanitized.sanitized,
      sanitizationReason: sanitized.sanitized ? sanitized.reason : undefined,
      requestMetadata: request.metadata,
      recovery: recoverySummary
    }
  };
}
function classifyProviderFailure(
  failure: SerializedProviderFailure,
  details: Record<string, unknown>
) {
  const errorDetails = {
    ...details,
    failure
  };
  const safeFailureMessage = formatSafeProviderFailureMessage(failure);
  switch (failure.code) {
    case "transport_timeout":
      return new BridgeApiError({
        statusCode: 504,
        code: "provider_timeout",
        message: safeFailureMessage,
        details: errorDetails
      });
    case "empty_response":
    case "empty_extracted_response":
    case "empty_final_message":
      return new BridgeApiError({
        statusCode: 502,
        code: "provider_empty_response",
        message: safeFailureMessage,
        details: errorDetails
      });
    case "packet_extraction_failed":
    case "packet_normalization_failed":
    case "packet_validation_failed":
      return new BridgeApiError({
        statusCode: 502,
        code: "provider_protocol_failure",
        message: safeFailureMessage,
        details: errorDetails
      });
    case "authentication_failed":
      return new BridgeApiError({
        statusCode: 502,
        code: "provider_auth_failure",
        message: safeFailureMessage,
        details: errorDetails
      });
    case "request_invalid":
    case "unsupported_request":
      return new BridgeApiError({
        statusCode: 400,
        code: "provider_request_failure",
        message: safeFailureMessage,
        details: errorDetails
      });
    case "session_reset_failed":
      return new BridgeApiError({
        statusCode: 502,
        code: "provider_session_reset_failed",
        message: safeFailureMessage,
        details: errorDetails
      });
    case "transport_error":
    default:
      return new BridgeApiError({
        statusCode: 502,
        code: "provider_failure",
        message: safeFailureMessage,
        details: errorDetails
      });
  }
}
function formatSafeProviderFailureMessage(failure: SerializedProviderFailure) {
  if (failure.code === "transport_error") {
    const details = failure.details;
    if (
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      typeof details.stage === "string" &&
      typeof details.httpStatus === "number"
    ) {
      return `Provider request failed during ${details.stage} with HTTP ${details.httpStatus}${formatProviderRecoverySummary(failure.recovery)}.`;
    }
  }
  return failure.message;
}
function formatProviderRecoverySummary(recovery: {
  softRetryCount: number;
  sessionResetCount: number;
}) {
  const parts: string[] = [];
  if (recovery.softRetryCount > 0) {
    parts.push(
      `${recovery.softRetryCount} soft retr${recovery.softRetryCount === 1 ? "y" : "ies"}`
    );
  }
  if (recovery.sessionResetCount > 0) {
    parts.push(
      `${recovery.sessionResetCount} provider-session reset${recovery.sessionResetCount === 1 ? "" : "s"}`
    );
  }
  if (parts.length === 0) {
    return "";
  }
  return ` after ${parts.join(" and ")}`;
}
function validateChatCompletionPacket(
  content: string,
  providerId: string,
  allowVisibleTextFinal: boolean,
  tools: BridgeChatCompletionTool[],
  toolChoice: BridgeChatCompletionRequest["tool_choice"]
) {
  if (!content.trim()) {
    throw new ProviderFailure({
      kind: "transient",
      code: "empty_response",
      message: "Provider returned an empty response.",
      retryable: true,
      sessionResetEligible: false,
      emptyOutput: true
    });
  }
  try {
    const packet = parseToolAwareAssistantResponse(providerId, content, allowVisibleTextFinal);
    validateChatCompletionAssistantResponse(packet, tools, toolChoice);
    return packet;
  } catch (error) {
    if (error instanceof ProviderFailure) {
      throw error;
    }
    throw new ProviderFailure({
      kind: "protocol",
      code: "packet_validation_failed",
      message: `Invalid assistant response: ${error instanceof Error ? error.message : String(error)}`,
      displayMessage: "Provider returned malformed or unusable output.",
      retryable: false,
      sessionResetEligible: false,
      cause: error
    });
  }
}
function parseToolAwareAssistantResponse(
  providerId: string,
  content: string,
  allowVisibleTextFinal: boolean
): AssistantResponse {
  const repairedSimplePacket = repairMalformedSimpleAssistantPacket(content);
  try {
    return normalizeAssistantResponseToolNames(parseAssistantResponse(repairedSimplePacket));
  } catch (assistantProtocolError) {
    const canonicalPacket =
      coerceMalformedCanonicalPacket(content) ??
      coerceToolAwareProviderOutput(content) ??
      (allowVisibleTextFinal ? wrapVisibleTextAsFinalPacket(content) : null) ??
      normalizeExtractedProviderPacket(providerId, content);
    if (!canonicalPacket) {
      throw assistantProtocolError;
    }
    const packet = parseZcPacket(canonicalPacket);
    switch (packet.mode) {
      case "final":
        return {
          type: "final",
          message: packet.message
        };
      case "tool_request":
        return {
          type: "tool",
          toolCall: {
            id: packet.toolCall.id,
            name: normalizeProviderToolName(packet.toolCall.name),
            arguments: packet.toolCall.args
          }
        };
      case "ask_user":
      case "fail":
        throw new Error(
          `Packet mode "${packet.mode}" is not supported for OpenAI-style chat completions.`
        );
      default:
        throw new Error("Unsupported packet mode.");
    }
  }
}
function normalizeAssistantResponseToolNames(packet: AssistantResponse): AssistantResponse {
  if (packet.type !== "tool") {
    return packet;
  }
  return {
    ...packet,
    toolCall: {
      ...packet.toolCall,
      name: normalizeProviderToolName(packet.toolCall.name)
    }
  };
}
function repairMalformedSimpleAssistantPacket(content: string) {
  const trimmed = content.trim();
  if (/^<tool>[\s\S]*<\/tool_call>$/u.test(trimmed) && !trimmed.includes("</tool>")) {
    return trimmed.replace(/<\/tool_call>$/u, "</tool>");
  }
  const repairedLeadingBlock = extractLeadingSimpleFinalBlock(trimmed);
  if (repairedLeadingBlock) {
    return repairedLeadingBlock;
  }
  return trimmed;
}
function extractLeadingSimpleFinalBlock(content: string) {
  const openTag = "<final>";
  const closeTag = "</final>";
  if (!content.startsWith(openTag)) {
    return null;
  }
  const closeIndex = content.indexOf(closeTag);
  if (closeIndex < 0) {
    return null;
  }
  const block = content.slice(0, closeIndex + closeTag.length);
  const trailing = content.slice(closeIndex + closeTag.length).trim();
  if (!trailing) {
    return block;
  }
  return trailing.startsWith("<") ? null : block;
}
function validateChatCompletionAssistantResponse(
  packet: AssistantResponse,
  tools: BridgeChatCompletionTool[],
  toolChoice: BridgeChatCompletionRequest["tool_choice"]
) {
  if (packet.type === "final") {
    return;
  }
  if (toolChoice === "none") {
    throw new ProviderFailure({
      kind: "permanent",
      code: "unsupported_request",
      message:
        "Provider requested a tool call even though tool calls are disabled for this request.",
      displayMessage: "Provider requested a disabled tool call.",
      retryable: false,
      sessionResetEligible: false,
      details: {
        toolName: packet.toolCall.name
      }
    });
  }
  if (typeof toolChoice === "object" && packet.toolCall.name !== toolChoice.function.name) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: `Provider requested tool "${packet.toolCall.name}" but only "${toolChoice.function.name}" is allowed for this request.`,
      displayMessage: `Provider requested unavailable tool "${packet.toolCall.name}".`,
      retryable: false,
      sessionResetEligible: false,
      details: {
        toolName: packet.toolCall.name,
        allowedToolNames: [toolChoice.function.name]
      }
    });
  }
  const tool = tools.find((candidate) => candidate.function.name === packet.toolCall.name);
  if (!tool) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: `Provider requested tool "${packet.toolCall.name}" but it is not present in the bridge tool manifest.`,
      displayMessage: `Provider requested unavailable tool "${packet.toolCall.name}".`,
      retryable: false,
      sessionResetEligible: false,
      details: {
        toolName: packet.toolCall.name,
        availableToolNames: tools.map((candidate) => candidate.function.name)
      }
    });
  }
  const schema = isRecord(tool.function.parameters) ? tool.function.parameters : null;
  if (!schema) {
    return;
  }
  const validationError = validateJsonSchemaValue(packet.toolCall.arguments, schema, "arguments");
  if (validationError) {
    throw new Error(validationError);
  }
}
function buildChatCompletionRepairHint(error: unknown) {
  if (!(error instanceof ProviderFailure)) {
    return null;
  }
  if (error.code !== "packet_validation_failed") {
    return null;
  }
  return [
    "Protocol error.",
    "",
    "You must answer using exactly one of these formats:",
    "",
    "<final>",
    "your text here",
    "</final>",
    "",
    "<tool>",
    '{"name":"tool_name","arguments":{}}',
    "</tool>",
    "",
    "Rules:",
    "- no markdown",
    "- no backticks",
    "- no extra text",
    "- exactly one block only",
    "- if using <tool>, arguments must be valid JSON",
    "",
    "Re-emit your previous intent now."
  ].join(" ");
}
function buildChatCompletionRepairMessages(
  messages: CompiledProviderMessage[],
  repairHint: string
): CompiledProviderMessage[] {
  return [
    ...messages,
    {
      role: "user",
      content: repairHint
    }
  ];
}
function classifyChatCompletionPacketFailure(
  error: unknown,
  request: Pick<
    ChatCompletionPacketRequest,
    "sessionId" | "providerId" | "modelId" | "continuation" | "toolFollowUp" | "metadata"
  >,
  providerBindingReused: boolean
) {
  return classifyProviderFailure(serializeProviderFailure(classifyProviderTransportError(error)), {
    sessionId: request.sessionId,
    provider: {
      id: request.providerId,
      model: request.modelId
    },
    continuation: request.continuation,
    toolFollowUp: request.toolFollowUp,
    providerBindingReused,
    requestMetadata: request.metadata
  });
}
function coerceToolAwareProviderOutput(content: string) {
  return (
    wrapLooseZcPacketAsCanonicalPacket(content) ??
    wrapBareToolCallAsCanonicalPacket(content) ??
    wrapBareFinalLikeMessageAsCanonicalPacket(content)
  );
}
function coerceMalformedCanonicalPacket(content: string) {
  const trimmed = content.trim();
  const rootMatch = trimmed.match(/^<zc_packet version="1">([\s\S]*)<\/zc_packet>$/u);
  if (!rootMatch) {
    return null;
  }
  const rootBody = rootMatch[1] ?? "";
  const modeMatch = rootBody.match(/<mode>(final|tool_request|ask_user|fail)<\/mode>/u);
  if (!modeMatch?.[1]) {
    return null;
  }
  const mode = modeMatch[1] as "final" | "tool_request" | "ask_user" | "fail";
  const remainder = rootBody.replace(modeMatch[0], "");
  if (mode === "tool_request") {
    const parsedToolCall = parseLooseToolCall(remainder);
    if (!parsedToolCall) {
      return null;
    }
    return createToolRequestPacket(parsedToolCall);
  }
  const messageMatch = remainder.match(/<message>([\s\S]*?)<\/message>/u);
  if (!messageMatch) {
    return null;
  }
  return createMessagePacket(mode, parseLenientCanonicalMessage(messageMatch[1] ?? ""));
}
function parseLenientCanonicalMessage(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("<![CDATA[")) {
    const cdataEnd = trimmed.indexOf("]]>");
    if (cdataEnd >= 0) {
      return trimmed.slice("<![CDATA[".length, cdataEnd).trim();
    }
  }
  return trimmed;
}
function wrapLooseZcPacketAsCanonicalPacket(content: string) {
  const trimmed = content.trim();
  const match = trimmed.match(/^<zc_packet\b([^>]*)>([\s\S]*)<\/zc_packet>$/u);
  if (!match) {
    return null;
  }
  const attributes = match[1] ?? "";
  if (/\bversion="1"/u.test(attributes)) {
    return null;
  }
  const modeMatch = attributes.match(/\bmode="(final|tool_request|ask_user|fail)"/u);
  if (!modeMatch) {
    return null;
  }
  const mode = modeMatch[1] as "final" | "tool_request" | "ask_user" | "fail";
  const body = (match[2] ?? "").trim();
  if (!body) {
    return null;
  }
  if (mode === "tool_request") {
    return wrapBareToolCallAsCanonicalPacket(body);
  }
  const message = parseLooseMessageBody(body);
  return message ? createMessagePacket(mode, message) : null;
}
function wrapBareToolCallAsCanonicalPacket(content: string) {
  const trimmed = repairMalformedBareToolCall(content.trim());
  if (!trimmed || !/^<tool_call\b[\s\S]*<\/tool_call>$/u.test(trimmed)) {
    const parsedToolCall = parseLooseToolCall(content);
    return parsedToolCall ? createToolRequestPacket(parsedToolCall) : null;
  }
  return `<zc_packet version="1"><mode>tool_request</mode>${trimmed}</zc_packet>`;
}
function repairMalformedBareToolCall(trimmed: string) {
  if (/^<tool_call\b[\s\S]*<\/tool_call>$/u.test(trimmed)) {
    return trimmed;
  }
  if (/^<tool_call\b[\s\S]*<tool_call>\s*$/u.test(trimmed) && !trimmed.includes("</tool_call>")) {
    return trimmed.replace(/<tool_call>\s*$/u, "</tool_call>");
  }
  return null;
}
function parseLooseToolCall(content: string) {
  const toolMatch = content.match(/<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/u);
  if (!toolMatch) {
    return null;
  }
  const attributes = parseLooseXmlAttributes(toolMatch[1] ?? "");
  const rawBody = (toolMatch[2] ?? "").trim();
  const parsedJsonArguments = parseLooseToolArguments(rawBody);
  const parsedTaggedToolCall = parseTaggedToolCallBody(rawBody);
  const name = (attributes.name ?? "").trim() || parsedTaggedToolCall?.name || "";
  const id = (attributes.id ?? "").trim() || "call_1";
  const args = parsedJsonArguments ?? parsedTaggedToolCall?.args;
  if (!name || !args) {
    return null;
  }
  return {
    id,
    name,
    args
  };
}
function parseLooseXmlAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/\b([A-Za-z_][\w:.-]*)=(?:"([^"]*)"|'([^']*)')/g)) {
    const key = match[1]?.trim();
    if (!key) {
      continue;
    }
    attributes[key] = decodeXmlEntityValue((match[2] ?? match[3] ?? "").trim());
  }
  return attributes;
}
function parseLooseToolArguments(raw: string) {
  const stripped = stripCodeFence(raw.trim());
  if (!stripped) {
    return null;
  }
  try {
    const parsed = JSON.parse(stripped);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function parseTaggedToolCallBody(raw: string) {
  const functionMatch = raw.match(
    /<function=(?:"([^"]+)"|'([^']+)'|([^>\s]+))>([\s\S]*?)<\/function>/u
  );
  const functionName = decodeXmlEntityValue(
    (functionMatch?.[1] ?? functionMatch?.[2] ?? functionMatch?.[3] ?? "").trim()
  );
  const functionBody = (functionMatch?.[4] ?? "").trim();
  if (!functionName || !functionBody) {
    return null;
  }
  const args: Record<string, unknown> = {};
  for (const match of functionBody.matchAll(
    /<parameter=(?:"([^"]+)"|'([^']+)'|([^>\s]+))>([\s\S]*?)<\/parameter>/g
  )) {
    const key = decodeXmlEntityValue((match[1] ?? match[2] ?? match[3] ?? "").trim());
    if (!key) {
      continue;
    }
    const value = parseLooseParameterValue(match[4] ?? "");
    if (value === undefined) {
      continue;
    }
    args[key] = value;
  }
  return Object.keys(args).length > 0
    ? {
        name: functionName,
        args
      }
    : null;
}
function parseLooseParameterValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const parsedJson = parseLooseToolArguments(trimmed);
  if (parsedJson) {
    return parsedJson;
  }
  return decodeXmlEntityValue(trimmed);
}
function stripCodeFence(raw: string) {
  const fencedMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  return fencedMatch?.[1]?.trim() ?? raw;
}
function decodeXmlEntityValue(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
function wrapBareFinalLikeMessageAsCanonicalPacket(content: string) {
  const trimmed = content.trim();
  const match = trimmed.match(/^<(final|ask_user|fail)>([\s\S]*)<\/\1>$/u);
  if (!match) {
    return null;
  }
  const mode = match[1] as "final" | "ask_user" | "fail";
  const message = parseLooseMessageBody(match[2] ?? "");
  return message ? createMessagePacket(mode, message) : null;
}
function parseLooseMessageBody(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    return trimmed.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  if (trimmed.includes("<")) {
    return null;
  }
  return trimmed;
}
function wrapVisibleTextAsFinalPacket(content: string) {
  const sanitized = sanitizeBridgeApiOutput(content);
  if (sanitized.sanitized || !sanitized.content.trim()) {
    return null;
  }
  return createMessagePacket("final", sanitized.content);
}
function normalizeExtractedProviderPacket(providerId: string, content: string) {
  const extracted = extractPacketCandidate(content);
  if (!extracted.ok) {
    return null;
  }
  const normalized = normalizeProviderPacket(providerId, extracted.packetText);
  return normalized.ok ? normalized.canonicalPacket : null;
}
function validateJsonSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string
): string | null {
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    !schema.enum.some((candidate) => Object.is(candidate, value))
  ) {
    return `${path} must be one of the allowed enum values.`;
  }
  if ("const" in schema && !Object.is(schema.const, value)) {
    return `${path} must match the required constant value.`;
  }
  const schemaType = typeof schema.type === "string" ? schema.type : null;
  if (!schemaType) {
    return null;
  }
  switch (schemaType) {
    case "object": {
      if (!isRecord(value)) {
        return `${path} must be an object.`;
      }
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0
          )
        : [];
      const additionalProperties = schema.additionalProperties;
      for (const key of required) {
        if (!(key in value)) {
          return `${path}.${key} is required.`;
        }
      }
      for (const [key, childValue] of Object.entries(value)) {
        const childSchema = properties[key];
        if (isRecord(childSchema)) {
          const childError = validateJsonSchemaValue(childValue, childSchema, `${path}.${key}`);
          if (childError) {
            return childError;
          }
          continue;
        }
        if (additionalProperties === false) {
          return `${path}.${key} is not allowed.`;
        }
        if (isRecord(additionalProperties)) {
          const childError = validateJsonSchemaValue(
            childValue,
            additionalProperties,
            `${path}.${key}`
          );
          if (childError) {
            return childError;
          }
        }
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) {
        return `${path} must be an array.`;
      }
      if (isRecord(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          const childError = validateJsonSchemaValue(
            value[index],
            schema.items,
            `${path}[${index}]`
          );
          if (childError) {
            return childError;
          }
        }
      }
      return null;
    }
    case "string":
      return typeof value === "string" ? null : `${path} must be a string.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean.`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : `${path} must be a number.`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : `${path} must be an integer.`;
    case "null":
      return value === null ? null : `${path} must be null.`;
    default:
      return null;
  }
}
function optionalTrimmedString(value: unknown, key: string) {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: `${key} must be a string.`
    });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: `${key} must be a non-empty string.`
    });
  }
  return trimmed;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value: unknown) {
  return isRecord(value) ? value : {};
}
function summarizeRuntimeEvent(event: Record<string, unknown>) {
  const type = typeof event.type === "string" ? event.type : "unknown";
  switch (type) {
    case "provider_response":
      return {
        type,
        step: event.step,
        durationMs: event.durationMs,
        rawTextLength: typeof event.rawText === "string" ? event.rawText.length : 0
      };
    case "packet_parsed":
      return {
        type,
        step: event.step,
        mode: event.mode
      };
    case "packet_parse_failed":
      return {
        type,
        step: event.step,
        error: event.error
      };
    case "main_response_invalid":
      return {
        type,
        step: event.step,
        error: event.error,
        rawTextLength: event.rawTextLength
      };
    case "repair_attempted":
      return {
        type,
        step: event.step
      };
    case "repair_valid":
      return {
        type,
        step: event.step,
        mode: event.mode,
        rawTextLength: event.rawTextLength
      };
    case "repair_failed":
      return {
        type,
        step: event.step,
        reason: event.reason,
        error: event.error,
        providerFailure: event.providerFailure
      };
    case "outcome": {
      const outcome = asRecord(event.outcome);
      const failure = asRecord(outcome.failure);
      return {
        type,
        outcome: {
          mode: outcome.mode,
          steps: outcome.steps,
          failureSource: failure.source
        }
      };
    }
    default:
      return event;
  }
}
function createInitialRepairRecoverySummary(): RepairRecoverySummary {
  return {
    attempted: false,
    attemptCount: 0,
    outcome: "not_needed",
    invalidCount: 0
  };
}
function updateRepairRecoverySummary(
  summary: RepairRecoverySummary,
  event: Record<string, unknown>
) {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "main_response_invalid":
      summary.invalidCount += 1;
      break;
    case "repair_attempted":
      summary.attempted = true;
      summary.attemptCount = 1;
      if (summary.outcome === "not_needed") {
        summary.outcome = "failed";
      }
      break;
    case "repair_valid":
      summary.attempted = true;
      summary.attemptCount = 1;
      summary.outcome = "valid";
      delete summary.failureReason;
      break;
    case "repair_failed":
      summary.attempted = true;
      summary.attemptCount = 1;
      summary.outcome = "failed";
      if (event.reason === "provider_failure" || event.reason === "protocol_invalid") {
        summary.failureReason = event.reason;
      }
      break;
    default:
      break;
  }
}
function createInMemorySessionBindingStore(): SessionBindingStore {
  const bindings = new Map<string, Awaited<ReturnType<SessionBindingStore["loadBinding"]>>>();
  return {
    async loadBinding(providerId, sessionId) {
      return bindings.get(createBindingKey(providerId, sessionId)) ?? null;
    },
    async saveBinding(providerId, sessionId, binding) {
      bindings.set(createBindingKey(providerId, sessionId), structuredClone(binding));
    },
    async clearBinding(providerId, sessionId) {
      bindings.delete(createBindingKey(providerId, sessionId));
    }
  };
}
function createBindingKey(providerId: string, sessionId: string) {
  return `${providerId}:${sessionId}`;
}
function defaultLogEvent(event: BridgeRuntimeServiceLogEvent) {
  console.log(
    `[BridgeService][${event.scope}] ${event.event} ${JSON.stringify({ requestId: event.requestId, ...event.detail })}`
  );
}

export const bridgeRuntimeServiceModule = {
  createBridgeRuntimeService
};

export type {
  BridgeRuntimeService,
  BridgeRuntimeServiceDependencies,
  BridgeRuntimeServiceLogEvent
};
