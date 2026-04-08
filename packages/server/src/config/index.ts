import { bridgeServerConfigModule } from "./bridge-server-config.ts";

export const configModule = {
  bridgeServerConfigSchema: bridgeServerConfigModule.bridgeServerConfigSchema,
  getBridgeServerStartupWarnings: bridgeServerConfigModule.getBridgeServerStartupWarnings,
  isLocalBridgeHost: bridgeServerConfigModule.isLocalBridgeHost,
  isWildcardCorsOrigins: bridgeServerConfigModule.isWildcardCorsOrigins,
  loadBridgeServerConfig: bridgeServerConfigModule.loadBridgeServerConfig
};

export type { BridgeServerConfig, BridgeServerConfigOverrides } from "./bridge-server-config.ts";
