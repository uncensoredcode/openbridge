import { z } from "zod";

import { providerTransportProfileModule } from "./providers/provider-transport-profile.ts";
import type { ProviderRecord } from "./stores/provider-store.ts";

const { defaultModelForProviderRecord, readConfiguredModelIds } = providerTransportProfileModule;
const nonEmptyString = (field: string) => z.string().trim().min(1, `${field} is required.`);
const bridgeModelSchema = z.object({
  id: nonEmptyString("id"),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: nonEmptyString("owned_by")
});
const bridgeModelListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(bridgeModelSchema)
});
const createModelRequestSchema = z
  .object({
    provider: nonEmptyString("provider"),
    model: nonEmptyString("model")
  })
  .strict();
const modelMutationResponseSchema = z
  .object({
    ok: z.literal(true),
    providerId: nonEmptyString("providerId"),
    modelId: nonEmptyString("modelId")
  })
  .strict();
type BridgeModelRecord = z.infer<typeof bridgeModelSchema>;
type ResolvedBridgeModel = {
  provider: ProviderRecord;
  modelId: string;
  publicModelId: string;
  available: boolean;
};
function buildModelListResponse(providers: ProviderRecord[]) {
  const data = providers
    .flatMap((provider) => listModelsForProvider(provider))
    .sort((left, right) => left.id.localeCompare(right.id));
  return bridgeModelListResponseSchema.parse({
    object: "list",
    data
  });
}
function defaultModelForProvider(provider: ProviderRecord | null) {
  return defaultModelForProviderRecord(provider);
}
function resolveBridgeModel(
  providers: ProviderRecord[],
  publicModelId: string
): ResolvedBridgeModel | null {
  for (const provider of providers) {
    for (const modelId of resolveModelIdsForProvider(provider)) {
      if (`${provider.id}/${modelId}` !== publicModelId) {
        continue;
      }
      return {
        provider,
        modelId,
        publicModelId,
        available: provider.enabled
      };
    }
    const dynamicModelId = readDynamicModelId(provider, publicModelId);
    if (dynamicModelId) {
      return {
        provider,
        modelId: dynamicModelId,
        publicModelId,
        available: provider.enabled
      };
    }
  }
  return null;
}
function listModelsForProvider(provider: ProviderRecord): BridgeModelRecord[] {
  if (!provider.enabled) {
    return [];
  }
  const modelIds = resolveModelIdsForProvider(provider);
  const created = toUnixTimestamp(provider.createdAt);
  return modelIds.map((modelId) =>
    bridgeModelSchema.parse({
      id: `${provider.id}/${modelId}`,
      object: "model",
      created,
      owned_by: provider.id
    })
  );
}
function resolveModelIdsForProvider(provider: ProviderRecord) {
  return readConfiguredModelIds(provider.config);
}
function readDynamicModelId(provider: ProviderRecord, publicModelId: string) {
  const prefix = `${provider.id}/`;
  if (!publicModelId.startsWith(prefix)) {
    return null;
  }
  const modelId = publicModelId.slice(prefix.length).trim();
  return modelId ? modelId : null;
}
function toUnixTimestamp(value: string) {
  return Math.floor(Date.parse(value) / 1000);
}

export const bridgeModelCatalogModule = {
  bridgeModelSchema,
  bridgeModelListResponseSchema,
  createModelRequestSchema,
  modelMutationResponseSchema,
  buildModelListResponse,
  defaultModelForProvider,
  resolveBridgeModel
};

export type { BridgeModelRecord, ResolvedBridgeModel };
