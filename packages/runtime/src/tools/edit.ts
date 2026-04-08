import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { RuntimeTool } from "../execution/types.ts";
import { executionTypesModule } from "../execution/types.ts";
import { runtimePathModule } from "./runtime-path.ts";
import { textFileModule } from "./text-file.ts";

const { ToolExecutionError } = executionTypesModule;
const {
  assertTextContent,
  MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES,
  readTextFileWithinLimit,
  writeTextFileAtomic
} = textFileModule;
const { resolveRuntimePath } = runtimePathModule;
type EditToolOptions = {
  runtimeRoot: string;
};
function createEditTool(options: EditToolOptions): RuntimeTool {
  return {
    definition: {
      name: "edit",
      description: "Replace one exact text span in an existing UTF-8 text file.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path or path relative to the runtime root."
          },
          oldText: {
            type: "string",
            description: "Exact text to replace. Matching is whitespace-sensitive."
          },
          newText: {
            type: "string",
            description: "Replacement text."
          }
        },
        required: ["path", "oldText", "newText"]
      }
    },
    async execute(args) {
      const resolvedPath = await resolveRuntimePath(
        options.runtimeRoot,
        requireString(args, "path")
      );
      const oldText = requireString(args, "oldText");
      const newText = requireString(args, "newText", false);
      const { content } = await readTextFileWithinLimit({
        absolutePath: resolvedPath,
        relativePath: resolvedPath,
        maxBytes: MAX_FILE_READ_BYTES,
        operation: "read"
      });
      const matchCount = countExactOccurrences(content, oldText);
      if (matchCount === 0) {
        throw new ToolExecutionError("not_found", `Exact text was not found in "${resolvedPath}".`);
      }
      if (matchCount > 1) {
        throw new ToolExecutionError(
          "ambiguous_match",
          `Exact text matched ${matchCount} times in "${resolvedPath}". Refine oldText to one exact occurrence.`
        );
      }
      const nextContent = content.replace(oldText, newText);
      const bytesWritten = assertTextContent(nextContent, resolvedPath, MAX_FILE_WRITE_BYTES);
      try {
        await mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeTextFileAtomic(resolvedPath, nextContent);
        return {
          path: resolvedPath,
          replaced: 1,
          bytesWritten
        };
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        throw new ToolExecutionError(
          "io_error",
          `Unable to edit file "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}
function countExactOccurrences(content: string, search: string) {
  let count = 0;
  let startIndex = 0;
  while (true) {
    const matchIndex = content.indexOf(search, startIndex);
    if (matchIndex < 0) {
      return count;
    }
    count += 1;
    startIndex = matchIndex + search.length;
  }
}
function requireString(args: Record<string, unknown>, key: string, requireNonEmpty = true) {
  const value = args[key];
  if (typeof value !== "string") {
    throw new ToolExecutionError("invalid_arguments", `${key} must be a string.`);
  }
  if (requireNonEmpty && !value.length) {
    throw new ToolExecutionError("invalid_arguments", `${key} must be a non-empty string.`);
  }
  return value;
}

export const editModule = {
  createEditTool
};
