import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import type { RuntimeTool } from "../execution/types.ts";
import { executionTypesModule } from "../execution/types.ts";
import { textFileModule } from "./text-file.ts";
import { workspacePathModule } from "./workspace-path.ts";

const { ToolExecutionError } = executionTypesModule;
const { MAX_LIST_DIR_ENTRIES } = textFileModule;
const { resolveWorkspacePath } = workspacePathModule;
type ListDirToolOptions = {
  workspaceRoot: string;
};
function createListDirTool(options: ListDirToolOptions): RuntimeTool {
  return {
    definition: {
      name: "list_dir",
      description:
        "List one workspace directory without recursion. Returns compact metadata for each entry.",
      inputSchema: {
        type: "object",
        properties: {
          include_hidden: {
            type: "boolean",
            description: "Include dotfiles and dot-directories when true. Defaults to false."
          },
          path: {
            type: "string",
            description:
              "Workspace-relative directory path to inspect. Defaults to the workspace root."
          }
        },
        required: []
      }
    },
    async execute(args) {
      const target = await resolveWorkspacePath({
        workspaceRoot: options.workspaceRoot,
        requestedPath: optionalString(args, "path") ?? ".",
        kind: "read"
      });
      const includeHidden = optionalBoolean(args, "include_hidden", false);
      try {
        const entries = await readdir(target.absolutePath, { withFileTypes: true });
        const visibleEntries = entries
          .filter((entry) => includeHidden || !entry.name.startsWith("."))
          .sort(compareDirectoryEntries);
        const limitedEntries = visibleEntries.slice(0, MAX_LIST_DIR_ENTRIES);
        const results = await Promise.all(
          limitedEntries.map(async (entry) => {
            const entryPath = path.join(target.absolutePath, entry.name);
            const stats = await lstat(entryPath);
            return {
              name: entry.name,
              relative_path: path.relative(target.workspaceRoot, entryPath) || ".",
              type: getEntryType(stats),
              size: stats.size
            };
          })
        );
        return {
          path: target.relativePath,
          truncated: visibleEntries.length > MAX_LIST_DIR_ENTRIES,
          entries: results
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
          throw new ToolExecutionError(
            "invalid_type",
            `Path "${target.relativePath}" is not a directory.`
          );
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolExecutionError(
            "not_found",
            `Directory does not exist: ${target.relativePath}`
          );
        }
        throw new ToolExecutionError(
          "io_error",
          `Unable to list directory "${target.relativePath}": ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
}
function compareDirectoryEntries(
  left: {
    name: string;
    isDirectory(): boolean;
  },
  right: {
    name: string;
    isDirectory(): boolean;
  }
) {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }
  return compareNames(left.name, right.name);
}
function compareNames(left: string, right: string) {
  const leftKey = left.toLowerCase();
  const rightKey = right.toLowerCase();
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
function getEntryType(stats: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}) {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "dir";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}
function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new ToolExecutionError("invalid_arguments", `${key} must be a string.`);
}
function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean) {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  throw new ToolExecutionError("invalid_arguments", `${key} must be a boolean.`);
}

export const listDirModule = {
  createListDirTool
};
