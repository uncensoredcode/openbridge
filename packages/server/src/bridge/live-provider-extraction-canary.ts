import crypto from "node:crypto";

import type { ProviderFailureCode } from "@uncensoredcode/openbridge/runtime";
import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";

import type { BridgeServerConfig } from "../config/index.ts";
import { webProviderTransportModule } from "./providers/web-provider-transport.ts";
import { fileBridgeStateStoreModule } from "./state/file-bridge-state-store.ts";

const { classifyProviderTransportError, formatProviderFailureMessage } = bridgeRuntime;
const { collectProviderTransportCompletion } = webProviderTransportModule;
const { FileBridgeStateStore } = fileBridgeStateStoreModule;
const DEFAULT_LIVE_CANARY_PROMPT = "Reply with exactly OK.";
const DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING = "OK";
type LiveProviderCanaryCompletion = {
  providerId: string;
  modelId: string;
  prompt: string;
  conversationId: string;
  completion: {
    content: string;
    responseId: string;
    eventCount: number;
    fragmentCount: number;
  };
  upstreamBinding: Pick<
    NonNullable<
      import("@uncensoredcode/openbridge/runtime").ProviderTransportRequest["upstreamBinding"]
    >,
    "conversationId" | "parentId"
  > | null;
};
type LiveProviderCanaryCompletionCollector = (
  stateStore: InstanceType<typeof FileBridgeStateStore>,
  request: import("@uncensoredcode/openbridge/runtime").ProviderTransportRequest
) => Promise<LiveProviderCanaryCompletion>;
type LiveProviderExtractionCanaryInput = {
  config: BridgeServerConfig;
  providerId?: string;
  modelId?: string;
  prompt?: string;
  expectedSubstring?: string;
  stateRoot?: string;
  now?: () => number;
  requestId?: string;
  collectCompletion?: LiveProviderCanaryCompletionCollector;
};
type LiveProviderExtractionCanaryResult =
  | {
      ok: true;
      classification: "success";
      providerId: string;
      modelId: string;
      requestId: string;
      durationMs: number;
      prompt: string;
      expectedSubstring: string;
      expectedSubstringMatched: boolean;
      conversationId: string;
      responseId: string;
      streamEventCount: number;
      fragmentCount: number;
      output: string;
    }
  | {
      ok: false;
      classification: "empty_extraction" | "empty_output" | "provider_failure";
      providerId: string;
      modelId: string;
      requestId: string;
      durationMs: number;
      prompt: string;
      conversationId?: string;
      responseId?: string;
      streamEventCount?: number;
      fragmentCount?: number;
      output?: string;
      failureCode?: ProviderFailureCode;
      failureKind?: string;
      message: string;
    };
