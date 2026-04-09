import { bridgeApiClientModule } from "./bridge-api-client.ts";

export const clientModule = {
  BridgeApiHttpError: bridgeApiClientModule.BridgeApiHttpError,
  buildHealthUrl: bridgeApiClientModule.buildHealthUrl,
  buildModelsUrl: bridgeApiClientModule.buildModelsUrl,
  buildProviderSessionPackageUrl: bridgeApiClientModule.buildProviderSessionPackageUrl,
  buildProviderUrl: bridgeApiClientModule.buildProviderUrl,
  buildProvidersUrl: bridgeApiClientModule.buildProvidersUrl,
  buildSessionUrl: bridgeApiClientModule.buildSessionUrl,
  buildSessionMessageUrl: bridgeApiClientModule.buildSessionMessageUrl,
  buildSessionsUrl: bridgeApiClientModule.buildSessionsUrl,
  checkBridgeHealth: bridgeApiClientModule.checkBridgeHealth,
  createBridgeModel: bridgeApiClientModule.createBridgeModel,
  createBridgeChatCompletion: bridgeApiClientModule.createBridgeChatCompletion,
  createBridgeProvider: bridgeApiClientModule.createBridgeProvider,
  DEFAULT_BRIDGE_API_BASE_URL: bridgeApiClientModule.DEFAULT_BRIDGE_API_BASE_URL,
  deleteBridgeProvider: bridgeApiClientModule.deleteBridgeProvider,
  deleteBridgeProviderSessionPackage: bridgeApiClientModule.deleteBridgeProviderSessionPackage,
  deleteBridgeSession: bridgeApiClientModule.deleteBridgeSession,
  getBridgeProvider: bridgeApiClientModule.getBridgeProvider,
  getBridgeProviderSessionPackage: bridgeApiClientModule.getBridgeProviderSessionPackage,
  getBridgeSession: bridgeApiClientModule.getBridgeSession,
  listBridgeModels: bridgeApiClientModule.listBridgeModels,
  listBridgeProviders: bridgeApiClientModule.listBridgeProviders,
  listBridgeSessions: bridgeApiClientModule.listBridgeSessions,
  putBridgeProviderSessionPackage: bridgeApiClientModule.putBridgeProviderSessionPackage,
  sendBridgeMessage: bridgeApiClientModule.sendBridgeMessage,
  streamBridgeChatCompletion: bridgeApiClientModule.streamBridgeChatCompletion,
  updateBridgeProvider: bridgeApiClientModule.updateBridgeProvider
};

export type {
  BridgeApiClientFetch,
  BridgeApiHttpError,
  CheckBridgeHealthInput,
  CreateBridgeModelInput,
  CreateBridgeProviderInput,
  CreateBridgeChatCompletionInput,
  DeleteBridgeProviderInput,
  DeleteBridgeProviderSessionPackageInput,
  DeleteBridgeSessionInput,
  GetBridgeProviderInput,
  GetBridgeProviderSessionPackageInput,
  GetBridgeSessionInput,
  SendBridgeMessageInput,
  PutBridgeProviderSessionPackageInput,
  StreamBridgeChatCompletionInput
} from "./bridge-api-client.ts";
