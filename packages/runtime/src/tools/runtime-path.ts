import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { executionTypesModule } from "../execution/types.ts";

const { ToolExecutionError } = executionTypesModule;
async function ensureRuntimeRoot(runtimeRoot: string) {
  await mkdir(runtimeRoot, { recursive: true });
  return realpath(runtimeRoot);
}
async function resolveRuntimePath(runtimeRoot: string, requestedPath: string) {
  const normalizedPath = requestedPath.trim();
  if (!normalizedPath) {
    throw new ToolExecutionError("invalid_arguments", "path must be a non-empty string.");
  }
  const basePath = await ensureRuntimeRoot(runtimeRoot);
  return path.isAbsolute(normalizedPath)
    ? path.resolve(normalizedPath)
    : path.resolve(basePath, normalizedPath);
}

export const runtimePathModule = {
  ensureRuntimeRoot,
  resolveRuntimePath
};
