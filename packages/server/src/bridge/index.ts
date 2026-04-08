import { bridgeModelCatalogModule } from "./bridge-model-catalog.ts";
import { bridgeRuntimeServiceModule } from "./bridge-runtime-service.ts";
import { liveProviderExtractionCanaryModule } from "./live-provider-extraction-canary.ts";
import { localSessionPackageStoreModule } from "./stores/local-session-package-store.ts";
import { providerStoreModule } from "./stores/provider-store.ts";
import { sessionBackedProviderStoreModule } from "./stores/session-backed-provider-store.ts";
import { sessionPackageStoreModule } from "./stores/session-package-store.ts";
import { sessionStoreModule } from "./stores/session-store.ts";

export const bridgeModule = {
  buildModelListResponse: bridgeModelCatalogModule.buildModelListResponse,
  createModelRequestSchema: bridgeModelCatalogModule.createModelRequestSchema,
  defaultModelForProvider: bridgeModelCatalogModule.defaultModelForProvider,
  modelMutationResponseSchema: bridgeModelCatalogModule.modelMutationResponseSchema,
  resolveBridgeModel: bridgeModelCatalogModule.resolveBridgeModel,
  createBridgeRuntimeService: bridgeRuntimeServiceModule.createBridgeRuntimeService,
  DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING:
    liveProviderExtractionCanaryModule.DEFAULT_LIVE_CANARY_EXPECTED_SUBSTRING,
  DEFAULT_LIVE_CANARY_PROMPT: liveProviderExtractionCanaryModule.DEFAULT_LIVE_CANARY_PROMPT,
  formatLiveProviderExtractionCanaryResult:
    liveProviderExtractionCanaryModule.formatLiveProviderExtractionCanaryResult,
  runLiveProviderExtractionCanary:
    liveProviderExtractionCanaryModule.runLiveProviderExtractionCanary,
  createInMemoryProviderStore: providerStoreModule.createInMemoryProviderStore,
  createProviderRequestSchema: providerStoreModule.createProviderRequestSchema,
  providerDeleteResponseSchema: providerStoreModule.providerDeleteResponseSchema,
  providerIdParamsSchema: providerStoreModule.providerIdParamsSchema,
  providerListResponseSchema: providerStoreModule.providerListResponseSchema,
  providerResponseSchema: providerStoreModule.providerResponseSchema,
  updateProviderRequestSchema: providerStoreModule.updateProviderRequestSchema,
  createSessionBackedProviderStore:
    sessionBackedProviderStoreModule.createSessionBackedProviderStore,
  buildSessionPackageStatus: sessionPackageStoreModule.buildSessionPackageStatus,
  createInMemorySessionPackageStore: sessionPackageStoreModule.createInMemorySessionPackageStore,
  installedProviderPackageSchema: sessionPackageStoreModule.installedProviderPackageSchema,
  sessionPackageMetadataSchema: sessionPackageStoreModule.sessionPackageMetadataSchema,
  sessionPackageDeleteResponseSchema: sessionPackageStoreModule.sessionPackageDeleteResponseSchema,
  sessionPackageSchema: sessionPackageStoreModule.sessionPackageSchema,
  sessionPackageStatusResponseSchema: sessionPackageStoreModule.sessionPackageStatusResponseSchema,
  SessionPackageVaultError: localSessionPackageStoreModule.SessionPackageVaultError,
  clearLocalSessionVault: localSessionPackageStoreModule.clearLocalSessionVault,
  createLocalSessionPackageStore: localSessionPackageStoreModule.createLocalSessionPackageStore,
  createInMemorySessionStore: sessionStoreModule.createInMemorySessionStore,
  createSessionRequestSchema: sessionStoreModule.createSessionRequestSchema,
  sessionDeleteResponseSchema: sessionStoreModule.sessionDeleteResponseSchema,
  sessionIdParamsSchema: sessionStoreModule.sessionIdParamsSchema,
  sessionListResponseSchema: sessionStoreModule.sessionListResponseSchema,
  sessionResponseSchema: sessionStoreModule.sessionResponseSchema,
  updateSessionRequestSchema: sessionStoreModule.updateSessionRequestSchema
};

export type {
  BridgeRuntimeService,
  BridgeRuntimeServiceDependencies,
  BridgeRuntimeServiceLogEvent
} from "./bridge-runtime-service.ts";

export type {
  LiveProviderExtractionCanaryInput,
  LiveProviderExtractionCanaryResult
} from "./live-provider-extraction-canary.ts";

export type {
  LocalSessionPackageStoreOptions,
  SessionPackageVaultError
} from "./stores/local-session-package-store.ts";

export type {
  CreateProviderRequest,
  ProviderRecord,
  ProviderStore
} from "./stores/provider-store.ts";

export type {
  InstalledProviderPackage,
  SessionPackageMetadata,
  SessionPackageStore
} from "./stores/session-package-store.ts";

export type { SessionStore } from "./stores/session-store.ts";
