import { runBridgeServerCliModule } from "./run-bridge-server-cli.ts";

export const cliModule = {
  buildDetachedServerLaunchCommand: runBridgeServerCliModule.buildDetachedServerLaunchCommand,
  getBridgeServerCliHelpText: runBridgeServerCliModule.getBridgeServerCliHelpText,
  parseBridgeServerCliArgs: runBridgeServerCliModule.parseBridgeServerCliArgs,
  runBridgeServerCli: runBridgeServerCliModule.runBridgeServerCli
};

export type { BridgeServerCliCommand, RunBridgeServerCliInput } from "./run-bridge-server-cli.ts";
