import type {
  BridgeApiErrorResponse,
  BridgeChatCompletionRequest,
  BridgeChatCompletionResponse,
  BridgeHealthResponse,
  BridgeMessageRequest,
  BridgeMessageResponse
} from "../shared/api-schema.ts";

const DEFAULT_BRIDGE_API_BASE_URL = "http://127.0.0.1:4318";
class BridgeApiHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(input: {
    statusCode: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "BridgeApiHttpError";
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.details = input.details;
  }
}
class BridgeApiConnectionError extends Error {
  readonly baseUrl: string;
  constructor(input: { baseUrl: string; cause?: unknown }) {
    const suffix = formatCauseMessage(input.cause);
    super(`Failed to reach bridge server at ${input.baseUrl}.${suffix ? ` ${suffix}` : ""}`);
    this.name = "BridgeApiConnectionError";
    this.baseUrl = input.baseUrl;
    this.cause = input.cause;
  }
}
type BridgeApiClientFetch = typeof fetch;
type SendBridgeMessageInput = Omit<BridgeMessageRequest, "sessionId"> & {
  baseUrl: string;
  sessionId: string;
  fetchImpl?: BridgeApiClientFetch;
  signal?: AbortSignal;
};
type CreateBridgeChatCompletionInput = Omit<BridgeChatCompletionRequest, "stream"> & {
  baseUrl: string;
  fetchImpl?: BridgeApiClientFetch;
  signal?: AbortSignal;
};
type StreamBridgeChatCompletionInput = Omit<BridgeChatCompletionRequest, "stream"> & {
  baseUrl: string;
  fetchImpl?: BridgeApiClientFetch;
  signal?: AbortSignal;
};
type CheckBridgeHealthInput = {
  baseUrl: string;
  fetchImpl?: BridgeApiClientFetch;
  signal?: AbortSignal;
};
async function sendBridgeMessage(input: SendBridgeMessageInput): Promise<BridgeMessageResponse> {
  const response = await (input.fetchImpl ?? fetch)(
    buildSessionMessageUrl(input.baseUrl, input.sessionId),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: input.input,
        message: input.message,
        provider: input.provider,
        model: input.model,
        metadata: input.metadata,
        toolProfile: input.toolProfile
      } satisfies BridgeMessageRequest),
      signal: input.signal
    }
  );
  if (!response.ok) {
    throw await readBridgeApiError(response);
  }
  return response.json() as Promise<BridgeMessageResponse>;
}
async function checkBridgeHealth(input: CheckBridgeHealthInput): Promise<BridgeHealthResponse> {
  const response = await (input.fetchImpl ?? fetch)(buildHealthUrl(input.baseUrl), {
    method: "GET",
    signal: input.signal
  });
  if (!response.ok) {
    throw await readBridgeApiError(response);
  }
  return response.json() as Promise<BridgeHealthResponse>;
}
async function createBridgeChatCompletion(
  input: CreateBridgeChatCompletionInput
): Promise<BridgeChatCompletionResponse> {
  const response = await fetchBridgeApi(
    input.baseUrl,
    input.fetchImpl,
    buildChatCompletionsUrl(input.baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        metadata: input.metadata
      } satisfies BridgeChatCompletionRequest),
      signal: input.signal
    }
  );
  if (!response.ok) {
    throw await readBridgeApiError(response);
  }
  return response.json() as Promise<BridgeChatCompletionResponse>;
}
async function streamBridgeChatCompletion(
  input: StreamBridgeChatCompletionInput
): Promise<AsyncIterable<string>> {
  const response = await fetchBridgeApi(
    input.baseUrl,
    input.fetchImpl,
    buildChatCompletionsUrl(input.baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        stream: true,
        metadata: input.metadata
      } satisfies BridgeChatCompletionRequest),
      signal: input.signal
    }
  );
  if (!response.ok) {
    throw await readBridgeApiError(response);
  }
  return readChatCompletionStream(response);
}
function buildSessionMessageUrl(baseUrl: string, sessionId: string) {
  return new URL(
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
    ensureBaseUrl(baseUrl)
  ).toString();
}
function buildHealthUrl(baseUrl: string) {
  return new URL("/health", ensureBaseUrl(baseUrl)).toString();
}
function buildChatCompletionsUrl(baseUrl: string) {
  return new URL("/v1/chat/completions", ensureBaseUrl(baseUrl)).toString();
}
async function readBridgeApiError(response: Response) {
  let payload: BridgeApiErrorResponse | null = null;
  try {
    payload = (await response.json()) as BridgeApiErrorResponse;
  } catch {
    payload = null;
  }
  return new BridgeApiHttpError({
    statusCode: response.status,
    code: payload?.error.code ?? "http_error",
    message: payload?.error.message ?? `Bridge API request failed with status ${response.status}.`,
    details: payload?.error.details
  });
}
function ensureBaseUrl(value: string) {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}
async function fetchBridgeApi(
  baseUrl: string,
  fetchImpl: BridgeApiClientFetch | undefined,
  url: string,
  init: RequestInit
) {
  try {
    return await (fetchImpl ?? fetch)(url, init);
  } catch (error) {
    throw new BridgeApiConnectionError({
      baseUrl,
      cause: error
    });
  }
}
async function* readChatCompletionStream(response: Response): AsyncGenerator<string> {
  const stream = response.body;
  if (!stream) {
    throw new Error("Bridge chat stream did not include a response body.");
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, {
        stream: true
      });
      for (const line of consumeSseLines(
        () => buffer,
        (value) => {
          buffer = value;
        }
      )) {
        const data = readSseDataLine(line);
        if (data === null) {
          continue;
        }
        if (data === "[DONE]") {
          sawDone = true;
          return;
        }
        const chunk = parseChatCompletionChunk(data);
        const content = chunk.choices[0]?.delta?.content;
        if (typeof content === "string" && content.length > 0) {
          yield content;
        }
      }
    }
    buffer += decoder.decode();
    for (const line of consumeSseLines(
      () => buffer,
      (value) => {
        buffer = value;
      }
    )) {
      const data = readSseDataLine(line);
      if (data === null) {
        continue;
      }
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }
      const chunk = parseChatCompletionChunk(data);
      const content = chunk.choices[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) {
        yield content;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim().length > 0) {
    throw new Error("Bridge chat stream ended with an incomplete SSE frame.");
  }
  if (!sawDone) {
    throw new Error("Bridge chat stream ended before [DONE].");
  }
}
function* consumeSseLines(readBuffer: () => string, writeBuffer: (value: string) => void) {
  while (true) {
    const buffer = readBuffer();
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex < 0) {
      return;
    }
    const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
    writeBuffer(buffer.slice(newlineIndex + 1));
    yield line;
  }
}
function readSseDataLine(line: string) {
  if (!line.startsWith("data:")) {
    return null;
  }
  const value = line.slice(5).trimStart();
  return value.length > 0 ? value : null;
}
function parseChatCompletionChunk(data: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("Bridge chat stream contained invalid JSON.");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Bridge chat stream contained a malformed chunk.");
  }
  const chunk = payload as {
    object?: unknown;
    choices?: Array<{
      delta?: {
        content?: unknown;
        role?: unknown;
      };
      finish_reason?: unknown;
    }>;
  };
  const choices = chunk.choices;
  if (chunk.object !== "chat.completion.chunk" || !Array.isArray(choices) || choices.length === 0) {
    throw new Error("Bridge chat stream contained a malformed chunk.");
  }
  const choice = choices[0];
  if (!choice || typeof choice !== "object") {
    throw new Error("Bridge chat stream contained a malformed chunk.");
  }
  if (
    choice.delta !== undefined &&
    (typeof choice.delta !== "object" || choice.delta === null || Array.isArray(choice.delta))
  ) {
    throw new Error("Bridge chat stream contained a malformed chunk.");
  }
  if (
    choice.delta &&
    "content" in choice.delta &&
    choice.delta.content !== undefined &&
    typeof choice.delta.content !== "string"
  ) {
    throw new Error("Bridge chat stream contained a malformed chunk.");
  }
  return {
    object: "chat.completion.chunk" as const,
    choices
  };
}
function formatCauseMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return "";
  }
  return error.message.trim();
}

export const bridgeApiClientModule = {
  DEFAULT_BRIDGE_API_BASE_URL,
  BridgeApiHttpError,
  BridgeApiConnectionError,
  sendBridgeMessage,
  checkBridgeHealth,
  createBridgeChatCompletion,
  streamBridgeChatCompletion,
  buildSessionMessageUrl,
  buildHealthUrl,
  buildChatCompletionsUrl
};

export type {
  BridgeApiClientFetch,
  BridgeApiConnectionError,
  BridgeApiHttpError,
  CheckBridgeHealthInput,
  CreateBridgeChatCompletionInput,
  SendBridgeMessageInput,
  StreamBridgeChatCompletionInput
};
