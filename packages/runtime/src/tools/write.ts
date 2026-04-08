import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { RuntimeTool } from "../execution/types.ts";
import { executionTypesModule } from "../execution/types.ts";
import { runtimePathModule } from "./runtime-path.ts";
import { textFileModule } from "./text-file.ts";

const { ToolExecutionError } = executionTypesModule;
const { assertTextContent, MAX_FILE_WRITE_BYTES, writeTextFileAtomic } = textFileModule;
const { resolveRuntimePath } = runtimePathModule;
type WriteToolOptions = {
  runtimeRoot: string;
};
function createWriteTool(options: WriteToolOptions): RuntimeTool {
  return {
    definition: {
      name: "write",
      description: "Create or overwrite a UTF-8 text file on the local filesystem.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path or path relative to the runtime root."
          },
          content: {
            type: "string",
            description: "Full file contents to write."
          }
        },
        required: ["path", "content"]
      }
    },
    async execute(args) {
      const resolvedPath = await resolveRuntimePath(
        options.runtimeRoot,
        requireString(args, "path")
      );
      const content = requireString(args, "content");
      const bytesWritten = assertTextContent(content, resolvedPath, MAX_FILE_WRITE_BYTES);
      try {
        await mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeTextFileAtomic(resolvedPath, content);
        return {
          path: resolvedPath,
          bytesWritten
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        throw new ToolExecutionError(
          "io_error",
          `Unable to write file "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}
function requireString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value === "string") {
    return value;
  }
  throw new ToolExecutionError("invalid_arguments", `${key} must be a string.`);
}

export const writeModule = {
  createWriteTool
};
