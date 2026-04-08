import crypto from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";
import { ZodError } from "zod";

import type { LiveProviderExtractionCanaryInput } from "../bridge/index.ts";
import { bridgeModule } from "../bridge/index.ts";
import type { BridgeApiClientFetch } from "../client/index.ts";
import { clientModule } from "../client/index.ts";
import type { BridgeServerConfig } from "../config/index.ts";
import { configModule } from "../config/index.ts";
import { httpModule } from "../http/index.ts";
import { securityModule } from "../security/index.ts";

const { createBridgeChatCompletion, DEFAULT_BRIDGE_API_BASE_URL, streamBridgeChatCompletion } =
  clientModule;
const { getBridgeServerStartupWarnings, loadBridgeServerConfig } = configModule;
const {
  clearLocalSessionVault,
  formatLiveProviderExtractionCanaryResult,
  runLiveProviderExtractionCanary
} = bridgeModule;
const { sanitizeSensitiveText } = securityModule;
const { startBridgeApiServer } = httpModule;
type BridgeServerCliCommand =
  | {
      kind: "help";
    }
  | {
      kind: "serve";
      config: BridgeServerConfig;
    }
  | {
      kind: "clear-session-vault";
      config: BridgeServerConfig;
    }
  | {
      kind: "chat";
      baseUrl: string;
      model: string;
      message: string;
      system?: string;
      stream: boolean;
    }
  | ({
      kind: "live-canary";
    } & LiveProviderExtractionCanaryInput);
