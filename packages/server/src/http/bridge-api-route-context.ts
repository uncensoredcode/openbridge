import type {
  BridgeRuntimeService,
  ProviderStore,
  SessionPackageStore,
  SessionStore
} from "../bridge/index.ts";
import type { BridgeServerConfig } from "../config/index.ts";

type BridgeApiRouteContext = {
  config: BridgeServerConfig;
  service: BridgeRuntimeService;
  providerStore: ProviderStore;
  sessionPackageStore: SessionPackageStore;
  sessionStore: SessionStore;
  onInternalError?: (
    error: unknown,
    request: {
      method: string;
      url: string;
    }
  ) => void;
};

export type { BridgeApiRouteContext };
