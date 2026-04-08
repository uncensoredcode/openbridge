import { bridgeModule } from "./bridge/index.ts";
import { cliModule } from "./cli/index.ts";
import { clientModule } from "./client/index.ts";
import { configModule } from "./config/index.ts";
import { httpModule } from "./http/index.ts";
import { bridgeApiErrorModule } from "./shared/bridge-api-error.ts";
import { outputModule } from "./shared/output.ts";

export const bridgeServer = {
  BridgeApiHttpError: clientModule.BridgeApiHttpError,
  buildHealthUrl: clientModule.buildHealthUrl,
  buildSessionMessageUrl: clientModule.buildSessionMessageUrl,
  checkBridgeHealth: clientModule.checkBridgeHealth,
  sendBridgeMessage: clientModule.sendBridgeMessage,
  loadBridgeServerConfig: configModule.loadBridgeServerConfig,
  BridgeApiError: bridgeApiErrorModule.BridgeApiError,
  isBridgeApiError: bridgeApiErrorModule.isBridgeApiError,
  DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING: bridgeModule.DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING,
  DEFAULT_LIVE_CANARY_PROMPT: bridgeModule.DEFAULT_LIVE_CANARY_PROMPT,
  formatLiveProviderExtractionCanaryResult: bridgeModule.formatLiveProviderExtractionCanaryResult,
  runLiveProviderExtractionCanary: bridgeModule.runLiveProviderExtractionCanary,
  sanitizeBridgeApiOutput: outputModule.sanitizeBridgeApiOutput,
  createBridgeRuntimeService: bridgeModule.createBridgeRuntimeService,
  createBridgeApiServer: httpModule.createBridgeApiServer,
  startBridgeApiServer: httpModule.startBridgeApiServer,
  getBridgeServerCliHelpText: cliModule.getBridgeServerCliHelpText,
  parseBridgeServerCliArgs: cliModule.parseBridgeServerCliArgs,
  runBridgeServerCli: cliModule.runBridgeServerCli
};

export type {
  LiveProviderExtractionCanaryInput,
  LiveProviderExtractionCanaryResult
} from "./bridge/index.ts";

export type { BridgeRuntimeServiceDependencies } from "./bridge/index.ts";

export type { BridgeServerCliCommand, RunBridgeServerCliInput } from "./cli/index.ts";

export type {
  BridgeApiClientFetch,
  CheckBridgeHealthInput,
  SendBridgeMessageInput
} from "./client/index.ts";

export type { BridgeServerConfig } from "./config/index.ts";

export type { BridgeApiServerOptions } from "./http/index.ts";

export type {
  BridgeApiErrorResponse,
  BridgeApiToolProfile,
  BridgeChatCompletionMessage,
  BridgeChatCompletionRequest,
  BridgeChatCompletionResponse,
  BridgeHealthResponse,
  BridgeMessageRequest,
  BridgeMessageResponse,
  BridgeReadyResponse
} from "./shared/api-schema.ts";

export type { BridgeApiError } from "./shared/bridge-api-error.ts";
