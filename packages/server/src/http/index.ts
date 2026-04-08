import { createBridgeApiServerModule } from "./create-bridge-api-server.ts";

export const httpModule = {
  createBridgeApiServer: createBridgeApiServerModule.createBridgeApiServer,
  startBridgeApiServer: createBridgeApiServerModule.startBridgeApiServer
};

export type { BridgeApiServerLogger, BridgeApiServerOptions } from "./create-bridge-api-server.ts";
