import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimeTool } from "../execution/types.ts";
import { executionTypesModule } from "../execution/types.ts";

const { ToolExecutionError } = executionTypesModule;
const execFileAsync = promisify(execFile);
const MAX_STDIO_BYTES = 64 * 1024;
type BashToolOptions = {
  runtimeRoot: string;
};
function createBashTool(options: BashToolOptions): RuntimeTool {
  return {
    definition: {
      name: "bash",
      description:
        "Run a shell command on the local system. Short-lived commands run synchronously. Long-running commands such as dev servers, watchers, and persistent processes start detached and return their pid and log path immediately.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute."
          },
          description: {
            type: "string",
            description: "Optional short explanation of what the command does."
          },
          cwd: {
            type: "string",
            description: "Optional working directory. Absolute paths are allowed."
          }
        },
        required: ["command"]
      }
    },
    async execute(args) {
      const command = requireNonEmptyString(args, "command");
      const cwd = resolveCwd(args.cwd, options.runtimeRoot);
      if (isLikelyLongRunningBashCommand(command)) {
        return startDetachedProcess(command, cwd, options.runtimeRoot);
      }
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
          cwd,
          timeout: getExecTimeoutMs(),
          maxBuffer: 1024 * 1024
        });
        return {
          command,
          cwd,
          exitCode: 0,
          timedOut: false,
          stdout: truncate(stdout),
          stderr: truncate(stderr)
        };
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        const execError = error as Error & {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          signal?: NodeJS.Signals;
          killed?: boolean;
        };
        return {
          command,
          cwd,
          exitCode: typeof execError.code === "number" ? execError.code : null,
          signal: execError.signal ?? null,
          timedOut: execError.killed === true && execError.signal === "SIGTERM",
          stdout: truncate(execError.stdout ?? ""),
          stderr: truncate(execError.stderr ?? execError.message)
        };
      }
    }
  };
}
function requireNonEmptyString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ToolExecutionError("invalid_arguments", `${key} must be a non-empty string.`);
}
function resolveCwd(rawValue: unknown, runtimeRoot: string) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return runtimeRoot;
  }
  return path.isAbsolute(rawValue) ? path.resolve(rawValue) : path.resolve(runtimeRoot, rawValue);
}
function truncate(value: string) {
  return value.length > MAX_STDIO_BYTES ? `${value.slice(0, MAX_STDIO_BYTES)}\n[truncated]` : value;
}
function getExecTimeoutMs() {
  return Number(process.env.BRIDGE_TOOL_EXEC_TIMEOUT_MS ?? 30000);
}
function isLikelyLongRunningBashCommand(command: string) {
  return [
    /\bpython3?\s+-m\s+http\.server\b/u,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b/u,
    /\bnext\s+dev\b/u,
    /\bvite\b/u,
    /\bwebpack(?:-dev-server)?\s+serve\b/u,
    /\bserve\b/u,
    /\blive-server\b/u,
    /\bnodemon\b/u,
    /\buvicorn\b/u,
    /\bflask\s+run\b/u,
    /\brails\s+server\b/u,
    /\bcargo\s+watch\b/u,
    /\btail\s+-f\b/u,
    /\bwatch\s+/u,
    /\bsleep\s+(?:infinity|\d{3,})\b/u
  ].some((pattern) => pattern.test(command));
}
function startDetachedProcess(command: string, cwd: string, runtimeRoot: string) {
  const startedAt = new Date().toISOString();
  const processRoot = ensureDetachedProcessRoot(runtimeRoot);
  const processId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const logPath = path.join(processRoot, `${processId}.log`);
  appendFileSync(logPath, `[bridge bash detached] ${startedAt}\n$ ${command}\n\n`, "utf8");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    child.unref();
    return {
      command,
      cwd,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      detached: true,
      pid: child.pid ?? null,
      logPath,
      startedAt
    };
  } finally {
    closeSync(logFd);
  }
}
function ensureDetachedProcessRoot(runtimeRoot: string) {
  const root = path.join(resolveDetachedProcessBase(runtimeRoot), "bridge-tool-processes");
  mkdirSync(root, {
    recursive: true
  });
  return root;
}
function resolveDetachedProcessBase(runtimeRoot: string) {
  if (runtimeRoot.trim()) {
    return runtimeRoot;
  }
  return os.tmpdir();
}

export const bashModule = {
  createBashTool
};
