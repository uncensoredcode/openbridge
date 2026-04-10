import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
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

const {
  createBridgeChatCompletion,
  createBridgeModel,
  createBridgeProvider,
  DEFAULT_BRIDGE_API_BASE_URL,
  deleteBridgeProvider,
  deleteBridgeProviderSessionPackage,
  deleteBridgeSession,
  getBridgeProvider,
  getBridgeProviderSessionPackage,
  getBridgeSession,
  listBridgeModels,
  listBridgeProviders,
  listBridgeSessions,
  putBridgeProviderSessionPackage,
  streamBridgeChatCompletion,
  updateBridgeProvider,
  checkBridgeHealth
} = clientModule;
const { getBridgeServerStartupWarnings, loadBridgeServerConfig } = configModule;
const {
  clearLocalSessionVault,
  formatLiveProviderExtractionCanaryResult,
  runLiveProviderExtractionCanary
} = bridgeModule;
const { sanitizeSensitiveText } = securityModule;
const { startBridgeApiServer } = httpModule;

const DEFAULT_LOG_TAIL_LINES = 50;
const DAEMON_READY_TIMEOUT_MS = 4_000;
const DAEMON_POLL_INTERVAL_MS = 100;
const STOP_TIMEOUT_MS = 5_000;
const LOG_FOLLOW_POLL_INTERVAL_MS = 250;

type BridgeServerCliCommand =
  | {
      kind: "help";
    }
  | {
      kind: "serve";
      config: BridgeServerConfig;
      foreground: boolean;
    }
  | {
      kind: "status";
      config: BridgeServerConfig;
    }
  | {
      kind: "stop";
      config: BridgeServerConfig;
    }
  | {
      kind: "logs";
      config: BridgeServerConfig;
      follow: boolean;
      lines: number;
    }
  | {
      kind: "providers-list";
      baseUrl: string;
    }
  | {
      kind: "providers-get";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "providers-add";
      baseUrl: string;
      id: string;
      providerKind: string;
      label: string;
      enabled: boolean;
      config: Record<string, unknown> | undefined;
    }
  | {
      kind: "providers-remove";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "providers-enable";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "providers-disable";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "providers-import-session";
      baseUrl: string;
      id: string;
      filePath?: string;
    }
  | {
      kind: "providers-session-status";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "providers-clear-session";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "models-list";
      baseUrl: string;
    }
  | {
      kind: "models-add";
      baseUrl: string;
      provider: string;
      model: string;
    }
  | {
      kind: "sessions-list";
      baseUrl: string;
    }
  | {
      kind: "sessions-get";
      baseUrl: string;
      id: string;
    }
  | {
      kind: "sessions-remove";
      baseUrl: string;
      id: string;
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
  spawnDetachedServerProcess?: (
    input: SpawnDetachedServerProcessInput
  ) => Promise<SpawnDetachedServerProcessResult>;
};

type SpawnDetachedServerProcessInput = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  logPath: string;
  cwd: string;
};

type SpawnDetachedServerProcessResult = {
  pid: number;
};

type DetachedServerLaunchCommand = {
  command: string;
  args: string[];
};

type StartCommandOptions = {
  host?: string;
  port?: string;
  token?: string;
  stateRoot?: string;
  runtimeRoot?: string;
  foreground?: boolean;
};

type LifecycleCommandOptions = {
  host?: string;
  port?: string;
  stateRoot?: string;
  runtimeRoot?: string;
};

