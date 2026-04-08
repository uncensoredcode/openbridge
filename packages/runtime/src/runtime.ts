import type { AssistantResponse } from "./assistant-protocol.ts";
import { assistantProtocolModule } from "./assistant-protocol.ts";
import type { ExecutionRequest, ToolDefinition, ToolExecutor } from "./execution/types.ts";
import { packetExtractorModule } from "./packet-extractor.ts";
import { packetNormalizerModule } from "./packet-normalizer.ts";
import type { ToolResult, ZcPacket } from "./protocol.ts";
import { protocolModule } from "./protocol.ts";
import type {
  BridgeSessionTurn,
  ConversationState,
  ProviderAdapter,
  RepairInvalidResponseInput
} from "./provider.ts";
import { providerFailureModule } from "./provider-failure.ts";
import { toolNameAliasesModule } from "./tool-name-aliases.ts";

const { parseAssistantResponse, validateAssistantResponse } = assistantProtocolModule;
const { extractPacketCandidate } = packetExtractorModule;
const { normalizeProviderPacket } = packetNormalizerModule;
const { parseZcPacket, serializeToolResult } = protocolModule;
const { normalizeProviderToolName } = toolNameAliasesModule;
const {
  formatProviderFailureMessage,
  isProviderFailure,
  serializeProviderFailure,
  withProviderRecovery
} = providerFailureModule;
type RuntimeConfig = {
  maxSteps?: number;
  onEvent?: (event: RuntimeEvent) => void;
};
type RuntimeTerminalMode = "final" | "ask_user" | "fail";
type RuntimeOutcome = {
  mode: RuntimeTerminalMode;
  message: string;
  steps: number;
  conversation: ConversationState;
  failure?: RuntimeFailure;
};
type RuntimeFailure =
  | {
      source: "provider";
      provider: ReturnType<typeof serializeProviderFailure>;
    }
  | {
      source: "protocol";
      code: "malformed_provider_packet";
      message: string;
    }
  | {
      source: "runtime";
      code: "max_steps_exhausted";
      message: string;
    };
type RuntimeEvent =
  | {
      type: "provider_response";
      step: number;
      rawText: string;
      durationMs: number;
    }
  | {
      type: "main_response_invalid";
      step: number;
      error: string;
      rawTextLength: number;
    }
  | {
      type: "repair_attempted";
      step: number;
    }
  | {
      type: "repair_valid";
      step: number;
      mode: "final" | "tool" | "ask_user" | "fail";
      rawTextLength: number;
    }
  | {
      type: "repair_failed";
      step: number;
      reason: "provider_failure" | "protocol_invalid";
      error?: string;
      providerFailure?: {
        kind: ReturnType<typeof serializeProviderFailure>["kind"];
        code: ReturnType<typeof serializeProviderFailure>["code"];
        message: string;
      };
    }
  | {
      type: "tool_result";
      step: number;
      rawText: string;
      result: ToolResult;
      durationMs: number;
    }
  | {
      type: "packet_parsed";
      step: number;
      mode: "final" | "tool" | "ask_user" | "fail";
    }
  | {
      type: "packet_parse_failed";
      step: number;
      error: string;
    }
  | {
      type: "outcome";
      outcome: RuntimeOutcome;
    };
