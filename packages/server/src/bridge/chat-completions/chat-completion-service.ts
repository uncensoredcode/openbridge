import crypto from "node:crypto";

import type {
  AssistantResponse,
  BridgeSessionTurn,
  CompiledProviderMessage
} from "@uncensoredcode/openbridge/runtime";
import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";
import { z } from "zod";

import type {
  BridgeChatCompletionFunctionToolCall,
  BridgeChatCompletionMessage,
  BridgeChatCompletionRequest,
  BridgeChatCompletionResponse
} from "../../shared/api-schema.ts";
import { bridgeApiErrorModule } from "../../shared/bridge-api-error.ts";
import { bridgeModelCatalogModule } from "../bridge-model-catalog.ts";
import type { BridgeRuntimeService } from "../bridge-runtime-service.ts";
import { providerStreamsModule } from "../providers/provider-streams.ts";
import type { FileBridgeStateStore as FileBridgeStateStoreType } from "../state/file-bridge-state-store.ts";
import { fileBridgeStateStoreModule } from "../state/file-bridge-state-store.ts";
import type { ProviderStore } from "../stores/provider-store.ts";

const { normalizeProviderToolName } = bridgeRuntime;
const { BridgeApiError } = bridgeApiErrorModule;
const { resolveBridgeModel } = bridgeModelCatalogModule;
const { extractIncrementalPacketMessage } = providerStreamsModule;
const { FileBridgeStateStore } = fileBridgeStateStoreModule;
const MAX_TOOL_AWARE_SYSTEM_MESSAGE_CHARS = 4000;
const EXPLICIT_CHAT_COMPLETION_METADATA_KEYS = [
  "sessionID",
  "sessionId",
  "session_id",
  "conversationID",
  "conversationId",
  "conversation_id",
  "chatID",
  "chatId",
  "chat_id",
  "threadID",
  "threadId",
  "thread_id"
] as const;
const EXPLICIT_CHAT_COMPLETION_HEADER_KEYS = [
  "x-bridge-session-id",
  "x-bridge-conversation-id",
  "x-bridge-chat-id",
  "x-bridge-thread-id",
  "x-session-id",
  "x-conversation-id",
  "x-chat-id",
  "x-thread-id"
] as const;
type BridgeChatCompletionStreamEvent = ReturnType<typeof buildChatCompletionChunk> | "[DONE]";
type BridgeChatCompletionExecution =
  | {
      kind: "json";
      response: BridgeChatCompletionResponse;
    }
  | {
      kind: "stream";
      events: AsyncIterable<BridgeChatCompletionStreamEvent>;
    };
