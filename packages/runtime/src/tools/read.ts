import type { RuntimeTool } from "../execution/types.ts";
import { executionTypesModule } from "../execution/types.ts";
import { runtimePathModule } from "./runtime-path.ts";
import { textFileModule } from "./text-file.ts";

const { ToolExecutionError } = executionTypesModule;
const { MAX_FILE_READ_BYTES, readTextFileWithinLimit } = textFileModule;
const { resolveRuntimePath } = runtimePathModule;
type ReadToolOptions = {
  runtimeRoot: string;
};
function createReadTool(options: ReadToolOptions): RuntimeTool {
  return {
    definition: {
      name: "read",
      description: "Read a UTF-8 text file from the local filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path or path relative to the runtime root."
          }
        },
        required: ["path"]
      }
    },
    async execute(args) {
      const resolvedPath = await resolveRuntimePath(
        options.runtimeRoot,
        requireString(args, "path")
      );
      try {
        const { content, bytes } = await readTextFileWithinLimit({
          absolutePath: resolvedPath,
          relativePath: resolvedPath,
          maxBytes: MAX_FILE_READ_BYTES,
          operation: "read"
        });
        return {
          path: resolvedPath,
          bytes,
          content
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        throw new ToolExecutionError(
          "io_error",
          `Unable to read file "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}
function requireString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ToolExecutionError("invalid_arguments", `${key} must be a non-empty string.`);
}

export const readModule = {
  createReadTool
};
