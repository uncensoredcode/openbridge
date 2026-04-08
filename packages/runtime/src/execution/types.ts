import type { ToolCall } from "../protocol.ts";

type ToolSchema = {
  type: "object";
  properties: Record<
    string,
    {
      type: "string" | "boolean";
      description: string;
    }
  >;
  required: string[];
};
type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
};
type ToolFailurePayload = {
  error: {
    code: string;
    message: string;
  };
};
type ToolExecutionResult =
  | {
      ok: true;
      payload: unknown;
    }
  | {
      ok: false;
      payload: ToolFailurePayload;
    };
type ExecutionRequest = {
  call: ToolCall;
};
type ExecutionResponse = ToolExecutionResult;
interface ToolExecutor {
  getAvailableTools(): Promise<ToolDefinition[]>;
  executeTool(request: ExecutionRequest): Promise<ExecutionResponse>;
}
type RuntimeTool = {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<unknown>;
};
class ToolExecutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}
function toolFailure(code: string, message: string): ToolFailurePayload {
  return {
    error: {
      code,
      message
    }
  };
}

export const executionTypesModule = {
  ToolExecutionError,
  toolFailure
};

export type {
  ExecutionRequest,
  ExecutionResponse,
  RuntimeTool,
  ToolDefinition,
  ToolExecutionError,
  ToolExecutionResult,
  ToolExecutor,
  ToolFailurePayload,
  ToolSchema
};