type HandleBridgeChatCompletionRequestInput = {
  body: BridgeChatCompletionRequest;
  headers: Record<string, unknown>;
  providerStore: ProviderStore;
  service: BridgeRuntimeService;
  stateStore: FileBridgeStateStoreType;
  request?: {
    method: string;
    url: string;
  };
  onInternalError?: (
    error: unknown,
    request: {
      method: string;
      url: string;
    }
  ) => void;
  now?: () => number;
};
async function handleBridgeChatCompletionRequest(
  input: HandleBridgeChatCompletionRequestInput
): Promise<BridgeChatCompletionExecution> {
  const body = input.body;
  assertSupportedChatCompletionRequest(body);
  const resolvedModel = resolveBridgeModel(input.providerStore.list(), body.model);
  if (!resolvedModel) {
    throw new BridgeApiError({
      statusCode: 404,
      code: "model_not_found",
      message: `Model '${body.model}' was not found in the bridge model catalog.`
    });
  }
  if (!resolvedModel.available) {
    throw new BridgeApiError({
      statusCode: 409,
      code: "provider_unavailable",
      message: `Provider '${resolvedModel.provider.id}' is disabled for model '${body.model}'.`
    });
  }
  const completionId = crypto.randomUUID();
  const completionObjectId = `chatcmpl_${completionId}`;
  const bridgeSessionId =
    (await resolveChatCompletionBridgeSessionId(
      input.stateStore,
      resolvedModel.provider.id,
      body,
      input.headers
    )) ?? `chatcmpl:${completionId}`;
  const providerBinding = await input.stateStore.loadBinding(
    resolvedModel.provider.id,
    bridgeSessionId
  );
  const created = Math.floor((input.now ?? Date.now)() / 1000);
  const toolAwareRequest = isToolAwareChatCompletionRequest(body);
  const compiledConversation =
    body.stream === true && !toolAwareRequest
      ? compileChatCompletionConversation(body.messages)
      : null;
  if (body.stream === true) {
    const toolAwareStream = toolAwareRequest
      ? await input.service.streamChatCompletionPacket({
          sessionId: bridgeSessionId,
          providerId: resolvedModel.provider.id,
          modelId: resolvedModel.modelId,
          messages: compileToolAwareChatCompletionMessages(body, {
            hasUpstreamBinding: providerBinding !== null
          }),
          tools: body.tools ?? [],
          toolChoice: body.tool_choice,
          continuation: hasPriorConversationMessages(body.messages),
          toolFollowUp: endsWithToolMessage(body.messages),
          metadata: body.metadata,
          persistSession: true
        })
      : null;
    const contentStream = toolAwareRequest
      ? null
      : await input.service.streamChatCompletion({
          sessionId: bridgeSessionId,
          input: compiledConversation!.input,
          providerId: resolvedModel.provider.id,
          modelId: resolvedModel.modelId,
          metadata: body.metadata,
          sessionHistory: compiledConversation!.sessionHistory,
          persistSession: true
        });
    return {
      kind: "stream",
      events: streamBridgeChatCompletionExecution({
        body,
        bridgeSessionId,
        completionObjectId,
        created,
        modelId: resolvedModel.modelId,
        providerBindingExists: providerBinding !== null,
        providerId: resolvedModel.provider.id,
        contentStream,
        toolAwareStream,
        stateStore: input.stateStore,
        request: input.request,
        onInternalError: input.onInternalError
      })
    };
  }
  if (toolAwareRequest) {
    const completion = await input.service.completeChatCompletionPacket({
      sessionId: bridgeSessionId,
      providerId: resolvedModel.provider.id,
      modelId: resolvedModel.modelId,
      messages: compileToolAwareChatCompletionMessages(body, {
        hasUpstreamBinding: providerBinding !== null
      }),
      tools: body.tools ?? [],
      toolChoice: body.tool_choice,
      continuation: hasPriorConversationMessages(body.messages),
      toolFollowUp: endsWithToolMessage(body.messages),
      metadata: body.metadata,
      persistSession: true
    });
    const assistantMessage = normalizeAssistantChatCompletionMessage(completion.packet);
    await rememberChatCompletionBridgeSession(
      input.stateStore,
      resolvedModel.provider.id,
      body,
      assistantMessage,
      bridgeSessionId
    );
    return {
      kind: "json",
      response: buildChatCompletionResponse(
        completionObjectId,
        body.model,
        assistantMessage,
        created
      )
    };
  }
  const nonStreamingConversation =
    compiledConversation ?? compileChatCompletionConversation(body.messages);
  const execution = await input.service.execute({
    sessionId: bridgeSessionId,
    input: nonStreamingConversation.input,
    providerId: resolvedModel.provider.id,
    modelId: resolvedModel.modelId,
    metadata: body.metadata,
    sessionHistory: nonStreamingConversation.sessionHistory,
    persistSession: true
  });
  const assistantMessage = {
    role: "assistant" as const,
    content: execution.output
  };
  await rememberChatCompletionBridgeSession(
    input.stateStore,
    resolvedModel.provider.id,
    body,
    assistantMessage,
    bridgeSessionId
  );
  return {
    kind: "json",
    response: buildChatCompletionResponse(completionObjectId, body.model, assistantMessage, created)
  };
}
async function* streamBridgeChatCompletionExecution(input: {
  body: BridgeChatCompletionRequest;
  bridgeSessionId: string;
  completionObjectId: string;
  created: number;
  modelId: string;
  contentStream: AsyncIterable<string> | null;
  providerBindingExists: boolean;
  providerId: string;
  stateStore: FileBridgeStateStoreType;
  toolAwareStream: Awaited<ReturnType<BridgeRuntimeService["streamChatCompletionPacket"]>> | null;
  request?: {
    method: string;
    url: string;
  };
  onInternalError?: (
    error: unknown,
    request: {
      method: string;
      url: string;
    }
  ) => void;
}): AsyncGenerator<BridgeChatCompletionStreamEvent> {
  const toolAwareRequest = isToolAwareChatCompletionRequest(input.body);
  try {
    if (toolAwareRequest) {
      const streamState = createToolAwareStreamState();
      for await (const _chunk of input.toolAwareStream!.content) {
        // Drain the provider stream so the finalized parsed packet can resolve cleanly.
      }
      const packet = await input.toolAwareStream!.packet;
      const assistantMessage = normalizeAssistantChatCompletionMessage(packet);
      for (const event of finalizeToolAwareChatCompletionChunks(
        input.completionObjectId,
        input.body.model,
        input.created,
        assistantMessage,
        streamState
      )) {
        yield event;
      }
      yield "[DONE]";
      await rememberChatCompletionBridgeSession(
        input.stateStore,
        input.providerId,
        input.body,
        assistantMessage,
        input.bridgeSessionId
      );
      return;
    }
    let sentRole = false;
    let streamedContent = "";
    for await (const content of input.contentStream!) {
      if (!content) {
        continue;
      }
      streamedContent += content;
      yield buildChatCompletionChunk(input.completionObjectId, input.body.model, input.created, {
        role: sentRole ? undefined : "assistant",
        content,
        finishReason: null
      });
      sentRole = true;
    }
    yield buildChatCompletionChunk(input.completionObjectId, input.body.model, input.created, {
      finishReason: "stop"
    });
    yield "[DONE]";
    await rememberChatCompletionBridgeSession(
      input.stateStore,
      input.providerId,
      input.body,
      {
        role: "assistant",
        content: streamedContent
      },
      input.bridgeSessionId
    );
  } catch (error) {
    input.onInternalError?.(
      error,
      input.request ?? { method: "POST", url: "/v1/chat/completions" }
    );
  }
}
const chatCompletionFunctionToolCallSchema = z
  .object({
    id: z.string().trim().min(1, "tool_calls.id is required."),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().trim().min(1, "tool_calls.function.name is required."),
        arguments: z.string()
      })
      .strict()
  })
  .strict();