async function runLiveProviderExtractionCanary(
  input: LiveProviderExtractionCanaryInput
): Promise<LiveProviderExtractionCanaryResult> {
  const providerId = resolveProviderId(input.providerId, input.config.defaultProvider);
  const modelId = resolveModelId(input.modelId, input.config.defaultModel, providerId);
  const prompt = readPrompt(input.prompt);
  const expectedSubstring = readExpectedSubstring(input.expectedSubstring);
  const requestId = input.requestId ?? `live-canary:${crypto.randomUUID()}`;
  const startedAt = (input.now ?? Date.now)();
  const stateStore = new FileBridgeStateStore(input.stateRoot ?? input.config.stateRoot);
  const collectCompletion = input.collectCompletion ?? collectProviderTransportCompletion;
  try {
    const result = await collectCompletion(stateStore, {
      lane: "main",
      providerId,
      modelId,
      sessionId: `live-canary:${providerId}`,
      requestId,
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      upstreamBinding: null
    });
    const durationMs = (input.now ?? Date.now)() - startedAt;
    const output = result.completion.content.trim();
    if (result.completion.fragmentCount === 0 && result.completion.eventCount > 0) {
      return {
        ok: false,
        classification: "empty_extraction",
        providerId,
        modelId,
        requestId,
        durationMs,
        prompt,
        conversationId: result.conversationId,
        responseId: result.completion.responseId,
        streamEventCount: result.completion.eventCount,
        fragmentCount: result.completion.fragmentCount,
        output,
        message: `Live provider returned no extractable assistant fragments. Possible parser drift in ${providerId} stream extraction.`
      };
    }
    if (!output) {
      return {
        ok: false,
        classification: "empty_output",
        providerId,
        modelId,
        requestId,
        durationMs,
        prompt,
        conversationId: result.conversationId,
        responseId: result.completion.responseId,
        streamEventCount: result.completion.eventCount,
        fragmentCount: result.completion.fragmentCount,
        output,
        message:
          result.completion.eventCount > 0
            ? "SSE stream connected, but final extracted assistant output was empty."
            : "Live provider stream ended without any assistant output."
      };
    }
    return {
      ok: true,
      classification: "success",
      providerId,
      modelId,
      requestId,
      durationMs,
      prompt,
      expectedSubstring,
      expectedSubstringMatched: output.toLowerCase().includes(expectedSubstring.toLowerCase()),
      conversationId: result.conversationId,
      responseId: result.completion.responseId,
      streamEventCount: result.completion.eventCount,
      fragmentCount: result.completion.fragmentCount,
      output
    };
  } catch (error) {
    const failure = classifyProviderTransportError(error);
    return {
      ok: false,
      classification: "provider_failure",
      providerId,
      modelId,
      requestId,
      durationMs: (input.now ?? Date.now)() - startedAt,
      prompt,
      failureCode: failure.code,
      failureKind: failure.kind,
      message: formatProviderFailureMessage(failure)
    };
  }
}
function formatLiveProviderExtractionCanaryResult(result: LiveProviderExtractionCanaryResult) {
  const lines = [
    result.ok ? "status=ok" : "status=fail",
    `classification=${result.classification}`,
    `provider=${result.providerId}`,
    `model=${result.modelId}`,
    `request_id=${result.requestId}`,
    `duration_ms=${result.durationMs}`,
    `prompt=${JSON.stringify(result.prompt)}`
  ];
  if ("conversationId" in result && result.conversationId) {
    lines.push(`conversation_id=${result.conversationId}`);
  }
  if ("responseId" in result && result.responseId) {
    lines.push(`response_id=${result.responseId}`);
  }
  if ("streamEventCount" in result && typeof result.streamEventCount === "number") {
    lines.push(`stream_event_count=${result.streamEventCount}`);
  }
  if ("fragmentCount" in result && typeof result.fragmentCount === "number") {
    lines.push(`fragment_count=${result.fragmentCount}`);
  }
  if (result.ok) {
    lines.push(`output=${JSON.stringify(result.output)}`);
    lines.push(`output_length=${result.output.length}`);
    lines.push(`expected_substring=${JSON.stringify(result.expectedSubstring)}`);
    lines.push(`expected_substring_matched=${String(result.expectedSubstringMatched)}`);
    if (!result.expectedSubstringMatched) {
      lines.push(
        "note=Live extraction succeeded, but the final output did not contain the expected substring."
      );
    }
    return lines.join("\n");
  }
  if (result.output !== undefined) {
    lines.push(`output=${JSON.stringify(result.output)}`);
  }
  if (result.failureKind) {
    lines.push(`failure_kind=${result.failureKind}`);
  }
  if (result.failureCode) {
    lines.push(`failure_code=${result.failureCode}`);
  }
  lines.push(`message=${result.message}`);
  return lines.join("\n");
}
function resolveProviderId(explicitProviderId: string | undefined, defaultProvider: string | null) {
  const providerId = explicitProviderId?.trim() || defaultProvider;
  if (!providerId) {
    throw new Error(
      "provider is required for live-canary. Pass --provider or set BRIDGE_PROVIDER."
    );
  }
  return providerId;
}
function resolveModelId(
  explicitModelId: string | undefined,
  defaultModel: string | null,
  providerId: string
) {
  const modelId = explicitModelId?.trim() || defaultModel;
  if (!modelId) {
    throw new Error(
      `model is required for live-canary. Pass --model or configure BRIDGE_MODEL for ${providerId}.`
    );
  }
  return modelId;
}
function readPrompt(value: string | undefined) {
  const prompt = value?.trim() || DEFAULT_LIVE_CANARY_PROMPT;
  if (!prompt) {
    throw new Error("prompt must be a non-empty string.");
  }
  return prompt;
}
function readExpectedSubstring(value: string | undefined) {
  const expectedSubstring = value?.trim() || DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING;
  if (!expectedSubstring) {
    throw new Error("expected substring must be a non-empty string.");
  }
  return expectedSubstring;
}

export const liveProviderExtractionCanaryModule = {
  DEFAULT_LIVE_CANARY_PROMPT,
  DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING,
  runLiveProviderExtractionCanary,
  formatLiveProviderExtractionCanaryResult
};

export type { LiveProviderExtractionCanaryInput, LiveProviderExtractionCanaryResult };
