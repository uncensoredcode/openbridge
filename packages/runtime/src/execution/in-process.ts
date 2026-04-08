import type { ToolCall } from "../protocol.ts";
import type {
  ExecutionRequest,
  ExecutionResponse,
  RuntimeTool,
  ToolDefinition,
  ToolExecutor
} from "./types.ts";
import { executionTypesModule } from "./types.ts";

const { ToolExecutionError, toolFailure } = executionTypesModule;
type InProcessToolExecutorOptions = {
  tools?: RuntimeTool[];
};
class InProcessToolExecutor implements ToolExecutor {
  readonly #toolsByName: Map<string, RuntimeTool>;
  constructor(options: InProcessToolExecutorOptions = {}) {
    this.#toolsByName = new Map((options.tools ?? []).map((tool) => [tool.definition.name, tool]));
  }
  async getAvailableTools(): Promise<ToolDefinition[]> {
    return [...this.#toolsByName.values()].map((tool) => tool.definition);
  }
  async executeTool(request: ExecutionRequest): Promise<ExecutionResponse> {
    return executeToolCall(this.#toolsByName, request.call);
  }
}
async function executeToolCall(
  toolsByName: Map<string, RuntimeTool>,
  call: ToolCall
): Promise<ExecutionResponse> {
  const tool = toolsByName.get(call.name);
  if (!tool) {
    return {
      ok: false,
      payload: toolFailure("tool_not_found", `Tool "${call.name}" is not registered.`)
    };
  }
  try {
    const payload = await tool.execute(call.args);
    return {
      ok: true,
      payload
    };
  } catch (error) {
    if (error instanceof ToolExecutionError) {
      return {
        ok: false,
        payload: toolFailure(error.code, error.message)
      };
    }
    return {
      ok: false,
      payload: toolFailure(
        "tool_execution_failed",
        error instanceof Error ? error.message : String(error)
      )
    };
  }
}

export const inProcessModule = {
  InProcessToolExecutor
};

export type { InProcessToolExecutor, InProcessToolExecutorOptions };
