import { z } from "zod";

import { bridgeApiErrorModule } from "../../shared/bridge-api-error.ts";

const { BridgeApiError } = bridgeApiErrorModule;
const nonEmptyString = (field: string) => z.string().trim().min(1, `${field} is required.`);
const providerConfigSchema = z.object({}).catchall(z.unknown());
const providerSchema = z.object({
  id: nonEmptyString("id"),
  kind: nonEmptyString("kind"),
  label: nonEmptyString("label"),
  enabled: z.boolean(),
  config: providerConfigSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true })
});
const createProviderRequestSchema = z
  .object({
    id: nonEmptyString("id"),
    kind: nonEmptyString("kind"),
    label: nonEmptyString("label"),
    enabled: z.boolean().default(true),
    config: providerConfigSchema.default({})
  })
  .strict();
const updateProviderRequestSchema = z
  .object({
    kind: nonEmptyString("kind").optional(),
    label: nonEmptyString("label").optional(),
    enabled: z.boolean().optional(),
    config: providerConfigSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one mutable field must be provided."
      });
    }
  });
const providerIdParamsSchema = z
  .object({
    id: nonEmptyString("id")
  })
  .strict();
const providerResponseSchema = z.object({
  provider: providerSchema
});
const providerListResponseSchema = z.object({
  providers: z.array(providerSchema)
});
const providerDeleteResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string()
});
type ProviderRecord = z.infer<typeof providerSchema>;
type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;
type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;
type ProviderDeleteResponse = z.infer<typeof providerDeleteResponseSchema>;
type ProviderStore = {
  list(): ProviderRecord[];
  get(id: string): ProviderRecord | null;
  create(input: CreateProviderRequest): ProviderRecord;
  update(id: string, patch: UpdateProviderRequest): ProviderRecord;
  delete(id: string): ProviderDeleteResponse;
};
function createInMemoryProviderStore() {
  const providers = new Map<string, ProviderRecord>();
  const store: ProviderStore = {
    list() {
      return [...providers.values()].map(cloneProvider);
    },
    get(id: string) {
      const provider = providers.get(id);
      return provider ? cloneProvider(provider) : null;
    },
    create(input: CreateProviderRequest) {
      if (providers.has(input.id)) {
        throw new BridgeApiError({
          statusCode: 409,
          code: "provider_exists",
          message: `Provider '${input.id}' already exists.`
        });
      }
      const timestamp = createTimestamp();
      const provider: ProviderRecord = {
        id: input.id,
        kind: input.kind,
        label: input.label,
        enabled: input.enabled,
        config: cloneConfig(input.config),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      providers.set(provider.id, provider);
      return cloneProvider(provider);
    },
    update(id: string, patch: UpdateProviderRequest) {
      const provider = providers.get(id);
      if (!provider) {
        throw missingProviderError(id);
      }
      const nextProvider: ProviderRecord = {
        ...provider,
        ...patch,
        config: patch.config === undefined ? provider.config : cloneConfig(patch.config),
        updatedAt: createTimestamp(provider.updatedAt)
      };
      providers.set(id, nextProvider);
      return cloneProvider(nextProvider);
    },
    delete(id: string) {
      if (!providers.delete(id)) {
        throw missingProviderError(id);
      }
      return providerDeleteResponseSchema.parse({
        ok: true,
        id
      });
    }
  };
  return store;
}
function createTimestamp(previous?: string) {
  const previousTime = previous ? Date.parse(previous) : 0;
  const now = Date.now();
  const nextTime = previousTime >= now ? previousTime + 1 : now;
  return new Date(nextTime).toISOString();
}
function cloneProvider(provider: ProviderRecord): ProviderRecord {
  return providerSchema.parse({
    ...provider,
    config: cloneConfig(provider.config)
  });
}
function cloneConfig(config: Record<string, unknown>) {
  return structuredClone(config);
}
function missingProviderError(id: string) {
  return new BridgeApiError({
    statusCode: 404,
    code: "provider_not_found",
    message: `Provider '${id}' was not found.`
  });
}

export const providerStoreModule = {
  providerSchema,
  createProviderRequestSchema,
  updateProviderRequestSchema,
  providerIdParamsSchema,
  providerResponseSchema,
  providerListResponseSchema,
  providerDeleteResponseSchema,
  createInMemoryProviderStore
};

export type {
  CreateProviderRequest,
  ProviderDeleteResponse,
  ProviderRecord,
  ProviderStore,
  UpdateProviderRequest
};
