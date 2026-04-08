import { bridgeApiClientModule } from "./bridge-api-client.ts";

export const clientModule = {
  BridgeApiHttpError: bridgeApiClientModule.BridgeApiHttpError,
  buildHealthUrl: bridgeApiClientModule.buildHealthUrl,
  buildSessionMessageUrl: bridgeApiClientModule.buildSessionMessageUrl,
  checkBridgeHealth: bridgeApiClientModule.checkBridgeHealth,
  createBridgeChatCompletion: bridgeApiClientModule.createBridgeChatCompletion,
  DEFAULT_BRIDGE_API_BASE_URL: bridgeApiClientModule.DEFAULT_BRIDGE_API_BASE_URL,
  sendBridgeMessage: bridgeApiClientModule.sendBridgeMessage,
  streamBridgeChatCompletion: bridgeApiClientModule.streamBridgeChatCompletion
};

export type {
  BridgeApiClientFetch,
  BridgeApiHttpError,
  CheckBridgeHealthInput,
  CreateBridgeChatCompletionInput,
  SendBridgeMessageInput,
  StreamBridgeChatCompletionInput
} from "./bridge-api-client.ts";
