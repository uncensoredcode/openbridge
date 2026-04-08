import { readdir } from "node:fs/promises";
import path from "node:path";

import type { RuntimeTool } from "../execution/types.ts";
import { executionTypesModule } from "../execution/types.ts";
import { textFileModule } from "./text-file.ts";
import { workspacePathModule } from "./workspace-path.ts";

const { ToolExecutionError } = executionTypesModule;
const { MAX_SEARCH_FILE_BYTES, MAX_SEARCH_RESULTS, readTextFileWithinLimit, truncateSnippet } =
  textFileModule;
const { ensureWorkspaceRoot } = workspacePathModule;
type SearchFilesToolOptions = {
  workspaceRoot: string;
};
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage"
]);
function createSearchFilesTool(options: SearchFilesToolOptions): RuntimeTool {
  return {
    definition: {
      name: "search_files",
      description: "Search UTF-8 text files in the workspace for a literal query string.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Literal text to search for across workspace files."
          }
        },
        required: ["query"]
      }
    },
    async execute(args) {
      const query = requireQuery(args);
      const workspaceRoot = await ensureWorkspaceRoot(options.workspaceRoot);
      const results: Array<{
        relative_path: string;
        line_number: number;
        snippet: string;
      }> = [];
      let truncated = false;
      await walkWorkspace(workspaceRoot, workspaceRoot, query, results, () => {
        truncated = true;
      });
      return {
        query,
        truncated,
        results
      };
    }
  };
}
async function walkWorkspace(
  workspaceRoot: string,
  currentDirectory: string,
  query: string,
  results: Array<{
    relative_path: string;
    line_number: number;
    snippet: string;
  }>,
  onLimitReached: () => void
): Promise<void> {
  const entries = (await readdir(currentDirectory, { withFileTypes: true })).sort(compareEntries);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(currentDirectory, entry.name);
    const relativePath = path.relative(workspaceRoot, entryPath) || ".";
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      await walkWorkspace(workspaceRoot, entryPath, query, results, onLimitReached);
      if (results.length >= MAX_SEARCH_RESULTS) {
        onLimitReached();
        return;
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const matches = await searchFile(relativePath, entryPath, query);
    for (const match of matches) {
      results.push(match);
      if (results.length >= MAX_SEARCH_RESULTS) {
        onLimitReached();
        return;
      }
    }
  }
}
async function searchFile(relativePath: string, absolutePath: string, query: string) {
  try {
    const { content } = await readTextFileWithinLimit({
      absolutePath,
      relativePath,
      maxBytes: MAX_SEARCH_FILE_BYTES,
      operation: "search"
    });
    const lines = content.split(/\r?\n/u);
    const matches: Array<{
      relative_path: string;
      line_number: number;
      snippet: string;
    }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]?.includes(query)) {
        continue;
      }
      matches.push({
        relative_path: relativePath,
        line_number: index + 1,
        snippet: truncateSnippet(lines[index] ?? "")
      });
    }
    return matches;
  } catch (error) {
    if (
      error instanceof ToolExecutionError &&
      (error.code === "binary_file" ||
        error.code === "file_too_large" ||
        error.code === "invalid_type")
    ) {
      return [];
    }
    throw error;
  }
}
function compareEntries(
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
function requireQuery(args: Record<string, unknown>) {
  const value = args.query;
  if (typeof value !== "string") {
    throw new ToolExecutionError("invalid_arguments", "query must be a string.");
  }
  const query = value.trim();
  if (!query) {
    throw new ToolExecutionError("invalid_arguments", "query must be a non-empty string.");
  }
  return query;
}

export const searchFilesModule = {
  createSearchFilesTool
};
