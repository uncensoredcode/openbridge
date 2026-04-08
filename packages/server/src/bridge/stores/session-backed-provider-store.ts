import type {
  CreateProviderRequest,
  ProviderDeleteResponse,
  ProviderRecord,
  ProviderStore,
  UpdateProviderRequest
} from "./provider-store.ts";
import type { SessionPackageStore } from "./session-package-store.ts";

function createSessionBackedProviderStore(sessionPackageStore: SessionPackageStore): ProviderStore {
  return {
    list(): ProviderRecord[] {
      return sessionPackageStore.listProviders();
    },
    get(id: string): ProviderRecord | null {
      return sessionPackageStore.getProvider(id);
    },
    create(input: CreateProviderRequest): ProviderRecord {
      return sessionPackageStore.createProvider(input);
    },
    update(id: string, patch: UpdateProviderRequest): ProviderRecord {
      return sessionPackageStore.updateProvider(id, patch);
    },
    delete(id: string): ProviderDeleteResponse {
      const deleted = sessionPackageStore.delete(id);
      return {
        ok: true,
        id: deleted.providerId
      };
    }
  };
}

export const sessionBackedProviderStoreModule = {
  createSessionBackedProviderStore
};
