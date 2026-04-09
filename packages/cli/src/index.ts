import type {
  BridgeApiClientFetch,
  RunBridgeServerCliInput
} from "@uncensoredcode/openbridge/server";
import { bridgeServer } from "@uncensoredcode/openbridge/server";

import { argsModule } from "./args.ts";

const { BridgeApiHttpError, checkBridgeHealth, runBridgeServerCli, sendBridgeMessage } =
  bridgeServer;
const { getBridgeCliHelpText, parseBridgeCliArgs } = argsModule;
type BridgeCliDependencies = {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: BridgeApiClientFetch;
  stdout?: {
    write(value: string): void;
  };
  stderr?: {
    write(value: string): void;
  };
  stdin?: RunBridgeServerCliInput["stdin"];
  startServer?: RunBridgeServerCliInput["startServer"];
  onServerStarted?: RunBridgeServerCliInput["onServerStarted"];
  runLiveCanary?: RunBridgeServerCliInput["runLiveCanary"];
  promptForVaultKey?: RunBridgeServerCliInput["promptForVaultKey"];
  runServerCli?: typeof runBridgeServerCli;
};
async function runBridgeCli(dependencies: BridgeCliDependencies): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const delegatedRunBridgeServerCli = dependencies.runServerCli ?? runBridgeServerCli;
  let command;
  try {
    command = parseBridgeCliArgs({
      argv: dependencies.argv,
      env: dependencies.env
    });
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (command.kind === "help") {
    stdout.write(`${getBridgeCliHelpText()}\n`);
    return 0;
  }
  if (command.kind === "server") {
    return delegatedRunBridgeServerCli({
      argv: command.argv,
      env: dependencies.env,
      stdout,
      stderr,
      stdin,
      startServer: dependencies.startServer,
      onServerStarted: dependencies.onServerStarted,
      runLiveCanary: dependencies.runLiveCanary,
      fetchImpl: dependencies.fetchImpl,
      promptForVaultKey: dependencies.promptForVaultKey
    });
  }
  try {
    if (command.kind === "health") {
      const health = await checkBridgeHealth({
        baseUrl: command.baseUrl,
        fetchImpl: dependencies.fetchImpl
      });
      stdout.write(`${health.ok ? "ok" : "unhealthy"}\n`);
      return health.ok ? 0 : 1;
    }
    const response = await sendBridgeMessage({
      baseUrl: command.baseUrl,
      sessionId: command.sessionId,
      input: command.input,
      provider: command.provider,
      model: command.model,
      metadata: command.metadata,
      toolProfile: command.toolProfile,
      fetchImpl: dependencies.fetchImpl
    });
    stdout.write(`${response.output}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}
function formatCliError(error: unknown) {
  if (error instanceof BridgeApiHttpError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export const bridgeCli = {
  getBridgeCliHelpText: argsModule.getBridgeCliHelpText,
  parseBridgeCliArgs: argsModule.parseBridgeCliArgs,
  runBridgeCli
};

export type { BridgeCliCommand } from "./args.ts";