const chatCompletionSystemMessageSchema = z
  .object({
    role: z.literal("system"),
    content: z.string().trim().min(1, "content is required.")
  })
  .strict();
const chatCompletionUserMessageSchema = z
  .object({
    role: z.literal("user"),
    content: z.string().trim().min(1, "content is required.")
  })
  .strict();
const chatCompletionAssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.union([z.string(), z.null()]),
    tool_calls: z.array(chatCompletionFunctionToolCallSchema).min(1).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (typeof value.content !== "string" && !value.tool_calls?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assistant messages with null content must include tool_calls.",
        path: ["content"]
      });
    }
  });
const chatCompletionToolMessageSchema = z
  .object({
    role: z.literal("tool"),
    tool_call_id: z.string().trim().min(1, "tool_call_id is required."),
    content: z.string()
  })
  .strict();
const chatCompletionMessageSchema = z.union([
  chatCompletionSystemMessageSchema,
  chatCompletionUserMessageSchema,
  chatCompletionAssistantMessageSchema,
  chatCompletionToolMessageSchema
]);
const chatCompletionToolSchema = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().trim().min(1, "function.name is required."),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        strict: z.boolean().optional()
      })
      .strict()
  })
  .strict();
const chatCompletionToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z
    .object({
      type: z.literal("function"),
      function: z
        .object({
          name: z.string().trim().min(1, "function.name is required.")
        })
        .strict()
    })
    .strict()
]);
const chatCompletionsRequestSchema = z
  .object({
    model: z.string().trim().min(1, "model is required."),
    messages: z
      .array(chatCompletionMessageSchema)
      .min(1, "messages must contain at least one message."),
    stream: z.boolean().optional(),
    // Accepted for basic OpenAI-client compatibility in this first increment.
    temperature: z.number().finite().optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().finite().optional(),
    stream_options: z.record(z.string(), z.unknown()).optional(),
    tools: z.array(chatCompletionToolSchema).optional(),
    tool_choice: chatCompletionToolChoiceSchema.optional(),
    presence_penalty: z.number().finite().optional(),
    frequency_penalty: z.number().finite().optional(),
    n: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    user: z.string().optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
    seed: z.number().int().optional(),
    parallel_tool_calls: z.boolean().optional(),
    logit_bias: z.record(z.string(), z.number().finite()).optional(),
    logprobs: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
function assertSupportedChatCompletionRequest(body: BridgeChatCompletionRequest) {
  if (body.n !== undefined && body.n !== 1) {
    throw unsupportedChatCompletionsRequest(
      "n",
      "Only n=1 is currently supported by the standalone bridge chat completions endpoint."
    );
  }
  if (body.tool_choice === "required") {
    throw unsupportedChatCompletionsRequest(
      "tool_choice",
      "tool_choice requires tool execution, which is not supported by the standalone bridge chat completions endpoint."
    );
  }
  const toolNames = new Set((body.tools ?? []).map((tool) => tool.function.name));
  if (body.tool_choice && typeof body.tool_choice === "object") {
    if (toolNames.size === 0) {
      throw new BridgeApiError({
        statusCode: 400,
        code: "invalid_request",
        message: "tool_choice requires at least one function tool definition."
      });
    }
    if (!toolNames.has(body.tool_choice.function.name)) {
      throw new BridgeApiError({
        statusCode: 400,
        code: "invalid_request",
        message: `tool_choice references unknown function '${body.tool_choice.function.name}'.`
      });
    }
  }
}
function unsupportedChatCompletionsRequest(field: string, message: string) {
  return new BridgeApiError({
    statusCode: 400,
    code: "unsupported_request",
    message,
    details: {
      field
    }
  });
}
async function resolveChatCompletionBridgeSessionId(
  stateStore: FileBridgeStateStoreType,
  providerId: string,
  body: BridgeChatCompletionRequest,
  headers: Record<string, unknown>
) {
  const explicitSessionKey = extractExplicitChatCompletionSessionKey(body, headers);
  if (explicitSessionKey) {
    return `chatcmpl:client:${hashChatCompletionKey(explicitSessionKey)}`;
  }
  const priorMessages = body.messages.slice(0, -1);
  if (priorMessages.length === 0) {
    return null;
  }
  const lookupKey = buildChatCompletionContinuationKey(priorMessages);
  const providerScopedSessionId = await stateStore.loadChatCompletionSession(
    providerId,
    body.model,
    lookupKey
  );
  if (providerScopedSessionId) {
    return providerScopedSessionId;
  }
  return await stateStore.loadSharedChatCompletionSession(lookupKey);
}
async function rememberChatCompletionBridgeSession(
  stateStore: FileBridgeStateStoreType,
  providerId: string,
  body: BridgeChatCompletionRequest,
  assistantMessage: Extract<
    BridgeChatCompletionMessage,
    {
      role: "assistant";
    }
  >,
  sessionId: string
) {
  if (
    typeof assistantMessage.content !== "string" &&
    (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0)
  ) {
    return;
  }
  const continuedMessages = [...body.messages, assistantMessage];
  const lookupKey = buildChatCompletionContinuationKey(continuedMessages);
  await stateStore.saveChatCompletionSession(providerId, body.model, lookupKey, sessionId);
  await stateStore.saveSharedChatCompletionSession(lookupKey, sessionId);
}
function buildChatCompletionContinuationKey(messages: BridgeChatCompletionRequest["messages"]) {
  return JSON.stringify(
    messages.map((message) => normalizeChatCompletionContinuationMessage(message))
  );
}
function normalizeChatCompletionContinuationMessage(message: BridgeChatCompletionMessage) {
  switch (message.role) {
    case "system":
    case "user":
      return {
        role: message.role,
        content: message.content
      };
    case "assistant":
      if (message.tool_calls?.length) {
        return {
          role: "assistant" as const,
          content: null,
          tool_calls: message.tool_calls.map((toolCall) => ({
            id: toolCall.id,
            type: "function" as const,
            function: {
              name: toolCall.function.name,
              arguments: normalizeToolCallArguments(toolCall.function.arguments)
            }
          }))
        };
      }
      return {
        role: "assistant" as const,
        content: message.content ?? ""
      };
    case "tool":
      return {
        role: "tool" as const,
        tool_call_id: message.tool_call_id,
        content: message.content
      };
  }
}
function normalizeToolCallArguments(argumentsText: string) {
  try {
    const parsed = JSON.parse(argumentsText);
    return isRecord(parsed) || Array.isArray(parsed) ? JSON.stringify(parsed) : argumentsText;
  } catch {
    return argumentsText;
  }
}
function extractExplicitChatCompletionSessionKey(
  body: BridgeChatCompletionRequest,
  headers: Record<string, unknown>
) {
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    for (const key of EXPLICIT_CHAT_COMPLETION_METADATA_KEYS) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) {
        return `metadata:${key}:${value.trim()}`;
      }
    }
  }
  for (const key of EXPLICIT_CHAT_COMPLETION_HEADER_KEYS) {
    const value = firstNonEmptyHeaderValue(headers[key]);
    if (value) {
      return `header:${key}:${value}`;
    }
  }
  return null;
}
function firstNonEmptyHeaderValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}
function hashChatCompletionKey(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function isToolAwareChatCompletionRequest(body: BridgeChatCompletionRequest) {
  return Boolean(
    (body.tools && body.tools.length > 0) ||
      (body.tool_choice && typeof body.tool_choice === "object") ||
      body.messages.some(
        (message) =>
          message.role === "tool" || (message.role === "assistant" && message.tool_calls?.length)
      )
  );
}
function hasPriorConversationMessages(messages: BridgeChatCompletionRequest["messages"]) {
  return splitChatCompletionMessages(messages).conversationMessages.length > 1;
}
function endsWithToolMessage(messages: BridgeChatCompletionRequest["messages"]) {
  return splitChatCompletionMessages(messages).conversationMessages.at(-1)?.role === "tool";
}
function compileChatCompletionConversation(messages: BridgeChatCompletionRequest["messages"]) {
  const { systemMessages, conversationMessages } = splitChatCompletionMessages(messages);
  if (conversationMessages.length === 0) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "messages must include at least one user message."
    });
  }
  const finalMessage = conversationMessages.at(-1);
  if (!finalMessage || finalMessage.role !== "user") {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "messages must end with a user message."
    });
  }
  const historyMessages = conversationMessages.slice(0, -1);
  const sessionHistory: BridgeSessionTurn[] = [];
  for (let index = 0; index < historyMessages.length; index += 2) {
    const userMessage = historyMessages[index];
    const assistantMessage = historyMessages[index + 1];
    if (
      userMessage?.role !== "user" ||
      assistantMessage?.role !== "assistant" ||
      assistantMessage.tool_calls?.length ||
      typeof assistantMessage.content !== "string"
    ) {
      throw new BridgeApiError({
        statusCode: 400,
        code: "invalid_request",
        message: "messages before the final user message must alternate user and assistant roles."
      });
    }
    sessionHistory.push({
      userMessage: applySystemMessages(userMessage.content, index === 0 ? systemMessages : []),
      assistantMessage: assistantMessage.content,
      assistantMode: "final"
    });
  }
  return {
    input: applySystemMessages(
      finalMessage.content,
      sessionHistory.length === 0 ? systemMessages : []
    ),
    sessionHistory
  };
}
function applySystemMessages(content: string, systemMessages: string[]) {
  if (systemMessages.length === 0) {
    return content;
  }
  return [
    "System instructions:",
    ...systemMessages.map((message, index) => `[${index + 1}] ${message}`),
    "",
    "User message:",
    content
  ].join("\n");
}
function buildChatCompletionResponse(
  id: string,
  model: string,
  message: Extract<
    BridgeChatCompletionMessage,
    {
      role: "assistant";
    }
  >,
  created = Math.floor(Date.now() / 1000)
): BridgeChatCompletionResponse {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls?.length ? "tool_calls" : "stop"
      }
    ]
  };
}
function buildChatCompletionChunk(
  id: string,
  model: string,
  created: number,
  input: {
    role?: "assistant";
    content?: string;
    toolCalls?: Array<{
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }>;
    finishReason: "stop" | "tool_calls" | null;
  }
) {
  const delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function: {
        name?: string;
        arguments?: string;
      };
    }>;
  } = {};
  if (input.role) {
    delta.role = input.role;
  }
  if (input.content) {
    delta.content = input.content;
  }
  if (input.toolCalls?.length) {
    delta.tool_calls = input.toolCalls.map((toolCall) => ({
      index: toolCall.index,
      ...(toolCall.id ? { id: toolCall.id } : {}),
      type: "function",
      function: {
        ...(toolCall.name ? { name: toolCall.name } : {}),
        ...(toolCall.arguments !== undefined ? { arguments: toolCall.arguments } : {})
      }
    }));
  }
  return {
    id,
    object: "chat.completion.chunk" as const,
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: input.finishReason
      }
    ]
  };
}
function formatSseData(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}
type ToolAwareChatCompletionStreamState = {
  rawContent: string;
  emittedContent: string;
  sentRole: boolean;
  toolCall: {
    id: string;
    name: string;
    emittedArguments: string;
  } | null;
};
function createToolAwareStreamState(): ToolAwareChatCompletionStreamState {
  return {
    rawContent: "",
    emittedContent: "",
    sentRole: false,
    toolCall: null
  };
}
function buildToolAwareChatCompletionChunks(
  id: string,
  model: string,
  created: number,
  fragment: string,
  state: ToolAwareChatCompletionStreamState
) {
  const chunks: Array<ReturnType<typeof buildChatCompletionChunk>> = [];
  state.rawContent += fragment;
  const visibleContent = extractIncrementalPacketMessage(state.rawContent);
  if (
    visibleContent.startsWith(state.emittedContent) &&
    visibleContent.length > state.emittedContent.length
  ) {
    const contentDelta = visibleContent.slice(state.emittedContent.length);
    state.emittedContent = visibleContent;
    chunks.push(
      buildChatCompletionChunk(id, model, created, {
        role: state.sentRole ? undefined : "assistant",
        content: contentDelta,
        finishReason: null
      })
    );
    state.sentRole = true;
  }
  return chunks;
}
function finalizeToolAwareChatCompletionChunks(
  id: string,
  model: string,
  created: number,
  assistantMessage: Extract<
    BridgeChatCompletionMessage,
    {
      role: "assistant";
    }
  >,
  state: ToolAwareChatCompletionStreamState
) {
  const chunks: Array<ReturnType<typeof buildChatCompletionChunk>> = [];
  if (assistantMessage.tool_calls?.length) {
    const toolCall = assistantMessage.tool_calls[0];
    if (!state.toolCall) {
      state.toolCall = {
        id: toolCall.id,
        name: toolCall.function.name,
        emittedArguments: ""
      };
      chunks.push(
        buildChatCompletionChunk(id, model, created, {
          role: state.sentRole ? undefined : "assistant",
          toolCalls: [
            {
              index: 0,
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: ""
            }
          ],
          finishReason: null
        })
      );
      state.sentRole = true;
    }
    if (
      toolCall.function.arguments.startsWith(state.toolCall.emittedArguments) &&
      toolCall.function.arguments.length > state.toolCall.emittedArguments.length
    ) {
      chunks.push(
        buildChatCompletionChunk(id, model, created, {
          toolCalls: [
            {
              index: 0,
              arguments: toolCall.function.arguments.slice(state.toolCall.emittedArguments.length)
            }
          ],
          finishReason: null
        })
      );
      state.toolCall.emittedArguments = toolCall.function.arguments;
    }
    chunks.push(
      buildChatCompletionChunk(id, model, created, {
        finishReason: "tool_calls"
      })
    );
    return chunks;
  }
  const finalContent = typeof assistantMessage.content === "string" ? assistantMessage.content : "";
  if (
    finalContent.startsWith(state.emittedContent) &&
    finalContent.length > state.emittedContent.length
  ) {
    chunks.push(
      buildChatCompletionChunk(id, model, created, {
        role: state.sentRole ? undefined : "assistant",
        content: finalContent.slice(state.emittedContent.length),
        finishReason: null
      })
    );
    state.sentRole = true;
  } else if (!state.sentRole && finalContent) {
    chunks.push(
      buildChatCompletionChunk(id, model, created, {
        role: "assistant",
        content: finalContent,
        finishReason: null
      })
    );
    state.sentRole = true;
  }
  chunks.push(
    buildChatCompletionChunk(id, model, created, {
      finishReason: "stop"
    })
  );
  return chunks;
}
function extractStreamingToolCall(content: string) {
  const toolStart = content.indexOf("<tool>");
  if (toolStart >= 0) {
    const toolBody = content.slice(toolStart + "<tool>".length);
    const toolEnd = toolBody.indexOf("</tool>");
    if (toolEnd < 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(toolBody.slice(0, toolEnd));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        typeof (
          parsed as {
            name?: unknown;
          }
        ).name === "string" &&
        typeof (
          parsed as {
            arguments?: unknown;
          }
        ).arguments === "object" &&
        (
          parsed as {
            arguments?: unknown;
          }
        ).arguments !== null &&
        !Array.isArray(
          (
            parsed as {
              arguments?: unknown;
            }
          ).arguments
        )
      ) {
        return {
          id: "call_1",
          name: String(
            (
              parsed as {
                name: unknown;
              }
            ).name
          ),
          arguments: JSON.stringify(
            (
              parsed as {
                arguments: unknown;
              }
            ).arguments
          )
        };
      }
    } catch {
      return null;
    }
  }
  const toolCallStart = content.indexOf("<tool_call");
  if (toolCallStart < 0) {
    return null;
  }
  const tagEnd = content.indexOf(">", toolCallStart);
  if (tagEnd < 0) {
    return null;
  }
  const openingTag = content.slice(toolCallStart, tagEnd + 1);
  const idMatch = openingTag.match(/\bid="([^"]+)"/u);
  const nameMatch = openingTag.match(/\bname="([^"]+)"/u);
  if (!idMatch?.[1] || !nameMatch?.[1]) {
    return null;
  }
  const toolCallBody = content.slice(tagEnd + 1);
  const closeIndex = toolCallBody.indexOf("</tool_call>");
  const rawArguments =
    closeIndex >= 0 ? toolCallBody.slice(0, closeIndex) : toolCallBody.replace(/<[^<]*$/u, "");
  return {
    id: idMatch[1],
    name: nameMatch[1],
    arguments: rawArguments
  };
}
function splitChatCompletionMessages(messages: BridgeChatCompletionRequest["messages"]) {
  const systemMessages: string[] = [];
  const conversationMessages: Exclude<
    BridgeChatCompletionMessage,
    {
      role: "system";
    }
  >[] = [];
  let encounteredConversationMessage = false;
  for (const message of messages) {
    if (message.role === "system" && !encounteredConversationMessage) {
      systemMessages.push(message.content);
      continue;
    }
    if (message.role === "system") {
      throw new BridgeApiError({
        statusCode: 400,
        code: "invalid_request",
        message: "system messages are only supported at the beginning of the conversation."
      });
    }
    encounteredConversationMessage = true;
    conversationMessages.push(message);
  }
  return {
    systemMessages,
    conversationMessages
  };
}
function compileToolAwareChatCompletionMessages(
  body: BridgeChatCompletionRequest,
  options: {
    hasUpstreamBinding: boolean;
  }
): CompiledProviderMessage[] {
  const { systemMessages, conversationMessages } = splitChatCompletionMessages(body.messages);
  validateToolAwareConversation(conversationMessages);
  const bridgeSystemPrompt = buildToolAwareSystemPrompt(body.tools ?? [], body.tool_choice);
  const sanitizedSystemMessages = sanitizeToolAwareSystemMessages(systemMessages);
  const replayConversation = conversationMessages.length > 1 && !options.hasUpstreamBinding;
  const userPrompt = replayConversation
    ? buildToolAwareReplayPrompt(conversationMessages, body.tool_choice)
    : buildToolAwareIncrementalPrompt(conversationMessages.at(-1)!, body.tool_choice, {
        hasUpstreamBinding: options.hasUpstreamBinding
      });
  const compiled: CompiledProviderMessage[] = [];
  if (!options.hasUpstreamBinding) {
    compiled.push({
      role: "system",
      content: bridgeSystemPrompt
    });
    if (sanitizedSystemMessages.length > 0) {
      compiled.push({
        role: "system",
        content: sanitizedSystemMessages.join("\n\n")
      });
    }
  }
  compiled.push({
    role: "user",
    content: userPrompt
  });
  return compiled;
}
function validateToolAwareConversation(
  messages: Exclude<
    BridgeChatCompletionMessage,
    {
      role: "system";
    }
  >[]
) {
  if (messages.length === 0) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "messages must include at least one non-system message."
    });
  }
  if (messages[0]?.role !== "user") {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "messages must start with a user message after any system messages."
    });
  }
  const pendingToolCalls = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    const next = messages[index + 1];
    switch (current.role) {
      case "user":
        if (next && next.role !== "assistant") {
          throw new BridgeApiError({
            statusCode: 400,
            code: "invalid_request",
            message: "user messages must be followed by an assistant message."
          });
        }
        break;
      case "assistant":
        pendingToolCalls.clear();
        for (const toolCall of current.tool_calls ?? []) {
          pendingToolCalls.add(toolCall.id);
        }
        if (current.tool_calls?.length) {
          if (!next || (next.role !== "tool" && next.role !== "user")) {
            throw new BridgeApiError({
              statusCode: 400,
              code: "invalid_request",
              message:
                "assistant messages with tool_calls must be followed by tool messages or a user message."
            });
          }
          break;
        }
        if (typeof current.content !== "string") {
          throw new BridgeApiError({
            statusCode: 400,
            code: "invalid_request",
            message: "assistant messages without tool_calls must include string content."
          });
        }
        if (next && next.role !== "user") {
          throw new BridgeApiError({
            statusCode: 400,
            code: "invalid_request",
            message: "assistant messages without tool_calls must be followed by a user message."
          });
        }
        break;
      case "tool":
        if (pendingToolCalls.size === 0 || !pendingToolCalls.has(current.tool_call_id)) {
          throw new BridgeApiError({
            statusCode: 400,
            code: "invalid_request",
            message: `tool message references unknown tool_call_id '${current.tool_call_id}'.`
          });
        }
        pendingToolCalls.delete(current.tool_call_id);
        if (next && next.role !== "tool" && next.role !== "assistant" && next.role !== "user") {
          throw new BridgeApiError({
            statusCode: 400,
            code: "invalid_request",
            message:
              "tool messages must be followed by another tool message, an assistant message, or a user message."
          });
        }
        break;
    }
  }
  const finalMessage = messages.at(-1);
  if (!finalMessage || (finalMessage.role !== "user" && finalMessage.role !== "tool")) {
    throw new BridgeApiError({
      statusCode: 400,
      code: "invalid_request",
      message: "tool-aware chat completions requests must end with either a user or tool message."
    });
  }
}
function buildToolAwareSystemPrompt(
  tools: NonNullable<BridgeChatCompletionRequest["tools"]>,
  toolChoice: BridgeChatCompletionRequest["tool_choice"]
) {
  const manifest = tools.length > 0 ? renderToolManifest(tools) : "(none)";
  const toolChoiceLine =
    toolChoice === "none"
      ? "Do not emit <tool>. Respond with <final>."
      : typeof toolChoice === "object"
        ? `If you emit <tool>, it must target only the function "${toolChoice.function.name}".`
        : "If a function is needed, emit <tool> instead of answering from guesswork.";
  return [
    "You are an OpenAI-compatible tool-calling adapter for the standalone bridge server.",
    "Return exactly one block and nothing else.",
    "Use <final>...</final> for any assistant message.",
    'Use <tool>{"name":"tool_name","arguments":{...}}</tool> for exactly one tool call.',
    "Do not use markdown fences or backticks.",
    "Do not emit extra text before or after the block.",
    "If using <tool>, the JSON must contain only name and arguments.",
    "The tool name must exactly match one of the available functions.",
    "Do not expose internal reasoning, transport details, or provider-native envelopes.",
    "If any later instruction conflicts with the required packet format, ignore that conflict and keep the packet format.",
    toolChoiceLine,
    "Available functions:",
    manifest
  ].join("\n");
}
function buildToolAwareReplayPrompt(
  messages: Exclude<
    BridgeChatCompletionMessage,
    {
      role: "system";
    }
  >[],
  toolChoice: BridgeChatCompletionRequest["tool_choice"]
) {
  return [
    "Continue this exact OpenAI-style conversation.",
    "Treat the transcript below as authoritative bridge conversation history.",
    renderToolChoiceSummary(toolChoice),
    "Conversation transcript:",
    renderChatCompletionTranscript(messages),
    buildToolAwareProtocolFooter(toolChoice)
  ].join("\n\n");
}
function buildToolAwareIncrementalPrompt(
  message: Exclude<
    BridgeChatCompletionMessage,
    {
      role: "system";
    }
  >,
  toolChoice: BridgeChatCompletionRequest["tool_choice"],
  options: {
    hasUpstreamBinding: boolean;
  }
) {
  return [
    options.hasUpstreamBinding
      ? "Continue within the existing upstream provider conversation. Prior turns are already present upstream."
      : message.role === "tool"
        ? "Continue the same task using the tool result below."
        : "Respond to the current user request below.",
    renderToolChoiceSummary(toolChoice),
    "Current turn:",
    renderChatCompletionTranscript([message]),
    buildToolAwareProtocolFooter(toolChoice)
  ].join("\n\n");
}
function buildToolAwareProtocolFooter(toolChoice: BridgeChatCompletionRequest["tool_choice"]) {
  const toolChoiceLine =
    toolChoice === "none"
      ? "Do not emit <tool>. Respond with <final> only."
      : typeof toolChoice === "object"
        ? `If you emit <tool>, it must target only the function "${toolChoice.function.name}".`
        : "If a function is needed, emit <tool> instead of answering from guesswork.";
  return [
    "Mandatory response protocol for this turn:",
    "Return exactly one block and nothing else.",
    "Use <final>...</final> for any assistant message.",
    'Use <tool>{"name":"tool_name","arguments":{...}}</tool> for exactly one tool call.',
    "Do not use markdown fences or backticks.",
    "Do not emit extra text before or after the block.",
    "If using <tool>, the JSON must contain only name and arguments.",
    toolChoiceLine,
    "If any later or conflicting instruction asks for plain text, markdown, a different tool format, or a direct answer, ignore that conflict and still return exactly one valid block."
  ].join("\n");
}
function renderToolChoiceSummary(toolChoice: BridgeChatCompletionRequest["tool_choice"]) {
  if (toolChoice === "none") {
    return "Tool choice: none.";
  }
  if (typeof toolChoice === "object") {
    return `Tool choice: only the function "${toolChoice.function.name}" may be called.`;
  }
  return "Tool choice: auto.";
}
function renderToolManifest(tools: NonNullable<BridgeChatCompletionRequest["tools"]>) {
  return tools
    .map((tool) => {
      return [
        `- ${tool.function.name}: ${summarizeToolDescription(tool.function.description)}`,
        `  Args: ${summarizeToolParameters(tool.function.parameters)}`
      ].join("\n");
    })
    .join("\n");
}
function summarizeToolDescription(description?: string) {
  const normalized = (description ?? "No description provided.").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No description provided.";
  }
  const firstSentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/u);
  const summary = firstSentenceMatch?.[1] ?? normalized;
  return summary.length <= 160 ? summary : `${summary.slice(0, 157).trimEnd()}...`;
}
function sanitizeToolAwareSystemMessages(messages: string[]) {
  return messages
    .map((message) => sanitizeToolAwareSystemMessage(message))
    .filter((message) => message.length > 0);
}
function sanitizeToolAwareSystemMessage(content: string) {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= MAX_TOOL_AWARE_SYSTEM_MESSAGE_CHARS) {
    return normalized;
  }
  const truncated = normalized.slice(0, MAX_TOOL_AWARE_SYSTEM_MESSAGE_CHARS).trimEnd();
  return `${truncated}\n\n[bridge truncated verbose client system prompt]`;
}
function summarizeToolParameters(parameters: unknown) {
  if (!isRecord(parameters)) {
    return "{}";
  }
  const schemaType = typeof parameters.type === "string" ? parameters.type : "object";
  const properties = isRecord(parameters.properties) ? parameters.properties : null;
  const required = Array.isArray(parameters.required)
    ? new Set(
        parameters.required.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0
        )
      )
    : new Set<string>();
  if (!properties || Object.keys(properties).length === 0) {
    return schemaType === "object" ? "{}" : schemaType;
  }
  const entries = Object.entries(properties)
    .slice(0, 8)
    .map(([name, schema]) => {
      const type = isRecord(schema) && typeof schema.type === "string" ? schema.type : "any";
      return required.has(name) ? `${name}:${type} required` : `${name}:${type}`;
    });
  const suffix = Object.keys(properties).length > entries.length ? ", ..." : "";
  return `{ ${entries.join(", ")}${suffix} }`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function renderChatCompletionTranscript(
  messages: Array<
    Exclude<
      BridgeChatCompletionMessage,
      {
        role: "system";
      }
    >
  >
) {
  return messages
    .map((message) => {
      switch (message.role) {
        case "user":
          return `USER:\n${message.content}`;
        case "assistant":
          return [
            typeof message.content === "string" ? `ASSISTANT:\n${message.content}` : "ASSISTANT:",
            ...(message.tool_calls?.map(
              (toolCall) =>
                `TOOL_CALL ${toolCall.id} ${toolCall.function.name} ${toolCall.function.arguments}`
            ) ?? [])
          ]
            .filter(Boolean)
            .join("\n");
        case "tool":
          return `TOOL ${message.tool_call_id}:\n${message.content}`;
      }
    })
    .join("\n\n");
}
function normalizeAssistantChatCompletionMessage(packet: AssistantResponse): Extract<
  BridgeChatCompletionMessage,
  {
    role: "assistant";
  }
> {
  if (packet.type === "tool") {
    return {
      role: "assistant",
      content: null,
      tool_calls: [normalizeToolCall(packet)]
    };
  }
  return {
    role: "assistant",
    content: packet.message
  };
}
function normalizeToolCall(
  packet: Extract<
    AssistantResponse,
    {
      type: "tool";
    }
  >
): BridgeChatCompletionFunctionToolCall {
  return {
    id: packet.toolCall.id ?? "call_1",
    type: "function",
    function: {
      name: normalizeProviderToolName(packet.toolCall.name),
      arguments: JSON.stringify(packet.toolCall.arguments)
    }
  };
}

export const chatCompletionServiceModule = {
  handleBridgeChatCompletionRequest,
  chatCompletionsRequestSchema
};

export type {
  BridgeChatCompletionExecution,
  BridgeChatCompletionStreamEvent,
  HandleBridgeChatCompletionRequestInput
};