type LogsCommandOptions = LifecycleCommandOptions & {
  follow?: boolean;
  lines?: string;
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

type BaseUrlCommandOptions = {
  baseUrl?: string;
};

type ProviderAddCommandOptions = BaseUrlCommandOptions & {
  id?: string;
  kind?: string;
  label?: string;
  disable?: boolean;
  config?: string;
};

type ProviderImportSessionCommandOptions = BaseUrlCommandOptions & {
  file?: string;
};

type ModelAddCommandOptions = BaseUrlCommandOptions & {
  provider?: string;
  model?: string;
};

type ServerProcessFiles = {
  logPath: string;
  logRoot: string;
  statePath: string;
  runRoot: string;
};

type ServerProcessState = {
  pid: number;
  baseUrl: string;
  host: string;
  port: number;
  logPath: string;
  startedAt: string;
  stateRoot: string;
};

async function runBridgeServerCli(input: RunBridgeServerCliInput): Promise<number> {
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const stdin = input.stdin ?? process.stdin;
  const startServer = input.startServer ?? startBridgeApiServer;
  const runLiveCanary = input.runLiveCanary ?? runLiveProviderExtractionCanary;
  const spawnDetachedServerProcess =
    input.spawnDetachedServerProcess ?? defaultSpawnDetachedServerProcess;
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
    if (command.kind === "status") {
      const status = await getServerStatus(command.config, input.fetchImpl);
      const { logPath: _logPath, ...statusOutput } = status;
      writeJson(stdout, statusOutput);
      return status.running && status.healthy !== false ? 0 : 1;
    }
    if (command.kind === "stop") {
      const result = await stopServer(command.config);
      stdout.write(`${result.message}\n`);
      return 0;
    }
    if (command.kind === "logs") {
      await printServerLogs(command.config, {
        follow: command.follow,
        lines: command.lines,
        stdout
      });
      return 0;
    }
    if (command.kind === "providers-list") {
      writeJson(
        stdout,
        await listBridgeProviders({
          baseUrl: command.baseUrl,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-get") {
      writeJson(
        stdout,
        await getBridgeProvider({
          baseUrl: command.baseUrl,
          id: command.id,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-add") {
      writeJson(
        stdout,
        await createBridgeProvider({
          baseUrl: command.baseUrl,
          id: command.id,
          kind: command.providerKind,
          label: command.label,
          enabled: command.enabled,
          config: command.config,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-remove") {
      writeJson(
        stdout,
        await deleteBridgeProvider({
          baseUrl: command.baseUrl,
          id: command.id,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-enable" || command.kind === "providers-disable") {
      writeJson(
        stdout,
        await updateBridgeProvider({
          baseUrl: command.baseUrl,
          id: command.id,
          patch: {
            enabled: command.kind === "providers-enable"
          },
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-import-session") {
      const sessionPackage = await readSessionPackageInput({
        filePath: command.filePath,
        stdin,
        stderr
      });
      writeJson(
        stdout,
        await putBridgeProviderSessionPackage({
          baseUrl: command.baseUrl,
          id: command.id,
          sessionPackage,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-session-status") {
      writeJson(
        stdout,
        await getBridgeProviderSessionPackage({
          baseUrl: command.baseUrl,
          id: command.id,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "providers-clear-session") {
      writeJson(
        stdout,
        await deleteBridgeProviderSessionPackage({
          baseUrl: command.baseUrl,
          id: command.id,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "models-list") {
      writeJson(
        stdout,
        await listBridgeModels({
          baseUrl: command.baseUrl,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "models-add") {
      writeJson(
        stdout,
        await createBridgeModel({
          baseUrl: command.baseUrl,
          provider: command.provider,
          model: command.model,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "sessions-list") {
      writeJson(
        stdout,
        await listBridgeSessions({
          baseUrl: command.baseUrl,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "sessions-get") {
      writeJson(
        stdout,
        await getBridgeSession({
          baseUrl: command.baseUrl,
          id: command.id,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    if (command.kind === "sessions-remove") {
      writeJson(
        stdout,
        await deleteBridgeSession({
          baseUrl: command.baseUrl,
          id: command.id,
          fetchImpl: input.fetchImpl
        })
      );
      return 0;
    }
    for (const warning of getBridgeServerStartupWarnings(command.config)) {
      stderr.write(`Warning: ${warning}\n`);
    }
    const preparedConfig = await ensureCliVaultKey(command.config, {
      env: input.env ?? process.env,
      stdin,
      stdout,
      stderr,
      promptForVaultKey: input.promptForVaultKey
    });
    if (!command.foreground) {
      const status = await getServerStatus(preparedConfig, input.fetchImpl);
      if (status.running) {
        throw new Error(
          `Bridge server is already running${status.pid ? ` (pid ${status.pid})` : ""}.`
        );
      }
      if (preparedConfig.port === 0) {
        throw new Error("Detached start requires a fixed port. Use --foreground with --port 0.");
      }
      const processFiles = getServerProcessFiles(preparedConfig);
      await ensureServerProcessDirectories(processFiles);
      const daemonArgv = toForegroundStartArgv(input.argv);
      const daemon = await spawnDetachedServerProcess({
        argv: daemonArgv,
        env: {
          ...(input.env ?? process.env)
        },
        logPath: processFiles.logPath,
        cwd: process.cwd()
      });
      if (!Number.isInteger(daemon.pid) || daemon.pid <= 0) {
        throw new Error("Failed to spawn detached bridge server process.");
      }
      const readyState = await waitForServerReady({
        config: preparedConfig,
        pid: daemon.pid,
        statePath: processFiles.statePath,
        fetchImpl: input.fetchImpl
      });
      const statusMessage =
        readyState === null
          ? [
              `Bridge server started in background (pid ${daemon.pid}).`,
              `Startup is still pending; check status with "openbridge status".`
            ].join("\n")
          : [
              `Bridge server started in background (pid ${readyState.pid}).`,
              `Base URL: ${readyState.baseUrl}`
            ].join("\n");
      stdout.write(`${statusMessage}\n`);
      return 0;
    }
    const server = await startServer({
      config: preparedConfig
    });
    const processState = await writeRunningServerState(preparedConfig, server);
    registerForegroundServerCleanup(server, processState);
    input.onServerStarted?.(server);
    const address = server.address();
    if (typeof address === "object" && address) {
      stdout.write(
        `Bridge server listening on http://${formatHostForUrl(address.address)}:${address.port}\n`
      );
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
        foreground: options.foreground === true,
        config: loadCliServerConfig(env, options)
      };
    },
    onStatus(options) {
      parsedCommand = {
        kind: "status",
        config: loadCliServerConfig(env, options)
      };
    },
    onStop(options) {
      parsedCommand = {
        kind: "stop",
        config: loadCliServerConfig(env, options)
      };
    },
    onLogs(options) {
      parsedCommand = {
        kind: "logs",
        config: loadCliServerConfig(env, options),
        follow: options.follow === true,
        lines: readPositiveInteger(options.lines, "lines", DEFAULT_LOG_TAIL_LINES)
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
    },
    onProvidersList(options) {
      parsedCommand = {
        kind: "providers-list",
        baseUrl: resolveBaseUrl(options.baseUrl, env)
      };
    },
    onProvidersGet(id, options) {
      parsedCommand = {
        kind: "providers-get",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onProvidersAdd(options) {
      parsedCommand = {
        kind: "providers-add",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(options.id, "id"),
        providerKind: requireNonEmptyString(options.kind, "kind"),
        label: requireNonEmptyString(options.label, "label"),
        enabled: options.disable !== true,
        config: options.config ? parseJsonObject(options.config, "config") : undefined
      };
    },
    onProvidersRemove(id, options) {
      parsedCommand = {
        kind: "providers-remove",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onProvidersEnable(id, options) {
      parsedCommand = {
        kind: "providers-enable",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onProvidersDisable(id, options) {
      parsedCommand = {
        kind: "providers-disable",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onProvidersImportSession(id, options) {
      parsedCommand = {
        kind: "providers-import-session",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id"),
        filePath: optionalNonEmptyString(options.file, "file") ?? undefined
      };
    },
    onProvidersSessionStatus(id, options) {
      parsedCommand = {
        kind: "providers-session-status",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onProvidersClearSession(id, options) {
      parsedCommand = {
        kind: "providers-clear-session",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onModelsList(options) {
      parsedCommand = {
        kind: "models-list",
        baseUrl: resolveBaseUrl(options.baseUrl, env)
      };
    },
    onModelsAdd(options) {
      parsedCommand = {
        kind: "models-add",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        provider: requireNonEmptyString(options.provider, "provider"),
        model: requireNonEmptyString(options.model, "model")
      };
    },
    onSessionsList(options) {
      parsedCommand = {
        kind: "sessions-list",
        baseUrl: resolveBaseUrl(options.baseUrl, env)
      };
    },
    onSessionsGet(id, options) {
      parsedCommand = {
        kind: "sessions-get",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
      };
    },
    onSessionsRemove(id, options) {
      parsedCommand = {
        kind: "sessions-remove",
        baseUrl: resolveBaseUrl(options.baseUrl, env),
        id: requireNonEmptyString(id, "id")
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

function buildBridgeServerCliProgram(
  env: NodeJS.ProcessEnv,
  handlers: {
    onStart?: (options: StartCommandOptions) => void;
    onStatus?: (options: LifecycleCommandOptions) => void;
    onStop?: (options: LifecycleCommandOptions) => void;
    onLogs?: (options: LogsCommandOptions) => void;
    onChat?: (options: ChatCommandOptions) => void;
    onLiveCanary?: (options: LiveCanaryCommandOptions) => void;
    onClearSessionVault?: (options: ClearSessionVaultCommandOptions) => void;
    onProvidersList?: (options: BaseUrlCommandOptions) => void;
    onProvidersGet?: (id: string, options: BaseUrlCommandOptions) => void;
    onProvidersAdd?: (options: ProviderAddCommandOptions) => void;
    onProvidersRemove?: (id: string, options: BaseUrlCommandOptions) => void;
    onProvidersEnable?: (id: string, options: BaseUrlCommandOptions) => void;
    onProvidersDisable?: (id: string, options: BaseUrlCommandOptions) => void;
    onProvidersImportSession?: (id: string, options: ProviderImportSessionCommandOptions) => void;
    onProvidersSessionStatus?: (id: string, options: BaseUrlCommandOptions) => void;
    onProvidersClearSession?: (id: string, options: BaseUrlCommandOptions) => void;
    onModelsList?: (options: BaseUrlCommandOptions) => void;
    onModelsAdd?: (options: ModelAddCommandOptions) => void;
    onSessionsList?: (options: BaseUrlCommandOptions) => void;
    onSessionsGet?: (id: string, options: BaseUrlCommandOptions) => void;
    onSessionsRemove?: (id: string, options: BaseUrlCommandOptions) => void;
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
    .description("Start the standalone bridge HTTP server. Defaults to detached/background mode.")
    .option("--host <host>", "Bind host", trimOrUndefined(env.BRIDGE_SERVER_HOST) ?? "127.0.0.1")
    .option("--port <port>", "Bind port", trimOrUndefined(env.BRIDGE_SERVER_PORT))
    .option("--state-root <path>", "State root for bridge artifacts")
    .option("--runtime-root <path>", "Runtime root for workspace execution")
    .option(
      "--token <token>",
      "Optional local bridge auth token",
      trimOrUndefined(env.BRIDGE_AUTH_TOKEN)
    )
    .option("--foreground", "Keep the server attached to the current terminal")
    .action((options: StartCommandOptions) => {
      handlers.onStart?.(options);
    });
  program
    .command("status")
    .description("Show the detached bridge server status.")
    .option("--host <host>", "Expected bind host", trimOrUndefined(env.BRIDGE_SERVER_HOST))
    .option("--port <port>", "Expected bind port", trimOrUndefined(env.BRIDGE_SERVER_PORT))
    .option("--state-root <path>", "State root for bridge artifacts")
    .option("--runtime-root <path>", "Runtime root for workspace execution")
    .action((options: LifecycleCommandOptions) => {
      handlers.onStatus?.(options);
    });
  program
    .command("stop")
    .description("Stop the detached bridge server.")
    .option("--host <host>", "Expected bind host", trimOrUndefined(env.BRIDGE_SERVER_HOST))
    .option("--port <port>", "Expected bind port", trimOrUndefined(env.BRIDGE_SERVER_PORT))
    .option("--state-root <path>", "State root for bridge artifacts")
    .option("--runtime-root <path>", "Runtime root for workspace execution")
    .action((options: LifecycleCommandOptions) => {
      handlers.onStop?.(options);
    });
  program
    .command("logs")
    .description("Print bridge server logs.")
    .option("--host <host>", "Expected bind host", trimOrUndefined(env.BRIDGE_SERVER_HOST))
    .option("--port <port>", "Expected bind port", trimOrUndefined(env.BRIDGE_SERVER_PORT))
    .option("--state-root <path>", "State root for bridge artifacts")
    .option("--runtime-root <path>", "Runtime root for workspace execution")
    .option("--follow", "Follow log output")
    .option(
      "--lines <count>",
      "Number of trailing log lines to print",
      String(DEFAULT_LOG_TAIL_LINES)
    )
    .action((options: LogsCommandOptions) => {
      handlers.onLogs?.(options);
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
  const providersCommand = program
    .command("providers")
    .description("Manage installed providers and provider session packages.");
  providersCommand
    .command("list")
    .description("List providers.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((options: BaseUrlCommandOptions) => {
      handlers.onProvidersList?.(options);
    });
  providersCommand
    .command("get <id>")
    .description("Get a provider by id.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onProvidersGet?.(id, options);
    });
  providersCommand
    .command("add")
    .description("Create a provider.")
    .requiredOption("--id <id>", "Provider id")
    .requiredOption("--kind <kind>", "Provider kind")
    .requiredOption("--label <label>", "Provider label")
    .option("--disable", "Create the provider in a disabled state")
    .option("--config <json>", "Provider config JSON object")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((options: ProviderAddCommandOptions) => {
      handlers.onProvidersAdd?.(options);
    });
  providersCommand
    .command("remove <id>")
    .description("Delete a provider.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onProvidersRemove?.(id, options);
    });
  providersCommand
    .command("enable <id>")
    .description("Enable a provider.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onProvidersEnable?.(id, options);
    });
  providersCommand
    .command("disable <id>")
    .description("Disable a provider.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onProvidersDisable?.(id, options);
    });
  providersCommand
    .command("import-session <id>")
    .description("Install or replace a provider session package from stdin or a JSON file.")
    .option("--file <path>", "Read the session package from a JSON file")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: ProviderImportSessionCommandOptions) => {
      handlers.onProvidersImportSession?.(id, options);
    });
  providersCommand
    .command("session-status <id>")
    .description("Show the safe session-package status for a provider.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onProvidersSessionStatus?.(id, options);
    });
  providersCommand
    .command("clear-session <id>")
    .description("Delete a provider session package.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onProvidersClearSession?.(id, options);
    });
  const modelsCommand = program.command("models").description("Manage exposed bridge models.");
  modelsCommand
    .command("list")
    .description("List models.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((options: BaseUrlCommandOptions) => {
      handlers.onModelsList?.(options);
    });
  modelsCommand
    .command("add")
    .description("Add a model id to an existing provider.")
    .requiredOption("--provider <id>", "Provider id")
    .requiredOption("--model <id>", "Model id")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((options: ModelAddCommandOptions) => {
      handlers.onModelsAdd?.(options);
    });
  const sessionsCommand = program.command("sessions").description("Manage bridge sessions.");
  sessionsCommand
    .command("list")
    .description("List sessions.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((options: BaseUrlCommandOptions) => {
      handlers.onSessionsList?.(options);
    });
  sessionsCommand
    .command("get <id>")
    .description("Get a session by id.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onSessionsGet?.(id, options);
    });
  sessionsCommand
    .command("remove <id>")
    .description("Delete a session.")
    .option(
      "--base-url <url>",
      "Bridge base URL",
      trimOrUndefined(env.BRIDGE_API_BASE_URL) ??
        trimOrUndefined(env.BRIDGE_SERVER_BASE_URL) ??
        DEFAULT_BRIDGE_API_BASE_URL
    )
    .action((id: string, options: BaseUrlCommandOptions) => {
      handlers.onSessionsRemove?.(id, options);
    });
  return program;
}

function loadCliServerConfig(
  env: NodeJS.ProcessEnv,
  options: StartCommandOptions | LifecycleCommandOptions
) {
  return loadBridgeServerConfig(env, {
    host: optionalNonEmptyString(options.host, "host") ?? undefined,
    port: options.port,
    authToken:
      "token" in options
        ? (optionalNonEmptyString(options.token, "token") ?? undefined)
        : undefined,
    stateRoot: optionalNonEmptyString(options.stateRoot, "state-root") ?? undefined,
    runtimeRoot: optionalNonEmptyString(options.runtimeRoot, "runtime-root") ?? undefined
  });
}

function resolveBaseUrl(value: string | undefined, env: NodeJS.ProcessEnv) {
  return (
    optionalNonEmptyString(value, "base-url") ??
    optionalNonEmptyString(env.BRIDGE_API_BASE_URL, "BRIDGE_API_BASE_URL") ??
    optionalNonEmptyString(env.BRIDGE_SERVER_BASE_URL, "BRIDGE_SERVER_BASE_URL") ??
    DEFAULT_BRIDGE_API_BASE_URL
  );
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

function readPositiveInteger(value: string | undefined, key: string, fallback: number) {
  if (value === undefined) {
    return fallback;
  }
  const normalized = optionalNonEmptyString(value, key);
  if (!normalized) {
    return fallback;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${key} must be a positive integer.`);
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function parseJsonObject(raw: string, key: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${key} must be valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeJson(stream: { write(value: string): void }, value: unknown) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
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

async function readSessionPackageInput(input: {
  filePath?: string;
  stdin: NodeJS.ReadStream;
  stderr: {
    write(value: string): void;
  };
}) {
  const raw = input.filePath
    ? await readFile(path.resolve(input.filePath), "utf8")
    : await readSessionPackageFromStdin(input.stdin, input.stderr);
  return parseJsonObject(raw, "session package");
}

async function readSessionPackageFromStdin(
  stdin: NodeJS.ReadStream,
  stderr: { write(value: string): void }
) {
  if (stdin.isTTY) {
    stderr.write("Paste the session package JSON, then press Ctrl-D to submit.\n");
  }
  return await readStreamToString(stdin);
}

function readStreamToString(stream: NodeJS.ReadStream) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.once("end", () => resolve(data));
    stream.once("error", reject);
  });
}

function getServerProcessFiles(config: BridgeServerConfig): ServerProcessFiles {
  const runRoot = path.join(config.stateRoot, "run");
  const logRoot = path.join(config.stateRoot, "logs");
  return {
    statePath: path.join(runRoot, "server-process.json"),
    runRoot,
    logPath: path.join(logRoot, "server.log"),
    logRoot
  };
}

async function ensureServerProcessDirectories(files: ServerProcessFiles) {
  await mkdir(files.runRoot, {
    recursive: true,
    mode: 0o700
  });
  await mkdir(files.logRoot, {
    recursive: true,
    mode: 0o700
  });
}

async function writeRunningServerState(
  config: BridgeServerConfig,
  server: Awaited<ReturnType<typeof startBridgeApiServer>>
) {
  const files = getServerProcessFiles(config);
  await ensureServerProcessDirectories(files);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Bridge server did not expose a network address.");
  }
  const state: ServerProcessState = {
    pid: process.pid,
    baseUrl: `http://${formatHostForUrl(address.address)}:${address.port}`,
    host: address.address,
    port: address.port,
    logPath: files.logPath,
    startedAt: new Date().toISOString(),
    stateRoot: config.stateRoot
  };
  await writeServerProcessState(files.statePath, state);
  return state;
}

async function writeServerProcessState(statePath: string, state: ServerProcessState) {
  await mkdir(path.dirname(statePath), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

async function readServerProcessState(statePath: string) {
  const raw = await readOptionalFile(statePath);
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = parsed as Partial<ServerProcessState>;
  if (
    !Number.isInteger(value.pid) ||
    typeof value.baseUrl !== "string" ||
    typeof value.host !== "string" ||
    !Number.isInteger(value.port) ||
    typeof value.logPath !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.stateRoot !== "string"
  ) {
    return null;
  }
  return value as ServerProcessState;
}

async function deleteServerProcessState(statePath: string) {
  try {
    await rm(statePath, {
      force: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function registerForegroundServerCleanup(
  server: Awaited<ReturnType<typeof startBridgeApiServer>>,
  state: ServerProcessState
) {
  if (typeof server.once !== "function" || typeof server.close !== "function") {
    return;
  }
  let shuttingDown = false;
  const statePath = path.join(state.stateRoot, "run", "server-process.json");
  const cleanup = () => {
    void deleteServerProcessState(statePath);
  };
  server.once("close", cleanup);
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void closeServer(server)
      .catch(() => {})
      .finally(() => {
        cleanup();
        process.exit(signal === "SIGINT" ? 130 : 0);
      });
  };
  process.once("SIGINT", () => {
    handleSignal("SIGINT");
  });
  process.once("SIGTERM", () => {
    handleSignal("SIGTERM");
  });
}

async function getServerStatus(config: BridgeServerConfig, fetchImpl?: BridgeApiClientFetch) {
  const files = getServerProcessFiles(config);
  const state = await readServerProcessState(files.statePath);
  const pid = state?.pid ?? null;
  const baseUrl = state?.baseUrl ?? `http://${formatHostForUrl(config.host)}:${config.port}`;
  const logPath = state?.logPath ?? files.logPath;
  const running = state ? isProcessRunning(state.pid) : false;
  let healthy: boolean | null = null;
  if (running) {
    try {
      await checkBridgeHealth({
        baseUrl,
        fetchImpl
      });
      healthy = true;
    } catch {
      healthy = false;
    }
  } else if (state) {
    await deleteServerProcessState(files.statePath);
  }
  return {
    running,
    healthy,
    pid,
    baseUrl,
    logPath,
    startedAt: state?.startedAt ?? null
  };
}

async function stopServer(config: BridgeServerConfig) {
  const files = getServerProcessFiles(config);
  const state = await readServerProcessState(files.statePath);
  if (!state || !isProcessRunning(state.pid)) {
    await deleteServerProcessState(files.statePath);
    return {
      stopped: false,
      message: "Bridge server is not running."
    };
  }
  process.kill(state.pid, "SIGTERM");
  const terminated = await waitForProcessExit(state.pid, STOP_TIMEOUT_MS);
  if (!terminated) {
    process.kill(state.pid, "SIGKILL");
    const killed = await waitForProcessExit(state.pid, 1_000);
    if (!killed) {
      throw new Error(`Failed to stop bridge server pid ${state.pid}.`);
    }
  }
  await deleteServerProcessState(files.statePath);
  return {
    stopped: true,
    message: `Stopped bridge server pid ${state.pid}.`
  };
}

async function printServerLogs(
  config: BridgeServerConfig,
  input: {
    follow: boolean;
    lines: number;
    stdout: {
      write(value: string): void;
    };
  }
) {
  const files = getServerProcessFiles(config);
  const content = await readOptionalRawFile(files.logPath);
  if (content) {
    const tail = tailLines(content, input.lines);
    if (tail) {
      input.stdout.write(tail);
      if (!tail.endsWith("\n")) {
        input.stdout.write("\n");
      }
    }
  } else if (!input.follow) {
    throw new Error(`Bridge server log file was not found at ${files.logPath}.`);
  }
  if (!input.follow) {
    return;
  }
  let position = await getFileSize(files.logPath);
  const stopSignal = createStopSignal();
  while (!stopSignal.stopped) {
    await delay(LOG_FOLLOW_POLL_INTERVAL_MS);
    const size = await getFileSize(files.logPath);
    if (size < position) {
      position = 0;
    }
    if (size === position) {
      continue;
    }
    const chunk = await readFileSlice(files.logPath, position, size - position);
    if (chunk.length > 0) {
      input.stdout.write(chunk);
    }
    position = size;
  }
}

function createStopSignal() {
  const signal = {
    stopped: false
  };
  const stop = () => {
    signal.stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return signal;
}

function tailLines(text: string, lineCount: number) {
  if (!text) {
    return "";
  }
  const normalized = text.split(/\r?\n/);
  const hasTrailingNewline = text.endsWith("\n");
  const lines = hasTrailingNewline ? normalized.slice(0, -1) : normalized;
  const tail = lines.slice(-lineCount).join("\n");
  return tail.length === 0 ? "" : `${tail}${hasTrailingNewline ? "\n" : ""}`;
}

async function readFileSlice(filePath: string, offset: number, length: number) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function getFileSize(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function waitForServerReady(input: {
  config: BridgeServerConfig;
  pid: number;
  statePath: string;
  fetchImpl?: BridgeApiClientFetch;
}) {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readServerProcessState(input.statePath);
    if (state && state.pid === input.pid) {
      try {
        await checkBridgeHealth({
          baseUrl: state.baseUrl,
          fetchImpl: input.fetchImpl
        });
        return state;
      } catch {
        // Ignore until timeout or process death.
      }
    }
    if (!isProcessRunning(input.pid)) {
      throw new Error(
        `Bridge server exited before becoming ready. Check logs at ${getServerProcessFiles(input.config).logPath}.`
      );
    }
    await delay(DAEMON_POLL_INTERVAL_MS);
  }
  return null;
}

async function defaultSpawnDetachedServerProcess(input: SpawnDetachedServerProcessInput) {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Cannot determine the openbridge CLI entrypoint for detached start.");
  }
  await mkdir(path.dirname(input.logPath), {
    recursive: true,
    mode: 0o700
  });
  const logHandle = await open(input.logPath, "a", 0o600);
  try {
    const launch = buildDetachedServerLaunchCommand({
      scriptPath,
      argv: input.argv,
      execPath: process.execPath,
      execArgv: process.execArgv
    });
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd]
    });
    child.unref();
    if (!child.pid) {
      throw new Error("Detached bridge server process did not expose a pid.");
    }
    return {
      pid: child.pid
    };
  } finally {
    await logHandle.close();
  }
}

function buildDetachedServerLaunchCommand(input: {
  scriptPath: string;
  argv: string[];
  execPath: string;
  execArgv: string[];
}): DetachedServerLaunchCommand {
  return {
    command: input.execPath,
    args: [...input.execArgv, input.scriptPath, ...input.argv]
  };
}

function toForegroundStartArgv(argv: string[]) {
  const normalized =
    argv.length === 0 || argv[0]?.startsWith("--") ? ["start", ...argv] : [...argv];
  if (normalized[0] !== "start") {
    throw new Error("Detached launch is only supported for the start command.");
  }
  if (!normalized.includes("--foreground")) {
    normalized.push("--foreground");
  }
  return normalized;
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isProcessRunning(pid);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatHostForUrl(host: string) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function closeServer(server: Awaited<ReturnType<typeof startBridgeApiServer>>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
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

async function readOptionalRawFile(targetPath: string) {
  try {
    return await readFile(targetPath, "utf8");
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
  buildDetachedServerLaunchCommand,
  runBridgeServerCli,
  parseBridgeServerCliArgs,
  getBridgeServerCliHelpText
};

export type { BridgeServerCliCommand, RunBridgeServerCliInput };
