import type { BridgeApiToolProfile } from "@uncensoredcode/openbridge/server";

type BridgeCliCommand =
  | {
      kind: "help";
    }
  | {
      kind: "health";
      baseUrl: string;
    }
  | {
      kind: "server";
      argv: string[];
    }
  | {
      kind: "send";
      baseUrl: string;
      sessionId: string;
      input: string;
      provider?: string;
      model?: string;
      metadata?: Record<string, unknown>;
      toolProfile?: BridgeApiToolProfile;
    };
type ParseBridgeCliArgsInput = {
  argv: string[];
  env?: NodeJS.ProcessEnv;
};
const DEFAULT_BASE_URL = "http://127.0.0.1:4318";
const SERVER_SUBCOMMANDS = new Set([
  "start",
  "status",
  "stop",
  "logs",
  "chat",
  "live-canary",
  "clear-session-vault",
  "providers",
  "models",
  "sessions"
]);
function parseBridgeCliArgs(input: ParseBridgeCliArgsInput): BridgeCliCommand {
  const env = input.env ?? process.env;
  const args = [...input.argv];
  const command = args[0];
  if (args.length === 0) {
    return {
      kind: "help"
    };
  }
  if (command && SERVER_SUBCOMMANDS.has(command)) {
    return {
      kind: "server",
      argv: args
    };
  }
  if (
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    return {
      kind: "help"
    };
  }
  if (command === "health") {
    const { options, positionals } = parseFlags(args.slice(1));
    if (positionals.length > 0) {
      throw new Error("health does not accept positional arguments.");
    }
    return {
      kind: "health",
      baseUrl: readBaseUrl(options.baseUrl, env)
    };
  }
  const { options, positionals } = parseFlags(args);
  const sessionId = requireNonEmptyString(options.session, "session");
  const inputText = readInput(options.input, positionals);
  const metadata = readMetadata(options.metadata);
  const toolProfile = readToolProfile(options.toolProfile);
  return {
    kind: "send",
    baseUrl: readBaseUrl(options.baseUrl, env),
    sessionId,
    input: inputText,
    provider: optionalNonEmptyString(options.provider, "provider") ?? undefined,
    model: optionalNonEmptyString(options.model, "model") ?? undefined,
    metadata,
    toolProfile
  };
}
function getBridgeCliHelpText() {
  return [
    "openbridge",
    "",
    "Usage:",
    "  openbridge start [--host <host>] [--port <port>] [--token <token>] [--foreground]",
    "  openbridge status [--state-root <path>]",
    "  openbridge stop [--state-root <path>]",
    "  openbridge logs [--follow] [--lines <count>] [--state-root <path>]",
    "  openbridge health [--base-url <url>]",
    "  openbridge providers <list|get|add|remove|enable|disable|import-session|session-status|clear-session> ...",
    "  openbridge models <list|add> ...",
    "  openbridge sessions <list|get|remove> ...",
    "  openbridge --session <id> [--input <text>] [--base-url <url>] [--provider <id>] [--model <id>] [--metadata <json>]",
    "  openbridge chat --model <id> --message <text> [--system <text>] [--base-url <url>] [--stream]",
    "  openbridge live-canary [--state-root <path>] [--provider <id>] [--model <id>]",
    "  openbridge clear-session-vault [--state-root <path>] [--session-vault-path <path>]",
    "",
    "Examples:",
    "  openbridge start",
    "  openbridge status",
    "  openbridge logs --follow",
    "  openbridge health",
    "  openbridge providers list",
    "  openbridge providers import-session provider-a --file ./session-package.json",
    '  openbridge --session demo "Read README.md"',
    '  openbridge --base-url http://127.0.0.1:4318 --session s1 --input "Run git status"'
  ].join("\n");
}
function parseFlags(argv: string[]) {
  const options: Record<string, string | undefined> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    options[toOptionKey(key)] = next;
    index += 1;
  }
  return {
    options,
    positionals
  };
}
function toOptionKey(value: string) {
  return value.replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
}
function readBaseUrl(value: string | undefined, env: NodeJS.ProcessEnv) {
  return (
    optionalNonEmptyString(value, "base-url") ??
    optionalNonEmptyString(env.BRIDGE_API_BASE_URL, "BRIDGE_API_BASE_URL") ??
    optionalNonEmptyString(env.BRIDGE_SERVER_BASE_URL, "BRIDGE_SERVER_BASE_URL") ??
    DEFAULT_BASE_URL
  );
}
function readInput(flagValue: string | undefined, positionals: string[]) {
  const flagInput = optionalNonEmptyString(flagValue, "input");
  const positionalInput = positionals.length > 0 ? positionals.join(" ") : null;
  if (flagInput && positionalInput && flagInput !== positionalInput) {
    throw new Error("Provide input either with --input or as a positional argument, not both.");
  }
  const resolved = flagInput ?? positionalInput;
  if (!resolved?.trim()) {
    throw new Error("input is required.");
  }
  return resolved;
}
function readMetadata(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("metadata must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
function readToolProfile(value: string | undefined): BridgeApiToolProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "default" || value === "workspace") {
    return value;
  }
  throw new Error('toolProfile must be either "default" or "workspace".');
}
function requireNonEmptyString(value: string | undefined, key: string) {
  const normalized = optionalNonEmptyString(value, key);
  if (!normalized) {
    throw new Error(`${key} is required.`);
  }
  return normalized;
}
function optionalNonEmptyString(value: string | undefined, key: string) {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return trimmed;
}

export const argsModule = {
  parseBridgeCliArgs,
  getBridgeCliHelpText
};

export type { BridgeCliCommand, ParseBridgeCliArgsInput };
