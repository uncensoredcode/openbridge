import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { executionTypesModule } from "../execution/types.ts";

const { ToolExecutionError } = executionTypesModule;
type ResolveWorkspacePathInput = {
  workspaceRoot: string;
  requestedPath: string;
  kind: "read" | "write";
};
type ResolvedWorkspacePath = {
  absolutePath: string;
  relativePath: string;
  workspaceRoot: string;
};
async function ensureWorkspaceRoot(workspaceRoot: string) {
  await mkdir(workspaceRoot, { recursive: true });
  return realpath(workspaceRoot);
}
async function resolveWorkspacePath(
  input: ResolveWorkspacePathInput
): Promise<ResolvedWorkspacePath> {
  const requestPath = input.requestedPath.trim();
  if (!requestPath) {
    throw new ToolExecutionError("invalid_arguments", "path must be a non-empty string.");
  }
  const canonicalRoot = await ensureWorkspaceRoot(input.workspaceRoot);
  const lexicalTarget = path.isAbsolute(requestPath)
    ? path.resolve(requestPath)
    : path.resolve(canonicalRoot, requestPath);
  assertWithinWorkspace(canonicalRoot, lexicalTarget);
  const canonicalTarget =
    input.kind === "read"
      ? await realpath(lexicalTarget).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            throw new ToolExecutionError("not_found", `File does not exist: ${requestPath}`);
          }
          throw error;
        })
      : await resolveWriteTarget(canonicalRoot, lexicalTarget);
  assertWithinWorkspace(canonicalRoot, canonicalTarget);
  return {
    absolutePath: canonicalTarget,
    relativePath: toWorkspaceRelativePath(canonicalRoot, canonicalTarget),
    workspaceRoot: canonicalRoot
  };
}
function assertWithinWorkspace(workspaceRoot: string, targetPath: string) {
  const relative = path.relative(workspaceRoot, targetPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new ToolExecutionError(
    "workspace_violation",
    `Path "${targetPath}" resolves outside the configured workspace root.`
  );
}
async function resolveWriteTarget(workspaceRoot: string, lexicalTarget: string) {
  const nearestExistingAncestor = await findNearestExistingAncestor(workspaceRoot, lexicalTarget);
  const canonicalAncestor = await realpath(nearestExistingAncestor);
  const suffix = path.relative(nearestExistingAncestor, lexicalTarget);
  return suffix ? path.resolve(canonicalAncestor, suffix) : canonicalAncestor;
}
async function findNearestExistingAncestor(workspaceRoot: string, lexicalTarget: string) {
  let cursor = lexicalTarget;
  while (true) {
    try {
      await realpath(cursor);
      return cursor;
    } catch (error) {
      const next = path.dirname(cursor);
      if (next === cursor || next.length < workspaceRoot.length) {
        throw error;
      }
      cursor = next;
    }
  }
}
function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string) {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative || ".";
}

export const workspacePathModule = {
  ensureWorkspaceRoot,
  resolveWorkspacePath
};

export type { ResolvedWorkspacePath };