type RunBridgeServerCliInput = {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: {
    write(value: string): void;
  };
  stderr?: {
    write(value: string): void;
  };
  stdin?: NodeJS.ReadStream;
  startServer?: typeof startBridgeApiServer;
  onServerStarted?: (server: Awaited<ReturnType<typeof startBridgeApiServer>>) => void;
  runLiveCanary?: typeof runLiveProviderExtractionCanary;
  fetchImpl?: BridgeApiClientFetch;
  promptForVaultKey?: (context: { keyPath: string; stdin: NodeJS.ReadStream }) => Promise<string>;
};
async function runBridgeServerCli(input: RunBridgeServerCliInput): Promise<number> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const stdin = input.stdin ?? process.stdin;
  const startServer = input.startServer ?? startBridgeApiServer;
  const runLiveCanary = input.runLiveCanary ?? runLiveProviderExtractionCanary;
  let command: BridgeServerCliCommand;
  try {
    command = parseBridgeServerCliArgs({
      argv: input.argv,
      env: input.env
    });
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (command.kind === "help") {
    stdout.write(`${getBridgeServerCliHelpText()}\n`);
    return 0;
  }
  try {
    if (command.kind === "chat") {
      const messages = [
        command.system
          ? {
              role: "system" as const,
              content: command.system
            }
          : null,
        {
          role: "user" as const,
          content: command.message
        }
      ].filter(
        (
          message
        ): message is {
          role: "system" | "user";
          content: string;
        } => message !== null
      );
      if (command.stream) {
        const contentStream = await streamBridgeChatCompletion({
          baseUrl: command.baseUrl,
          model: command.model,
          messages,
          fetchImpl: input.fetchImpl
        });
        for await (const chunk of contentStream) {
          stdout.write(chunk);
        }
        stdout.write("\n");
        return 0;
      }
      const response = await createBridgeChatCompletion({
        baseUrl: command.baseUrl,
        model: command.model,
        messages,
        fetchImpl: input.fetchImpl
      });
      const content = response.choices[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("Bridge chat completion response did not include assistant text.");
      }
      stdout.write(`${content}\n`);
      return 0;
    }
    if (command.kind === "live-canary") {
      const result = await runLiveCanary(command);
      const stream = result.ok ? stdout : stderr;
      stream.write(`${formatLiveProviderExtractionCanaryResult(result)}\n`);
      return result.ok ? 0 : 1;
    }
    if (command.kind === "clear-session-vault") {
      const sessionVaultPath = requireConfigPath(
        command.config.sessionVaultPath,
        "sessionVaultPath"
      );
      clearLocalSessionVault({
        vaultPath: sessionVaultPath
      });
      stdout.write(`Emptied session vault at ${sessionVaultPath}\n`);
      return 0;
    }
    for (const warning of getBridgeServerStartupWarnings(command.config)) {
      stderr.write(`Warning: ${warning}\n`);
    }
    if (command.kind === "serve") {
      command = {
        ...command,
        config: await ensureCliVaultKey(command.config, {
          env: input.env ?? process.env,
          stdin,
          stdout,
          stderr,
          promptForVaultKey: input.promptForVaultKey
        })
      };
    }
    const server = await startServer({
      config: command.config
    });
    input.onServerStarted?.(server);
    const address = server.address();
    if (typeof address === "object" && address) {
      stdout.write(`Bridge server listening on http://${address.address}:${address.port}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}
function parseBridgeServerCliArgs(input: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
}): BridgeServerCliCommand {
  const env = input.env ?? process.env;
  const args = [...input.argv];
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return {
      kind: "help"
    };
  }
  let parsedCommand: BridgeServerCliCommand | null = null;
  const program = buildBridgeServerCliProgram(env, {
    onStart(options) {
      parsedCommand = {
        kind: "serve",
        config: loadBridgeServerConfig(env, {
          host: optionalNonEmptyString(options.host, "host") ?? undefined,
          port: options.port,
          authToken: optionalNonEmptyString(options.token, "token") ?? undefined
        })
      };
    },
    onChat(options) {
      parsedCommand = {
        kind: "chat",
        baseUrl: optionalNonEmptyString(options.baseUrl, "base-url") ?? DEFAULT_BRIDGE_API_BASE_URL,
        model: requireNonEmptyString(options.model, "model"),
        message: requireNonEmptyString(options.message, "message"),
        system: optionalNonEmptyString(options.system, "system") ?? undefined,
        stream: options.stream === true
      };
    },
    onLiveCanary(options) {
      const providerId = optionalNonEmptyString(options.provider, "provider");
      const modelId = optionalNonEmptyString(options.model, "model");
      const prompt = optionalNonEmptyString(options.prompt, "prompt");
      const expectedSubstring = optionalNonEmptyString(
        options.expectedSubstring,
        "expected-substring"
      );
      const config = loadBridgeServerConfig(env, {
        stateRoot: optionalNonEmptyString(options.stateRoot, "state-root") ?? undefined,
        defaultProvider: providerId ?? undefined,
        defaultModel: modelId ?? undefined
      });
      parsedCommand = {
        kind: "live-canary",
        config,
        stateRoot: config.stateRoot,
        providerId: providerId ?? undefined,
        modelId: modelId ?? undefined,
        prompt: prompt ?? undefined,
        expectedSubstring: expectedSubstring ?? undefined
      };
    },
    onClearSessionVault(options) {
      parsedCommand = {
        kind: "clear-session-vault",
        config: loadBridgeServerConfig(env, {
          stateRoot: optionalNonEmptyString(options.stateRoot, "state-root") ?? undefined,
          sessionVaultPath:
            optionalNonEmptyString(options.sessionVaultPath, "session-vault-path") ?? undefined
        })
      };
    }
  });
  const normalizedArgv = args.length === 0 || args[0]?.startsWith("--") ? ["start", ...args] : args;
  try {
    program.parse(normalizedArgv, {
      from: "user"
    });
  } catch (error) {
    throw normalizeCommanderError(error);
  }
  if (!parsedCommand) {
    throw new Error("No openbridge command was selected.");
  }
  return parsedCommand;
}
function getBridgeServerCliHelpText() {
  return buildBridgeServerCliProgram(process.env).helpInformation();
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
function requireNonEmptyString(value: string | undefined, key: string) {
  const normalized = optionalNonEmptyString(value, key);
  if (!normalized) {
    throw new Error(`${key} is required.`);
  }
  return normalized;
}
function formatCliError(error: unknown) {
  if (error instanceof ZodError) {
    return sanitizeSensitiveText(
      error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")
    );
  }
  return sanitizeSensitiveText(error instanceof Error ? error.message : String(error));
}
type StartCommandOptions = {
  host?: string;
  port?: string;
  token?: string;
};
type ChatCommandOptions = {
  baseUrl?: string;
  model?: string;
  message?: string;
  system?: string;
  stream?: boolean;
};
type LiveCanaryCommandOptions = {
  stateRoot?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  expectedSubstring?: string;
};
type ClearSessionVaultCommandOptions = {
  stateRoot?: string;
  sessionVaultPath?: string;
};
function buildBridgeServerCliProgram(
  env: NodeJS.ProcessEnv,
  handlers: {
    onStart?: (options: StartCommandOptions) => void;
    onChat?: (options: ChatCommandOptions) => void;
    onLiveCanary?: (options: LiveCanaryCommandOptions) => void;
    onClearSessionVault?: (options: ClearSessionVaultCommandOptions) => void;
  } = {}
) {
  const program = new Command();
  program
    .name("openbridge")
    .description("Server-side openbridge commands.")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut() {},
      writeErr() {}
    });
  program
    .command("start")
    .description("Start the standalone bridge HTTP server.")
    .option("--host <host>", "Bind host", trimOrUndefined(env.BRIDGE_SERVER_HOST) ?? "127.0.0.1")
    .option("--port <port>", "Bind port", trimOrUndefined(env.BRIDGE_SERVER_PORT))
    .option(
      "--token <token>",
      "Optional local bridge auth token",
      trimOrUndefined(env.BRIDGE_AUTH_TOKEN)
    )
    .action((options: StartCommandOptions) => {
      handlers.onStart?.(options);
    });
  program
    .command("chat")
    .description("Send a chat completion request through the standalone bridge HTTP API.")
    .requiredOption("--model <id>", "Model id")
    .requiredOption("--message <text>", "User message")
    .option("--system <text>", "Optional system message")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .option("--stream", "Stream assistant text deltas")
    .action((options: ChatCommandOptions) => {
      handlers.onChat?.(options);
    });
  program
    .command("live-canary")
    .description("Run the live provider extraction canary through the standalone bridge runtime.")
    .option("--state-root <path>", "State root for bridge artifacts")
    .option("--provider <id>", "Provider id")
    .option("--model <id>", "Model id")
    .option("--prompt <text>", "Prompt to send to the provider")
    .option("--expected-substring <text>", "Substring expected in the extracted output")
    .action((options: LiveCanaryCommandOptions) => {
      handlers.onLiveCanary?.({
        ...options,
        stateRoot: options.stateRoot ? path.resolve(options.stateRoot) : undefined
      });
    });
  program
    .command("clear-session-vault")
    .description("Remove all stored session packages from the local session vault.")
    .option("--state-root <path>", "State root for bridge artifacts")
    .option("--session-vault-path <path>", "Session vault path override")
    .action((options: ClearSessionVaultCommandOptions) => {
      handlers.onClearSessionVault?.({
        ...options,
        stateRoot: options.stateRoot ? path.resolve(options.stateRoot) : undefined,
        sessionVaultPath: options.sessionVaultPath
          ? path.resolve(options.sessionVaultPath)
          : undefined
      });
    });
  return program;
}
function normalizeCommanderError(error: unknown) {
  if (error instanceof Error && "code" in error) {
    const code = String(error.code);
    if (code === "commander.helpDisplayed") {
      return new Error(getBridgeServerCliHelpText());
    }
  }
  return error;
}
function trimOrUndefined(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
async function ensureCliVaultKey(
  config: BridgeServerConfig,
  input: {
    env: NodeJS.ProcessEnv;
    stdin: NodeJS.ReadStream;
    stdout: {
      write(value: string): void;
    };
    stderr: {
      write(value: string): void;
    };
    promptForVaultKey?: RunBridgeServerCliInput["promptForVaultKey"];
  }
) {
  const sessionVaultKeyPath = requireConfigPath(config.sessionVaultKeyPath, "sessionVaultKeyPath");
  if (trimOrUndefined(input.env.BRIDGE_SESSION_VAULT_KEY)) {
    return config;
  }
  const existingKey = await readOptionalFile(sessionVaultKeyPath);
  if (existingKey) {
    return config;
  }
  if (!input.stdin.isTTY) {
    throw new Error(
      `Session vault key is required. Set BRIDGE_SESSION_VAULT_KEY or place a base64 32-byte key at ${sessionVaultKeyPath}.`
    );
  }
  const promptForVaultKey = input.promptForVaultKey ?? defaultPromptForVaultKey;
  const provided = (
    await promptForVaultKey({
      keyPath: sessionVaultKeyPath,
      stdin: input.stdin
    })
  ).trim();
  if (provided) {
    input.env.BRIDGE_SESSION_VAULT_KEY = provided;
    process.env.BRIDGE_SESSION_VAULT_KEY = provided;
    return loadBridgeServerConfig(input.env, config);
  }
  const generated = crypto.randomBytes(32).toString("base64");
  await mkdir(path.dirname(sessionVaultKeyPath), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(sessionVaultKeyPath, `${generated}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(sessionVaultKeyPath, 0o600);
  input.stderr.write(`Generated session vault key at ${sessionVaultKeyPath}\n`);
  return config;
}
async function defaultPromptForVaultKey(input: { keyPath: string; stdin: NodeJS.ReadStream }) {
  const readline = createInterface({
    input: input.stdin,
    output: process.stdout,
    terminal: true
  });
  try {
    return await readline.question(
      `Session vault key is not configured.\nPaste a base64 32-byte key, or press Enter to generate one at ${input.keyPath}: `
    );
  } finally {
    readline.close();
  }
}
async function readOptionalFile(targetPath: string) {
  try {
    const value = (await readFile(targetPath, "utf8")).trim();
    return value || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
function requireConfigPath(value: string | undefined, key: string) {
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

export const runBridgeServerCliModule = {
  runBridgeServerCli,
  parseBridgeServerCliArgs,
  getBridgeServerCliHelpText
};

export type { BridgeServerCliCommand, RunBridgeServerCliInput };
