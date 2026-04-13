type BridgeChatCompletionFunctionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};
type BridgeChatCompletionMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: BridgeChatCompletionFunctionToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };
type BridgeChatCompletionTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
};
type BridgeChatCompletionToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };
type BridgeChatCompletionRequest = {
  model: string;
  messages: BridgeChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream_options?: Record<string, unknown>;
  tools?: BridgeChatCompletionTool[];
  tool_choice?: BridgeChatCompletionToolChoice;
  presence_penalty?: number;
  frequency_penalty?: number;
  n?: number;
  stop?: string | string[];
  user?: string;
  response_format?: Record<string, unknown>;
  seed?: number;
  parallel_tool_calls?: boolean;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  metadata?: Record<string, unknown>;
};
type BridgeChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: {
        role: "assistant";
        content: string | null;
        tool_calls?: BridgeChatCompletionFunctionToolCall[];
      };
      finish_reason: "stop" | "tool_calls";
    }
  ];
};
type BridgeMessageRequest = {
  sessionId?: string;
  input?: string;
  message?: string;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
};
type BridgeMessageResponse = {
  sessionId: string;
  output: string;
  outcome: {
    mode: "final" | "ask_user";
    steps: number;
  };
  provider: {
    id: string;
    model: string;
  };
  session: {
    providerBindingReused: boolean;
  };
  meta: {
    outputSanitized: boolean;
    sanitizationReason?: string;
    requestMetadata?: Record<string, unknown>;
    recovery: {
      softRetryCount: number;
      providerSessionResetCount: number;
    };
  };
};
type BridgeApiErrorResponse = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
type BridgeHealthResponse = {
  ok: true;
};
type BridgeReadyResponse = BridgeHealthResponse;

export type {
  BridgeApiErrorResponse,
  BridgeChatCompletionFunctionToolCall,
  BridgeChatCompletionMessage,
  BridgeChatCompletionRequest,
  BridgeChatCompletionResponse,
  BridgeChatCompletionTool,
  BridgeChatCompletionToolChoice,
  BridgeHealthResponse,
  BridgeMessageRequest,
  BridgeMessageResponse,
  BridgeReadyResponse
};