type RunRuntimeInput = {
  userMessage: string;
  sessionHistory?: BridgeSessionTurn[];
  provider: ProviderAdapter;
  toolExecutor: ToolExecutor;
  config?: RuntimeConfig;
};
const DEFAULT_MAX_STEPS = 8;
type ParsedProviderResponse = AssistantResponse | ZcPacket;
async function runBridgeRuntime(input: RunRuntimeInput): Promise<RuntimeOutcome> {
  const maxSteps = input.config?.maxSteps ?? DEFAULT_MAX_STEPS;
  const conversation: ConversationState = {
    sessionHistory: input.sessionHistory ?? [],
    entries: [
      {
        type: "user_message",
        content: input.userMessage
      }
    ]
  };
  const availableTools = await input.toolExecutor.getAvailableTools();
  for (let step = 1; step <= maxSteps; step += 1) {
    let rawText: string;
    const providerStartedAt = Date.now();
    try {
      rawText = await input.provider.completeTurn({
        conversation,
        availableTools
      });
    } catch (error) {
      if (isProviderFailure(error)) {
        const serialized = serializeProviderFailure(
          withProviderRecovery(error, error.recovery, {
            displayMessage: formatProviderFailureMessage(error)
          })
        );
        return emitOutcome(
          {
            mode: "fail",
            message: serialized.message,
            steps: step,
            conversation,
            failure: {
              source: "provider",
              provider: serialized
            }
          },
          input.config
        );
      }
      return emitOutcome(
        {
          mode: "fail",
          message: `Provider adapter failed: ${error instanceof Error ? error.message : String(error)}`,
          steps: step,
          conversation,
          failure: {
            source: "provider",
            provider: {
              kind: "permanent",
              code: "transport_error",
              message: `Provider adapter failed: ${error instanceof Error ? error.message : String(error)}`,
              retryable: false,
              sessionResetEligible: false,
              emptyOutput: false,
              recovery: {
                softRetryCount: 0,
                sessionResetCount: 0
              }
            }
          }
        },
        input.config
      );
    }
    input.config?.onEvent?.({
      type: "provider_response",
      step,
      rawText,
      durationMs: Date.now() - providerStartedAt
    });
    let response: ParsedProviderResponse;
    try {
      response = parseAndValidateProviderResponse(input.provider.id, rawText, availableTools);
    } catch (error) {
      const validationError = error instanceof Error ? error.message : String(error);
      input.config?.onEvent?.({
        type: "main_response_invalid",
        step,
        error: validationError,
        rawTextLength: rawText.length
      });
      input.config?.onEvent?.({
        type: "packet_parse_failed",
        step,
        error: validationError
      });
      input.config?.onEvent?.({
        type: "repair_attempted",
        step
      });
      const repaired = await attemptResponseRepair({
        provider: input.provider,
        conversation,
        availableTools,
        invalidResponse: rawText,
        validationError
      });
      if (!repaired.ok) {
        input.config?.onEvent?.({
          type: "repair_failed",
          step,
          reason: repaired.failure.source === "provider" ? "provider_failure" : "protocol_invalid",
          error: repaired.failure.source === "protocol" ? repaired.failure.message : undefined,
          providerFailure:
            repaired.failure.source === "provider"
              ? {
                  kind: repaired.failure.provider.kind,
                  code: repaired.failure.provider.code,
                  message: repaired.failure.provider.message
                }
              : undefined
        });
        if (repaired.failure.source === "provider") {
          return emitOutcome(
            {
              mode: "fail",
              message: repaired.failure.provider.message,
              steps: step,
              conversation,
              failure: repaired.failure
            },
            input.config
          );
        }
        return emitOutcome(
          {
            mode: "fail",
            message: repaired.failure.message,
            steps: step,
            conversation,
            failure: repaired.failure
          },
          input.config
        );
      }
      rawText = repaired.rawText;
      try {
        response = parseAndValidateProviderResponse(input.provider.id, rawText, availableTools);
      } catch (repairError) {
        const repairValidationError =
          repairError instanceof Error ? repairError.message : String(repairError);
        input.config?.onEvent?.({
          type: "packet_parse_failed",
          step,
          error: repairValidationError
        });
        input.config?.onEvent?.({
          type: "repair_failed",
          step,
          reason: "protocol_invalid",
          error: `Invalid assistant response: ${repairValidationError}`
        });
        return emitOutcome(
          {
            mode: "fail",
            message: `Invalid assistant response: ${repairValidationError}`,
            steps: step,
            conversation,
            failure: {
              source: "protocol",
              code: "malformed_provider_packet",
              message: `Invalid assistant response: ${repairValidationError}`
            }
          },
          input.config
        );
      }
      input.config?.onEvent?.({
        type: "repair_valid",
        step,
        mode: getParsedResponseMode(response),
        rawTextLength: rawText.length
      });
    }
    input.config?.onEvent?.({
      type: "packet_parsed",
      step,
      mode: getParsedResponseMode(response)
    });
    conversation.entries.push({
      type: "provider_packet",
      rawText,
      packet: response
    });
    if (isAssistantToolResponse(response) || isZcToolRequest(response)) {
      const toolCall = isZcToolRequest(response)
        ? {
            id: response.toolCall.id,
            name: response.toolCall.name,
            args: response.toolCall.args
          }
        : {
            id: `call_${step}`,
            name: response.toolCall.name,
            args: response.toolCall.arguments
          };
      const toolStartedAt = Date.now();
      const execution = await input.toolExecutor.executeTool({
        call: toolCall
      } satisfies ExecutionRequest);
      const toolResult: ToolResult = {
        id: toolCall.id,
        name: toolCall.name,
        ok: execution.ok,
        payload: execution.payload
      };
      const serializedToolResult = serializeToolResult(toolResult);
      conversation.entries.push({
        type: "tool_result",
        rawText: serializedToolResult,
        result: toolResult
      });
      input.config?.onEvent?.({
        type: "tool_result",
        step,
        rawText: serializedToolResult,
        result: toolResult,
        durationMs: Date.now() - toolStartedAt
      });
      continue;
    }
    switch (getParsedResponseMode(response)) {
      case "final":
        return emitOutcome(
          {
            mode: "final",
            message: extractParsedResponseMessage(response),
            steps: step,
            conversation
          },
          input.config
        );
      case "ask_user":
        return emitOutcome(
          {
            mode: "ask_user",
            message: extractParsedResponseMessage(response),
            steps: step,
            conversation
          },
          input.config
        );
      case "fail":
        return emitOutcome(
          {
            mode: "fail",
            message: extractParsedResponseMessage(response),
            steps: step,
            conversation
          },
          input.config
        );
    }
  }
  return emitOutcome(
    {
      mode: "fail",
      message: `Runtime exceeded max steps (${maxSteps}).`,
      steps: maxSteps,
      conversation,
      failure: {
        source: "runtime",
        code: "max_steps_exhausted",
        message: `Runtime exceeded max steps (${maxSteps}).`
      }
    },
    input.config
  );
}
function repairLeadingAssistantBlock(content: string) {
  const trimmed = content.trim();
  const recovered = recoverLatestFinalBlock(trimmed);
  if (recovered) {
    return recovered;
  }
  return trimmed;
}
function recoverLatestFinalBlock(content: string) {
  return recoverLatestTaggedBlock(content, "final")?.block ?? null;
}
function recoverLatestTaggedBlock(content: string, tag: "final" | "tool") {
  const closeTag = `</${tag}>`;
  const closeIndex = content.lastIndexOf(closeTag);
  if (closeIndex < 0) {
    return null;
  }
  const marker = new RegExp(`(?:<)?${tag}>`, "gi");
  let latestMatch: {
    index: number;
    markerLength: number;
  } | null = null;
  for (const match of content.matchAll(marker)) {
    const index = match.index ?? -1;
    if (index < 0 || index >= closeIndex) {
      continue;
    }
    latestMatch = {
      index,
      markerLength: match[0].length
    };
  }
  if (!latestMatch) {
    return null;
  }
  const innerContent = content.slice(latestMatch.index + latestMatch.markerLength, closeIndex);
  return {
    index: latestMatch.index,
    block: `<${tag}>${innerContent}${closeTag}`
  };
}
function parseAndValidateProviderResponse(
  providerId: string,
  rawText: string,
  availableTools: ToolDefinition[]
): ParsedProviderResponse {
  const normalizedAssistantResponse = repairLeadingAssistantBlock(rawText);
  try {
    return validateAssistantResponse(
      normalizeAssistantToolNames(parseAssistantResponse(normalizedAssistantResponse)),
      availableTools
    );
  } catch (assistantError) {
    const extraction = extractPacketCandidate(rawText);
    if (!extraction.ok) {
      throw assistantError;
    }
    const normalization = normalizeProviderPacket(providerId, extraction.packetText);
    if (!normalization.ok) {
      throw assistantError;
    }
    const packet = normalizeZcPacketToolNames(parseZcPacket(normalization.canonicalPacket));
    validateZcPacketResponse(packet, availableTools);
    return packet;
  }
}
function normalizeAssistantToolNames(response: AssistantResponse): AssistantResponse {
  if (response.type !== "tool") {
    return response;
  }
  return {
    ...response,
    toolCall: {
      ...response.toolCall,
      name: normalizeProviderToolName(response.toolCall.name)
    }
  };
}
function normalizeZcPacketToolNames(packet: ZcPacket): ZcPacket {
  if (packet.mode !== "tool_request") {
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
function validateZcPacketResponse(packet: ZcPacket, availableTools: ToolDefinition[]) {
  if (packet.mode !== "tool_request") {
    return;
  }
  const tool = availableTools.find((candidate) => candidate.name === packet.toolCall.name);
  if (!tool) {
    return;
  }
  const argumentsRecord = packet.toolCall.args;
  const propertyNames = Object.keys(tool.inputSchema.properties);
  const allowedProperties = new Set(propertyNames);
  for (const name of Object.keys(argumentsRecord)) {
    if (!allowedProperties.has(name)) {
      throw new Error(`Tool "${tool.name}" received unknown argument "${name}".`);
    }
  }
  for (const requiredName of tool.inputSchema.required) {
    if (!(requiredName in argumentsRecord)) {
      throw new Error(`Tool "${tool.name}" is missing required argument "${requiredName}".`);
    }
  }
  for (const propertyName of propertyNames) {
    if (!(propertyName in argumentsRecord)) {
      continue;
    }
    const property = tool.inputSchema.properties[propertyName];
    const value = argumentsRecord[propertyName];
    if (property.type === "string" && typeof value !== "string") {
      throw new Error(`Tool "${tool.name}" argument "${propertyName}" must be a string.`);
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`Tool "${tool.name}" argument "${propertyName}" must be a boolean.`);
    }
  }
}
function isAssistantToolResponse(response: ParsedProviderResponse): response is Extract<
  AssistantResponse,
  {
    type: "tool";
  }
> {
  return "type" in response && response.type === "tool";
}
function isAssistantFinalResponse(response: ParsedProviderResponse): response is Extract<
  AssistantResponse,
  {
    type: "final";
  }
> {
  return "type" in response && response.type === "final";
}
function isZcToolRequest(response: ParsedProviderResponse): response is Extract<
  ZcPacket,
  {
    mode: "tool_request";
  }
> {
  return "mode" in response && response.mode === "tool_request";
}
function getParsedResponseMode(response: ParsedProviderResponse) {
  if ("type" in response) {
    return response.type;
  }
  return response.mode === "tool_request" ? "tool" : response.mode;
}
function extractParsedResponseMessage(response: ParsedProviderResponse) {
  if (isAssistantFinalResponse(response)) {
    return response.message;
  }
  if (isAssistantToolResponse(response) || isZcToolRequest(response)) {
    throw new Error("tool_request packets do not carry assistant text.");
  }
  return response.message;
}
function emitOutcome(outcome: RuntimeOutcome, config: RuntimeConfig | undefined) {
  config?.onEvent?.({
    type: "outcome",
    outcome
  });
  return outcome;
}
async function attemptResponseRepair(input: {
  provider: ProviderAdapter;
  conversation: ConversationState;
  availableTools: RepairInvalidResponseInput["availableTools"];
  invalidResponse: string;
  validationError: string;
}): Promise<
  | {
      ok: true;
      rawText: string;
    }
  | {
      ok: false;
      failure: RuntimeFailure;
    }
> {
  if (typeof input.provider.repairInvalidResponse !== "function") {
    return {
      ok: false,
      failure: {
        source: "protocol",
        code: "malformed_provider_packet",
        message: `Invalid assistant response: ${input.validationError}`
      }
    };
  }
  try {
    const rawText = await input.provider.repairInvalidResponse({
      conversation: input.conversation,
      availableTools: input.availableTools,
      invalidResponse: input.invalidResponse,
      validationError: input.validationError
    });
    return {
      ok: true,
      rawText
    };
  } catch (error) {
    if (isProviderFailure(error)) {
      const serialized = serializeProviderFailure(
        withProviderRecovery(error, error.recovery, {
          displayMessage: formatProviderFailureMessage(error)
        })
      );
      return {
        ok: false,
        failure: {
          source: "provider",
          provider: serialized
        }
      };
    }
    return {
      ok: false,
      failure: {
        source: "provider",
        provider: {
          kind: "permanent",
          code: "transport_error",
          message: `Provider repair adapter failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          sessionResetEligible: false,
          emptyOutput: false,
          recovery: {
            softRetryCount: 0,
            sessionResetCount: 0
          }
        }
      }
    };
  }
}

export const runtimeModule = {
  runBridgeRuntime
};

export type {
  RunRuntimeInput,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeOutcome,
  RuntimeTerminalMode
};
