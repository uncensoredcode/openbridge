import { z } from "zod";

import { bridgeApiErrorModule } from "../../shared/bridge-api-error.ts";
import type {
  CreateProviderRequest,
  ProviderDeleteResponse,
  ProviderRecord,
  UpdateProviderRequest
} from "./provider-store.ts";
import { providerStoreModule } from "./provider-store.ts";

const { createProviderRequestSchema, providerDeleteResponseSchema, providerSchema } =
  providerStoreModule;
const { BridgeApiError } = bridgeApiErrorModule;
const nonEmptyString = (field: string) => z.string().trim().min(1, `${field} is required.`);
const looseObjectSchema = z.object({}).catchall(z.unknown());
const sessionPackageLifecycleStatusSchema = z.enum(["active", "expired", "revoked", "invalid"]);
const transportFamilySchema = z.enum(["http-sse", "http-json", "http-connect"]);
const transportPackageSchema = z
  .object({
    family: transportFamilySchema,
    prompt: looseObjectSchema.optional(),
    binding: looseObjectSchema.optional(),
    session: looseObjectSchema.optional(),
    request: looseObjectSchema.optional(),
    response: looseObjectSchema.optional(),
    seedBinding: looseObjectSchema.optional(),
    bootstrap: looseObjectSchema.optional(),
    preflight: looseObjectSchema.optional()
  })
  .strict();
const integrationPackageSchema = z
  .object({
    label: nonEmptyString("label").optional(),
    enabled: z.boolean().optional(),
    models: z.array(nonEmptyString("model")).optional(),
    defaultModel: nonEmptyString("defaultModel").optional()
  })
  .strict();
const sessionPackageSchema = z
  .object({
    schemaVersion: z.number().int().min(1).optional(),
    source: nonEmptyString("source"),
    capturedAt: z.string().datetime({ offset: true }),
    origin: z.string().url(),
    cookies: z.array(looseObjectSchema).default([]),
    localStorage: looseObjectSchema.default({}),
    sessionStorage: looseObjectSchema.default({}),
    headers: looseObjectSchema.default({}),
    metadata: looseObjectSchema.default({}),
    integration: integrationPackageSchema.optional(),
    transport: transportPackageSchema.optional()
  })
  .strict();
const sessionPackageStatusResponseSchema = z
  .object({
    ok: z.literal(true),
    providerId: nonEmptyString("providerId"),
    hasSessionPackage: z.boolean(),
    source: nonEmptyString("source").optional(),
    capturedAt: z.string().datetime({ offset: true }).optional(),
    origin: z.string().url().optional()
  })
  .strict();
const sessionPackageDeleteResponseSchema = z
  .object({
    ok: z.literal(true),
    providerId: nonEmptyString("providerId")
  })
  .strict();
const sessionPackageMetadataSchema = z
  .object({
    handle: nonEmptyString("handle"),
    providerId: nonEmptyString("providerId"),
    source: nonEmptyString("source").optional(),
    capturedAt: z.string().datetime({ offset: true }).optional(),
    origin: z.string().url().optional(),
    hasSessionPackage: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }).optional(),
    lastVerifiedAt: z.string().datetime({ offset: true }).optional(),
    idleExpiresAt: z.string().datetime({ offset: true }).optional(),
    absoluteExpiresAt: z.string().datetime({ offset: true }).optional(),
    status: sessionPackageLifecycleStatusSchema,
    version: z.number().int().min(1)
  })
  .strict();
const installedProviderPackageSchema = z
  .object({
    provider: providerSchema,
    session: sessionPackageSchema.nullable()
  })
  .strict();
type SessionPackageRecord = z.infer<typeof sessionPackageSchema>;
type SessionPackageMetadata = z.infer<typeof sessionPackageMetadataSchema>;
type SessionPackageDeleteResponse = z.infer<typeof sessionPackageDeleteResponseSchema>;
type InstalledProviderPackage = z.infer<typeof installedProviderPackageSchema>;
type SessionPackageStore = {
  listProviders(): ProviderRecord[];
  getProvider(providerId: string): ProviderRecord | null;
  createProvider(input: CreateProviderRequest): ProviderRecord;
  updateProvider(providerId: string, patch: UpdateProviderRequest): ProviderRecord;
  get(providerId: string): SessionPackageRecord | null;
  getStatus(providerId: string): SessionPackageMetadata | null;
  put(providerId: string, value: SessionPackageRecord): SessionPackageMetadata;
  delete(providerId: string): SessionPackageDeleteResponse;
  deleteSession(providerId: string): SessionPackageDeleteResponse;
  listPackages(): InstalledProviderPackage[];
  getPackage(providerId: string): InstalledProviderPackage | null;
};
function createInMemorySessionPackageStore() {
  const packages = new Map<string, InstalledProviderPackage>();
  const metadata = new Map<string, SessionPackageMetadata>();
  const store: SessionPackageStore = {
    listProviders() {
      return [...packages.values()]
        .map((entry) => cloneProvider(entry.provider))
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    getProvider(providerId: string) {
      const stored = packages.get(providerId);
      return stored ? cloneProvider(stored.provider) : null;
    },
    createProvider(input: CreateProviderRequest) {
      if (packages.has(input.id)) {
        throw new BridgeApiError({
          statusCode: 409,
          code: "provider_exists",
          message: `Provider '${input.id}' already exists.`
        });
      }
      const timestamp = createTimestamp();
      const provider = providerSchema.parse({
        ...createProviderRequestSchema.parse(input),
        createdAt: timestamp,
        updatedAt: timestamp
      });
      packages.set(
        provider.id,
        installedProviderPackageSchema.parse({
          provider,
          session: null
        })
      );
      metadata.set(
        provider.id,
        buildSessionPackageMetadata(provider.id, null, {
          existing: metadata.get(provider.id) ?? null,
          now: timestamp
        })
      );
      return cloneProvider(provider);
    },
    updateProvider(providerId: string, patch: UpdateProviderRequest) {
      const stored = packages.get(providerId);
      if (!stored) {
        throw missingProviderError(providerId);
      }
      const nextProvider = providerSchema.parse({
        ...stored.provider,
        ...patch,
        config: patch.config === undefined ? stored.provider.config : cloneConfig(patch.config),
        updatedAt: createTimestamp(stored.provider.updatedAt)
      });
      const nextPackage = installedProviderPackageSchema.parse({
        provider: nextProvider,
        session: stored.session ? cloneSessionPackage(stored.session) : null
      });
      packages.set(providerId, nextPackage);
      metadata.set(
        providerId,
        buildSessionPackageMetadata(providerId, nextPackage.session, {
          existing: metadata.get(providerId) ?? null,
          now: nextProvider.updatedAt
        })
      );
      return cloneProvider(nextProvider);
    },
    get(providerId: string) {
      const stored = packages.get(providerId)?.session;
      return stored ? cloneSessionPackage(stored) : null;
    },
    getStatus(providerId: string) {
      const stored = metadata.get(providerId);
      return stored ? cloneSessionPackageMetadata(stored) : null;
    },
    put(providerId: string, value: SessionPackageRecord) {
      const normalized = cloneSessionPackage(value);
      const existing = packages.get(providerId);
      const now = createTimestamp(existing?.provider.updatedAt);
      const provider = inferProviderFromSessionPackage({
        providerId,
        value: normalized,
        existing: existing?.provider ?? null,
        now
      });
      packages.set(
        providerId,
        installedProviderPackageSchema.parse({
          provider,
          session: normalized
        })
      );
      const nextMetadata = buildSessionPackageMetadata(providerId, normalized, {
        existing: metadata.get(providerId) ?? null,
        now
      });
      metadata.set(providerId, nextMetadata);
      return cloneSessionPackageMetadata(nextMetadata);
    },
    delete(providerId: string) {
      if (!packages.delete(providerId)) {
        throw missingProviderError(providerId);
      }
      metadata.delete(providerId);
      return sessionPackageDeleteResponseSchema.parse({
        ok: true,
        providerId
      });
    },
    deleteSession(providerId: string) {
      const stored = packages.get(providerId);
      if (!stored) {
        throw missingProviderError(providerId);
      }
      packages.set(
        providerId,
        installedProviderPackageSchema.parse({
          provider: cloneProvider(stored.provider),
          session: null
        })
      );
      const now = createTimestamp(stored.provider.updatedAt);
      metadata.set(
        providerId,
        buildSessionPackageMetadata(providerId, null, {
          existing: metadata.get(providerId) ?? null,
          now
        })
      );
      return sessionPackageDeleteResponseSchema.parse({
        ok: true,
        providerId
      });
    },
    listPackages() {
      return [...packages.values()]
        .map(cloneInstalledProviderPackage)
        .sort((left, right) => left.provider.id.localeCompare(right.provider.id));
    },
    getPackage(providerId: string) {
      const stored = packages.get(providerId);
      return stored ? cloneInstalledProviderPackage(stored) : null;
    }
  };
  return store;
}
function buildSessionPackageStatus(providerId: string, stored: SessionPackageMetadata | null) {
  return sessionPackageStatusResponseSchema.parse({
    ok: true,
    providerId,
    hasSessionPackage: Boolean(stored?.hasSessionPackage),
    ...(stored?.hasSessionPackage
      ? {
          source: stored.source,
          capturedAt: stored.capturedAt,
          origin: stored.origin
        }
      : {})
  });
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
function cloneSessionPackage(value: SessionPackageRecord): SessionPackageRecord {
  return sessionPackageSchema.parse(structuredClone(value));
}
function cloneSessionPackageMetadata(value: SessionPackageMetadata): SessionPackageMetadata {
  return sessionPackageMetadataSchema.parse(structuredClone(value));
}
function cloneInstalledProviderPackage(value: InstalledProviderPackage): InstalledProviderPackage {
  return installedProviderPackageSchema.parse(structuredClone(value));
}
function buildSessionPackageMetadata(
  providerId: string,
  session: SessionPackageRecord | null,
  input: {
    existing: SessionPackageMetadata | null;
    now: string;
    handle?: string;
  }
) {
  return sessionPackageMetadataSchema.parse({
    handle: input.existing?.handle ?? input.handle ?? `memory:${providerId}`,
    providerId,
    source: session?.source,
    capturedAt: session?.capturedAt,
    origin: session?.origin,
    hasSessionPackage: Boolean(session),
    createdAt: input.existing?.createdAt ?? input.now,
    lastUsedAt: session ? input.now : input.existing?.lastUsedAt,
    lastVerifiedAt:
      readLifecycleIsoString(session?.metadata, "lastVerifiedAt") ?? input.existing?.lastVerifiedAt,
    idleExpiresAt: readLifecycleIsoString(session?.metadata, "idleExpiresAt"),
    absoluteExpiresAt: readLifecycleIsoString(session?.metadata, "absoluteExpiresAt"),
    status: "active",
    version: 1
  });
}
function inferProviderFromSessionPackage(input: {
  providerId: string;
  value: SessionPackageRecord;
  existing: ProviderRecord | null;
  now: string;
}) {
  const embeddedTransport = readEmbeddedTransport(input.value);
  const capturedTransport = inferTransportFromRequestCapture(input.value);
  const inferredTransport =
    embeddedTransport ??
    (shouldRefreshTransportFromCapture(input.existing, capturedTransport)
      ? capturedTransport
      : null);
  const explicitModels = readExplicitModelIds(input.value);
  const inferredModels = inferModelIdsFromCapture(input.value);
  const existingModels = readConfiguredModelIds(input.existing?.config);
  const nextModels = explicitModels ?? mergeModelIds(existingModels, inferredModels);
  return providerSchema.parse({
    id: input.providerId,
    kind: inferredTransport?.family ?? input.existing?.kind ?? "http-json",
    label: readLabel(input.value, input.providerId) ?? input.existing?.label ?? input.providerId,
    enabled: input.value.integration?.enabled ?? input.existing?.enabled ?? true,
    config: {
      ...(input.existing?.config ?? {}),
      ...(inferredTransport ? { transport: inferredTransport.config } : {}),
      models: nextModels
    },
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now
  });
}
function shouldRefreshTransportFromCapture(
  existing: ProviderRecord | null,
  capturedTransport: {
    family: z.infer<typeof transportFamilySchema>;
    config: Record<string, unknown>;
  } | null
) {
  if (!capturedTransport) {
    return false;
  }
  if (!existing) {
    return true;
  }
  const existingTransport = readConfiguredTransport(existing.config);
  if (!existingTransport) {
    return true;
  }
  const existingRequest =
    typeof existingTransport.request === "object" && existingTransport.request !== null
      ? (existingTransport.request as Record<string, unknown>)
      : null;
  const capturedRequest =
    typeof capturedTransport.config.request === "object" &&
    capturedTransport.config.request !== null
      ? (capturedTransport.config.request as Record<string, unknown>)
      : null;
  const existingUrl = typeof existingRequest?.url === "string" ? existingRequest.url.trim() : "";
  const capturedUrl = typeof capturedRequest?.url === "string" ? capturedRequest.url.trim() : "";
  if (existing.kind !== capturedTransport.family) {
    return true;
  }
  if (existingUrl && capturedUrl && existingUrl === capturedUrl) {
    return true;
  }
  return false;
}
function readEmbeddedTransport(value: SessionPackageRecord) {
  if (!value.transport) {
    return null;
  }
  const parsed = transportPackageSchema.safeParse(value.transport);
  if (!parsed.success) {
    return null;
  }
  const { family, ...config } = parsed.data;
  return {
    family,
    config
  };
}
function inferTransportFromRequestCapture(value: SessionPackageRecord) {
  const selectedRequest = readSelectedRequest(value.metadata);
  if (!selectedRequest?.url || !selectedRequest?.method) {
    return null;
  }
  const zaiConversationTransport = inferZaiConversationTransport(selectedRequest, value);
  if (zaiConversationTransport) {
    return zaiConversationTransport;
  }
  const qwenConversationTransport = inferQwenConversationTransport(selectedRequest, value);
  if (qwenConversationTransport) {
    return qwenConversationTransport;
  }
  const deepSeekConversationTransport = inferDeepSeekConversationTransport(selectedRequest, value);
  if (deepSeekConversationTransport) {
    return deepSeekConversationTransport;
  }
  const openAiConversationTransport = inferOpenAiConversationTransport(selectedRequest, value);
  if (openAiConversationTransport) {
    return openAiConversationTransport;
  }
  const family = readTransportFamily(selectedRequest);
  const requestBody = readTemplateRequestBody(selectedRequest);
  return {
    family,
    config: {
      prompt: {
        mode: "flatten"
      },
      binding: {
        firstTurn: "empty"
      },
      session: {
        requireCookie: Array.isArray(value.cookies) && value.cookies.length > 0,
        requireBearerToken: hasBearerAuthorization(value.headers),
        requireUserAgent: hasHeader(value.headers, "user-agent"),
        includeExtraHeaders: true
      },
      request: {
        method: String(selectedRequest.method).toUpperCase(),
        url: String(selectedRequest.url),
        headers: {},
        ...(requestBody === undefined ? {} : { body: requestBody })
      },
      response: {
        contentPaths:
          family === "http-sse"
            ? DEFAULT_SSE_CONTENT_PATHS
            : family === "http-connect"
              ? DEFAULT_CONNECT_CONTENT_PATHS
              : DEFAULT_JSON_CONTENT_PATHS,
        responseIdPaths: DEFAULT_RESPONSE_ID_PATHS,
        conversationIdPaths: DEFAULT_CONVERSATION_ID_PATHS,
        trimLeadingAssistantBlock: true
      }
    }
  };
}
function inferQwenConversationTransport(
  selectedRequest: Record<string, unknown>,
  value: SessionPackageRecord
) {
  const requestUrl = typeof selectedRequest.url === "string" ? selectedRequest.url.trim() : "";
  if (!isQwenConversationRequestUrl(requestUrl)) {
    return null;
  }
  const requestBody = readTemplateRequestBody(selectedRequest);
  const capturedBootstrapHeaders = readCapturedRequestHeaders(
    value.metadata,
    isQwenBootstrapRequestUrl
  );
  const bootstrapHeaders = mergeHeaderRecords(
    {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/"
    },
    capturedBootstrapHeaders
  );
  return {
    family: "http-sse" as const,
    config: {
      prompt: {
        mode: "flatten"
      },
      binding: {
        firstTurn: "seed"
      },
      session: {
        requireCookie: Array.isArray(value.cookies) && value.cookies.length > 0,
        requireBearerToken: hasBearerAuthorization(value.headers),
        requireUserAgent: hasHeader(value.headers, "user-agent"),
        includeExtraHeaders: true
      },
      request: {
        method: String(selectedRequest.method).toUpperCase(),
        url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id={{conversationId}}",
        headers: {},
        ...(requestBody === undefined ? {} : { body: requestBody })
      },
      response: {
        contentPaths: DEFAULT_SSE_CONTENT_PATHS,
        responseIdPaths: DEFAULT_RESPONSE_ID_PATHS,
        conversationIdPaths: ["response.created.chat_id", ...DEFAULT_CONVERSATION_ID_PATHS],
        eventFilters: [
          {
            path: "choices.0.delta.phase",
            equals: "answer"
          }
        ],
        trimLeadingAssistantBlock: true
      },
      bootstrap: {
        request: {
          method: "POST",
          url: "https://chat.qwen.ai/api/v2/chats/new",
          headers: bootstrapHeaders,
          body: buildQwenBootstrapRequestBody(selectedRequest)
        },
        conversationIdPath: "data.id"
      }
    }
  };
}
function inferDeepSeekConversationTransport(
  selectedRequest: Record<string, unknown>,
  value: SessionPackageRecord
) {
  const requestUrl = typeof selectedRequest.url === "string" ? selectedRequest.url.trim() : "";
  if (!isDeepSeekConversationRequestUrl(requestUrl)) {
    return null;
  }
  const requestBody = readTemplateRequestBody(selectedRequest);
  const capturedCompletionHeaders = omitHeaders(
    filterCapturedRequestHeaders(readSelectedRequestHeaders(selectedRequest)),
    ["x-ds-pow-response"]
  );
  const capturedBootstrapHeaders = omitHeaders(
    readCapturedRequestHeaders(value.metadata, isDeepSeekBootstrapRequestUrl),
    ["x-ds-pow-response"]
  );
  const capturedPreflightHeaders = omitHeaders(
    readCapturedRequestHeaders(value.metadata, isDeepSeekPowChallengeRequestUrl),
    ["x-ds-pow-response"]
  );
  const requestHeaders = mergeHeaderRecords(
    {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/"
    },
    capturedCompletionHeaders
  );
  const bootstrapHeaders = mergeHeaderRecords(
    {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/"
    },
    capturedBootstrapHeaders
  );
  const preflightHeaders = mergeHeaderRecords(
    {
      Accept: "*/*",
      "Content-Type": "application/json",
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/"
    },
    capturedPreflightHeaders
  );
  return {
    family: "http-sse" as const,
    config: {
      prompt: {
        mode: "flatten"
      },
      binding: {
        firstTurn: "empty"
      },
      session: {
        requireCookie: Array.isArray(value.cookies) && value.cookies.length > 0,
        requireBearerToken: hasBearerAuthorization(value.headers),
        requireUserAgent: hasHeader(value.headers, "user-agent"),
        includeExtraHeaders: false
      },
      request: {
        method: "POST",
        url: "https://chat.deepseek.com/api/v0/chat/completion",
        headers: requestHeaders,
        ...(requestBody === undefined ? {} : { body: requestBody })
      },
      response: {
        contentPaths: ["__bridge__.deepseek.response"],
        responseIdPaths: [
          "response_message_id",
          "chat_message.message_id",
          "data.biz_data.message_id",
          ...DEFAULT_RESPONSE_ID_PATHS
        ],
        conversationIdPaths: [
          "chat_message.chat_session_id",
          "data.biz_data.chat_session.id",
          "data.biz_data.chat_session_id",
          ...DEFAULT_CONVERSATION_ID_PATHS
        ],
        trimLeadingAssistantBlock: true
      },
      bootstrap: {
        request: {
          method: "POST",
          url: "https://chat.deepseek.com/api/v0/chat_session/create",
          headers: bootstrapHeaders,
          body: {}
        },
        conversationIdPath: "data.biz_data.chat_session.id"
      },
      preflight: {
        request: {
          method: "POST",
          url: "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
          headers: preflightHeaders,
          body: {
            target_path: "/api/v0/chat/completion"
          }
        },
        proofOfWork: {
          kind: "sha3-wasm-salt-expiry",
          headerName: "x-ds-pow-response",
          wasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm",
          algorithmPath: "data.biz_data.challenge.algorithm",
          challengePath: "data.biz_data.challenge.challenge",
          saltPath: "data.biz_data.challenge.salt",
          signaturePath: "data.biz_data.challenge.signature",
          difficultyPath: "data.biz_data.challenge.difficulty",
          expireAtPath: "data.biz_data.challenge.expire_at",
          targetPathPath: "data.biz_data.challenge.target_path"
        }
      }
    }
  };
}
function inferZaiConversationTransport(
  selectedRequest: Record<string, unknown>,
  value: SessionPackageRecord
) {
  const requestUrl = typeof selectedRequest.url === "string" ? selectedRequest.url.trim() : "";
  if (!isZaiConversationRequestUrl(requestUrl)) {
    return null;
  }
  const capturedBootstrapHeaders = readCapturedRequestHeaders(
    value.metadata,
    isZaiBootstrapRequestUrl
  );
  const bootstrapHeaders = mergeHeaderRecords(
    {
      Accept: "application/json",
      "Accept-Language": "en-US",
      Connection: "keep-alive",
      "Content-Type": "application/json",
      Origin: "https://chat.z.ai",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin"
    },
    capturedBootstrapHeaders
  );
  return {
    family: "http-sse" as const,
    config: {
      prompt: {
        mode: "latest_user"
      },
      binding: {
        firstTurn: "seed"
      },
      session: {
        requireCookie: Array.isArray(value.cookies) && value.cookies.length > 0,
        requireBearerToken: hasBearerAuthorization(value.headers),
        requireUserAgent: hasHeader(value.headers, "user-agent"),
        includeExtraHeaders: true
      },
      request: {
        method: "POST",
        url: "https://chat.z.ai/api/v2/chat/completions",
        headers: {
          Accept: "*/*",
          "Accept-Language": "en-US",
          Connection: "keep-alive",
          "Content-Type": "application/json",
          Origin: "https://chat.z.ai",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "X-FE-Version": "prod-fe-1.1.2"
        },
        signing: {
          kind: "z-ai-v1"
        },
        body: {
          stream: true,
          model: "{{modelId}}",
          messages: [
            {
              role: "user",
              content: "{{prompt}}"
            }
          ],
          signature_prompt: "{{prompt}}",
          params: {},
          extra: {},
          features: {
            image_generation: false,
            web_search: false,
            auto_web_search: false,
            preview_mode: true,
            flags: [],
            vlm_tools_enable: false,
            vlm_web_search_enable: false,
            vlm_website_mode: false,
            enable_thinking: "{{thinkingEnabledOrTrue}}"
          },
          variables: {
            "{{USER_NAME}}": "{{userName}}",
            "{{USER_LOCATION}}": "Unknown",
            "{{CURRENT_DATETIME}}": "{{currentDateTime}}",
            "{{CURRENT_DATE}}": "{{currentDate}}",
            "{{CURRENT_TIME}}": "{{currentTime}}",
            "{{CURRENT_WEEKDAY}}": "{{currentWeekday}}",
            "{{CURRENT_TIMEZONE}}": "{{currentTimezone}}",
            "{{USER_LANGUAGE}}": "{{userLanguage}}"
          },
          chat_id: "{{conversationId}}",
          id: "{{assistantMessageId}}",
          current_user_message_id: "{{userMessageId}}",
          current_user_message_parent_id: "{{parentIdOrNull}}",
          background_tasks: {
            title_generation: true,
            tags_generation: true
          }
        }
      },
      response: {
        contentPaths: ["data.delta_content"],
        eventFilters: [
          {
            path: "data.phase",
            equals: "answer"
          }
        ],
        fallbackResponseId: "assistantMessageId",
        trimLeadingAssistantBlock: false
      },
      bootstrap: {
        request: {
          method: "POST",
          url: "https://chat.z.ai/api/v1/chats/new",
          headers: bootstrapHeaders,
          body: {
            chat: {
              id: "",
              title: "New Chat",
              models: ["{{modelId}}"],
              params: {},
              history: {
                messages: {
                  "bootstrap-user": {
                    id: "bootstrap-user",
                    parentId: null,
                    childrenIds: [],
                    role: "user",
                    content: "{{prompt}}",
                    timestamp: "{{unixTimestampSec}}",
                    models: ["{{modelId}}"]
                  }
                },
                currentId: "bootstrap-user"
              },
              tags: [],
              flags: [],
              features: [
                { type: "mcp", server: "vibe-coding", status: "hidden" },
                { type: "mcp", server: "ppt-maker", status: "hidden" },
                { type: "mcp", server: "image-search", status: "hidden" },
                { type: "mcp", server: "deep-research", status: "hidden" },
                { type: "tool_selector", server: "tool_selector", status: "hidden" }
              ],
              mcp_servers: [],
              enable_thinking: "{{thinkingEnabledOrTrue}}",
              auto_web_search: false,
              message_version: 1,
              extra: {},
              timestamp: "{{unixTimestampMs}}",
              type: "default"
            }
          }
        },
        conversationIdPath: "id"
      }
    }
  };
}
function inferOpenAiConversationTransport(
  selectedRequest: Record<string, unknown>,
  value: SessionPackageRecord
) {
  const requestUrl = typeof selectedRequest.url === "string" ? selectedRequest.url.trim() : "";
  if (!isOpenAiConversationRequestUrl(requestUrl)) {
    return null;
  }
  return {
    family: "http-sse" as const,
    config: {
      prompt: {
        mode: "auto_join"
      },
      binding: {
        firstTurn: "empty"
      },
      session: {
        requireCookie: Array.isArray(value.cookies) && value.cookies.length > 0,
        requireBearerToken: hasBearerAuthorization(value.headers),
        requireUserAgent: hasHeader(value.headers, "user-agent"),
        includeExtraHeaders: true
      },
      request: {
        method: String(selectedRequest.method).toUpperCase(),
        url: requestUrl,
        headers: {},
        body: buildOpenAiConversationRequestBody(readRequestBodyObject(selectedRequest))
      },
      response: {
        contentPaths: ["v.message.content.parts.*", "message.content.parts.*"],
        responseIdPaths: ["v.message.id", "message.id"],
        conversationIdPaths: ["conversation_id", "v.conversation_id"],
        allowVisibleTextFinal: true,
        trimLeadingAssistantBlock: false
      }
    }
  };
}
function readCapturedRequestHeaders(
  metadata: Record<string, unknown>,
  matcher: (url: string) => boolean
) {
  const requests = readCapturedRequests(metadata);
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    const url = typeof request.url === "string" ? request.url.trim() : "";
    if (!url || !matcher(url)) {
      continue;
    }
    return filterCapturedRequestHeaders(readSelectedRequestHeaders(request));
  }
  return {};
}
function omitHeaders(source: Record<string, unknown>, names: string[]) {
  if (Object.keys(source).length === 0 || names.length === 0) {
    return source;
  }
  const excluded = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !excluded.has(key.toLowerCase()))
  );
}
function readCapturedRequests(metadata: Record<string, unknown>) {
  const capture = metadata.requestCapture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    return [];
  }
  const requests = (capture as Record<string, unknown>).requests;
  return Array.isArray(requests)
    ? requests.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
      )
    : [];
}
function filterCapturedRequestHeaders(headers: Record<string, unknown> | null) {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => {
      if (typeof value !== "string" || !value.trim()) {
        return [];
      }
      const normalized = key.toLowerCase();
      if (
        normalized === "cookie" ||
        normalized === "authorization" ||
        normalized === "user-agent" ||
        normalized === "content-length"
      ) {
        return [];
      }
      return [[key, value.trim()]];
    })
  );
}
function mergeHeaderRecords(...sources: Array<Record<string, unknown>>) {
  const merged: Record<string, string> = {};
  const canonicalKeys = new Map<string, string>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string" || !value.trim()) {
        continue;
      }
      const normalized = key.toLowerCase();
      const existingKey = canonicalKeys.get(normalized);
      if (existingKey && existingKey !== key) {
        delete merged[existingKey];
      }
      canonicalKeys.set(normalized, key);
      merged[key] = value.trim();
    }
  }
  return merged;
}
function isZaiConversationRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    return (
      url.hostname.toLowerCase() === "chat.z.ai" &&
      /^\/api\/v2\/chat\/completions\/?$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function isOpenAiConversationRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    const normalizedHost = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.toLowerCase();
    return (
      (normalizedHost === "chatgpt.com" || normalizedHost.endsWith(".chatgpt.com")) &&
      /^\/backend-api(?:\/f)?\/conversation\/?$/.test(normalizedPath)
    );
  } catch {
    return false;
  }
}
function isQwenConversationRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    const normalizedHost = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.toLowerCase();
    return (
      (normalizedHost === "chat.qwen.ai" || normalizedHost.endsWith(".chat.qwen.ai")) &&
      normalizedPath === "/api/v2/chat/completions"
    );
  } catch {
    return false;
  }
}
function isQwenBootstrapRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    const normalizedHost = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.toLowerCase();
    return (
      (normalizedHost === "chat.qwen.ai" || normalizedHost.endsWith(".chat.qwen.ai")) &&
      normalizedPath === "/api/v2/chats/new"
    );
  } catch {
    return false;
  }
}
function isDeepSeekConversationRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    const normalizedHost = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.toLowerCase();
    return (
      (normalizedHost === "chat.deepseek.com" || normalizedHost.endsWith(".chat.deepseek.com")) &&
      normalizedPath === "/api/v0/chat/completion"
    );
  } catch {
    return false;
  }
}
function isDeepSeekBootstrapRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    const normalizedHost = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.toLowerCase();
    return (
      (normalizedHost === "chat.deepseek.com" || normalizedHost.endsWith(".chat.deepseek.com")) &&
      normalizedPath === "/api/v0/chat_session/create"
    );
  } catch {
    return false;
  }
}
function isDeepSeekPowChallengeRequestUrl(requestUrl: string) {
  if (!requestUrl) {
    return false;
  }
  try {
    const url = new URL(requestUrl);
    const normalizedHost = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.toLowerCase();
    return (
      (normalizedHost === "chat.deepseek.com" || normalizedHost.endsWith(".chat.deepseek.com")) &&
      normalizedPath === "/api/v0/chat/create_pow_challenge"
    );
  } catch {
    return false;
  }
}
function buildQwenBootstrapRequestBody(selectedRequest: Record<string, unknown>) {
  const requestBody = readRequestBodyObject(selectedRequest);
  const topLevelChatType =
    typeof requestBody?.chat_type === "string" && requestBody.chat_type.trim()
      ? requestBody.chat_type.trim()
      : "";
  const topLevelChatMode =
    typeof requestBody?.chat_mode === "string" && requestBody.chat_mode.trim()
      ? requestBody.chat_mode.trim()
      : "";
  const projectId = typeof requestBody?.project_id === "string" ? requestBody.project_id : "";
  const firstMessage =
    Array.isArray(requestBody?.messages) &&
    requestBody.messages.length > 0 &&
    typeof requestBody.messages[0] === "object" &&
    requestBody.messages[0] !== null
      ? (requestBody.messages[0] as Record<string, unknown>)
      : null;
  const messageChatType =
    typeof firstMessage?.chat_type === "string" && firstMessage.chat_type.trim()
      ? firstMessage.chat_type.trim()
      : "";
  const messageSubChatType =
    typeof firstMessage?.sub_chat_type === "string" && firstMessage.sub_chat_type.trim()
      ? firstMessage.sub_chat_type.trim()
      : "";
  return {
    title: "New Chat",
    models: ["{{modelId}}"],
    chat_mode: topLevelChatMode || "normal",
    chat_type: topLevelChatType || messageChatType || messageSubChatType || "t2t",
    timestamp: "{{unixTimestampMs}}",
    project_id: projectId
  };
}
function buildOpenAiConversationRequestBody(requestBody: Record<string, unknown> | null) {
  const base = requestBody ? structuredClone(requestBody) : {};
  const capturedMessage =
    Array.isArray(requestBody?.messages) &&
    requestBody.messages.length > 0 &&
    typeof requestBody.messages[0] === "object" &&
    requestBody.messages[0] !== null
      ? (requestBody.messages[0] as Record<string, unknown>)
      : null;
  const nextBody: Record<string, unknown> = {
    ...base,
    action:
      typeof requestBody?.action === "string" && requestBody.action.trim()
        ? requestBody.action
        : "next",
    messages: [buildOpenAiConversationUserMessage(capturedMessage)],
    parent_message_id: "{{parentIdOrClientCreatedRoot}}",
    model: "{{modelId}}"
  };
  delete nextBody.conversation_id;
  delete nextBody.conversationId;
  return nextBody;
}
function buildOpenAiConversationUserMessage(capturedMessage: Record<string, unknown> | null) {
  const base = capturedMessage ? structuredClone(capturedMessage) : {};
  const author =
    capturedMessage?.author &&
    typeof capturedMessage.author === "object" &&
    !Array.isArray(capturedMessage.author)
      ? structuredClone(capturedMessage.author as Record<string, unknown>)
      : {};
  const content =
    capturedMessage?.content &&
    typeof capturedMessage.content === "object" &&
    !Array.isArray(capturedMessage.content)
      ? structuredClone(capturedMessage.content as Record<string, unknown>)
      : {};
  return {
    ...base,
    id: "{{messageId}}",
    author: {
      ...author,
      role: "user"
    },
    create_time: "{{unixTimestampSec}}",
    content: {
      ...content,
      content_type:
        typeof content.content_type === "string" && content.content_type.trim()
          ? content.content_type
          : "text",
      parts: ["{{prompt}}"]
    }
  };
}
function readTemplateRequestBody(selectedRequest: Record<string, unknown>) {
  const requestBodyJson = selectedRequest.requestBodyJson;
  if (requestBodyJson && typeof requestBodyJson === "object" && !Array.isArray(requestBodyJson)) {
    return templateRequestValue(requestBodyJson, {
      parentKey: "",
      parentRole: ""
    });
  }
  const requestBodyText =
    typeof selectedRequest.requestBodyText === "string"
      ? selectedRequest.requestBodyText.trim()
      : "";
  if (!requestBodyText) {
    return undefined;
  }
  const contentType = readSelectedRequestContentType(selectedRequest);
  if (isConnectJsonContentType(contentType)) {
    const connectJson = decodeConnectJsonBody(requestBodyText);
    if (connectJson && typeof connectJson === "object" && !Array.isArray(connectJson)) {
      return templateRequestValue(connectJson, {
        parentKey: "",
        parentRole: ""
      });
    }
  }
  try {
    return templateRequestValue(JSON.parse(requestBodyText), {
      parentKey: "",
      parentRole: ""
    });
  } catch {
    return requestBodyText;
  }
}
function readSeedBinding(selectedRequest: Record<string, unknown>) {
  const requestBodyJson = readRequestBodyObject(selectedRequest);
  const requestUrl = typeof selectedRequest.url === "string" ? selectedRequest.url : "";
  const conversationId =
    readConversationIdFromUrl(requestUrl) ||
    readFirstNestedStringByKeys(requestBodyJson, [
      "chat_id",
      "chat_session_id",
      "chatSessionId",
      "conversation_id",
      "conversationId",
      "thread_id",
      "threadId",
      "session_id",
      "sessionId"
    ]);
  const parentId = readFirstNestedStringByKeys(requestBodyJson, [
    "parent_id",
    "parentId",
    "parent_message_id",
    "parentMessageId",
    "message_id",
    "messageId"
  ]);
  return conversationId
    ? {
        seedBinding: {
          conversationId,
          ...(parentId ? { parentId } : {})
        }
      }
    : {};
}
function readConversationIdFromUrl(requestUrl: string) {
  if (!requestUrl) {
    return "";
  }
  try {
    const url = new URL(requestUrl);
    for (const key of [
      "chat_id",
      "chat_session_id",
      "chatSessionId",
      "conversation_id",
      "conversationId",
      "thread_id",
      "threadId",
      "session_id",
      "sessionId"
    ]) {
      const value = url.searchParams.get(key);
      if (value?.trim()) {
        return value.trim();
      }
    }
  } catch {
    return "";
  }
  return "";
}
function readFirstStringByKeys(value: Record<string, unknown> | null, keys: string[]) {
  if (!value) {
    return "";
  }
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      return String(entry);
    }
  }
  return "";
}
function readFirstNestedStringByKeys(
  value: Record<string, unknown> | null,
  keys: string[]
): string {
  if (!value) {
    return "";
  }
  const direct = readFirstStringByKeys(value, keys);
  if (direct) {
    return direct;
  }
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          continue;
        }
        const nested: string = readFirstNestedStringByKeys(item as Record<string, unknown>, keys);
        if (nested) {
          return nested;
        }
      }
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const nested: string = readFirstNestedStringByKeys(entry as Record<string, unknown>, keys);
    if (nested) {
      return nested;
    }
  }
  return "";
}
function templateRequestValue(
  value: unknown,
  context: {
    parentKey: string;
    parentRole: string;
  }
): unknown {
  if (Array.isArray(value)) {
    if (/^children(ids|_ids)?$/i.test(context.parentKey)) {
      return [];
    }
    return value.map((entry) => templateRequestValue(entry, context));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const nextRole =
      typeof record.role === "string" ? record.role.toLowerCase() : context.parentRole;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        templateRequestValue(entry, {
          parentKey: key,
          parentRole: nextRole
        })
      ])
    );
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const key = context.parentKey.toLowerCase();
    if (/(^|_)(parent|parentid|parent_id|messageid|message_id)$/.test(key)) {
      return "{{parentIdNumberOrOmit}}";
    }
    if (/(^|_)(timestamp|time|ts)$/.test(key)) {
      return value >= 1000000000000 ? "{{unixTimestampMs}}" : "{{unixTimestampSec}}";
    }
    return value;
  }
  if (typeof value === "boolean") {
    const key = context.parentKey.toLowerCase();
    if (key === "thinking") {
      return value ? "{{thinkingEnabledOrTrue}}" : "{{thinkingEnabledOrFalse}}";
    }
    return value;
  }
  if (typeof value !== "string") {
    return value;
  }
  const key = context.parentKey.toLowerCase();
  const role = context.parentRole.toLowerCase();
  if (key === "fid") {
    return "{{messageId}}";
  }
  if ((key === "message_id" || key === "messageid") && value.trim() === "") {
    return value;
  }
  if (
    /(^|_)(parent|parentid|parent_id|messageid|message_id)$/.test(key) &&
    /^-?(?:0|[1-9]\d*)$/.test(value.trim())
  ) {
    return "{{parentIdNumberOrOmit}}";
  }
  if (/(^|_)(model|modelid|model_id|models)$/.test(key)) {
    return "{{modelId}}";
  }
  if (/(^|_)(trace|request|requestid|request_id)$/.test(key)) {
    return "{{requestUuid}}";
  }
  if (/(^|_)(conversation|chat|session|thread)(id|_id)?$/.test(key)) {
    return "{{conversationIdOrOmit}}";
  }
  if (/(^|_)(parent|parentid|parent_id|messageid|message_id)$/.test(key)) {
    return "{{parentIdOrOmit}}";
  }
  if (/(^|_)(prompt|input|query|text|message)$/.test(key)) {
    return "{{prompt}}";
  }
  if (key === "content" && (!role || role === "user")) {
    return "{{prompt}}";
  }
  return value;
}
function readExplicitModelIds(value: SessionPackageRecord) {
  const integrationModels =
    value.integration?.models?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (integrationModels.length > 0) {
    return [...new Set(integrationModels)].sort((left, right) => left.localeCompare(right));
  }
  const metadataModels = readMetadataModelCatalog(value.metadata);
  if (metadataModels.length > 0) {
    return metadataModels;
  }
  return null;
}
function inferModelIdsFromCapture(value: SessionPackageRecord) {
  const selectedRequest = readSelectedRequest(value.metadata);
  const topLevelModelHints = Array.isArray(selectedRequest?.modelHints)
    ? selectedRequest.modelHints
    : [];
  const inferred =
    typeof selectedRequest?.inferred === "object" && selectedRequest.inferred !== null
      ? (selectedRequest.inferred as Record<string, unknown>)
      : null;
  const inferredModelHints = Array.isArray(inferred?.modelHints) ? inferred.modelHints : [];
  const mirroredSelectedRequest =
    typeof value.metadata.selectedRequest === "object" && value.metadata.selectedRequest !== null
      ? (value.metadata.selectedRequest as Record<string, unknown>)
      : null;
  const mirroredModelHints = Array.isArray(mirroredSelectedRequest?.modelHints)
    ? mirroredSelectedRequest.modelHints
    : [];
  const rawModelHints = [...topLevelModelHints, ...inferredModelHints, ...mirroredModelHints];
  return [
    ...new Set(
      rawModelHints
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
    )
  ]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}
function readMetadataModelCatalog(metadata: Record<string, unknown>) {
  const explicitLists = [metadata.availableModels, metadata.supportedModels, metadata.modelCatalog];
  for (const candidate of explicitLists) {
    const parsed = normalizeModelCatalogEntries(candidate);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}
function normalizeModelCatalogEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.flatMap((entry) => {
        if (typeof entry === "string") {
          const normalized = entry.trim();
          return normalized ? [normalized] : [];
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return [];
        }
        for (const key of ["id", "model", "name"]) {
          const candidate = (entry as Record<string, unknown>)[key];
          if (typeof candidate === "string" && candidate.trim()) {
            return [candidate.trim()];
          }
        }
        return [];
      })
    )
  ].sort((left, right) => left.localeCompare(right));
}
function mergeModelIds(existing: string[], inferred: string[]) {
  return [...new Set([...existing, ...inferred])].sort((left, right) => left.localeCompare(right));
}
function readLabel(value: SessionPackageRecord, fallback: string) {
  const explicit = value.integration?.label?.trim();
  if (explicit) {
    return explicit;
  }
  const metadata = value.metadata as Record<string, unknown>;
  const title = typeof metadata.tabTitle === "string" ? metadata.tabTitle.trim() : "";
  if (title) {
    return title;
  }
  try {
    return new URL(value.origin).hostname;
  } catch {
    return fallback;
  }
}
function readSelectedRequest(metadata: Record<string, unknown>) {
  const capture = metadata.requestCapture;
  if (typeof capture !== "object" || capture === null) {
    return null;
  }
  const selectedRequest = (capture as Record<string, unknown>).selectedRequest;
  return typeof selectedRequest === "object" && selectedRequest !== null
    ? (selectedRequest as Record<string, unknown>)
    : null;
}
function readUsesSse(selectedRequest: Record<string, unknown>) {
  if (selectedRequest.usesSse === true) {
    return true;
  }
  const inferred = selectedRequest.inferred;
  if (
    typeof inferred === "object" &&
    inferred !== null &&
    (inferred as Record<string, unknown>).usesSse === true
  ) {
    return true;
  }
  return false;
}
function readTransportFamily(selectedRequest: Record<string, unknown>) {
  if (readUsesSse(selectedRequest)) {
    return "http-sse" as const;
  }
  if (isConnectJsonContentType(readSelectedRequestContentType(selectedRequest))) {
    return "http-connect" as const;
  }
  return "http-json" as const;
}
function readSelectedRequestContentType(selectedRequest: Record<string, unknown>) {
  const direct = selectedRequest.contentType;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const headers = readSelectedRequestHeaders(selectedRequest);
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    return "";
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1];
  return typeof entry === "string" ? entry.trim() : "";
}
function readSelectedRequestHeaders(selectedRequest: Record<string, unknown>) {
  for (const key of ["headers", "requestHeaders"]) {
    const candidate = selectedRequest[key];
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return null;
}
function isConnectJsonContentType(value: string) {
  return /^application\/connect\+json\b/i.test(value.trim());
}
function isZaiBootstrapRequestUrl(value: string) {
  try {
    const url = new URL(value);
    return url.origin === "https://chat.z.ai" && url.pathname === "/api/v1/chats/new";
  } catch {
    return false;
  }
}
function readRequestBodyObject(selectedRequest: Record<string, unknown>) {
  const requestBodyJson = selectedRequest.requestBodyJson;
  if (requestBodyJson && typeof requestBodyJson === "object" && !Array.isArray(requestBodyJson)) {
    return requestBodyJson as Record<string, unknown>;
  }
  const requestBodyText =
    typeof selectedRequest.requestBodyText === "string"
      ? selectedRequest.requestBodyText.trim()
      : "";
  if (!requestBodyText) {
    return null;
  }
  if (isConnectJsonContentType(readSelectedRequestContentType(selectedRequest))) {
    const decoded = decodeConnectJsonBody(requestBodyText);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  }
  try {
    const parsed = JSON.parse(requestBodyText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function decodeConnectJsonBody(value: string) {
  const encoded = value.trim();
  if (!encoded) {
    return null;
  }
  const bytes = Uint8Array.from(encoded, (char) => char.charCodeAt(0) & 0xff);
  if (bytes.length >= 5) {
    const length =
      ((bytes[1] ?? 0) << 24) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0);
    if (length > 0 && bytes.length >= 5 + length) {
      const payload = new TextDecoder().decode(bytes.slice(5, 5 + length)).trim();
      if (payload) {
        try {
          return JSON.parse(payload) as unknown;
        } catch {
          // Fall through to the textual JSON-start recovery path below.
        }
      }
    }
  }
  const jsonStart = [...encoded].findIndex((char) => char === "{" || char === "[");
  if (jsonStart < 0) {
    return null;
  }
  try {
    return JSON.parse(encoded.slice(jsonStart).trim()) as unknown;
  } catch {
    return null;
  }
}
function readConfiguredModelIds(config: Record<string, unknown> | undefined) {
  if (!config || !Array.isArray(config.models)) {
    return [];
  }
  return [
    ...new Set(
      config.models
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
    )
  ]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}
function readConfiguredTransport(config: Record<string, unknown> | undefined) {
  if (!config) {
    return null;
  }
  const transport = config.transport;
  if (typeof transport !== "object" || transport === null || Array.isArray(transport)) {
    return null;
  }
  return transport as Record<string, unknown>;
}
function hasBearerAuthorization(headers: Record<string, unknown>) {
  const authorization = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "authorization"
  )?.[1];
  return typeof authorization === "string" && /^Bearer\s+\S+/i.test(authorization);
}
function hasHeader(headers: Record<string, unknown>, headerName: string) {
  const target = headerName.toLowerCase();
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === target && typeof value === "string" && value.trim()
  );
}
function readLifecycleIsoString(
  value: unknown,
  key: "idleExpiresAt" | "absoluteExpiresAt" | "lastVerifiedAt"
) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  if (typeof candidate !== "string") {
    return undefined;
  }
  return z.string().datetime({ offset: true }).safeParse(candidate).success ? candidate : undefined;
}
function createTimestamp(previous?: string) {
  const previousTime = previous ? Date.parse(previous) : 0;
  const now = Date.now();
  const nextTime = previousTime >= now ? previousTime + 1 : now;
  return new Date(nextTime).toISOString();
}
function missingProviderError(id: string) {
  return new BridgeApiError({
    statusCode: 404,
    code: "provider_not_found",
    message: `Provider '${id}' was not found.`
  });
}
const DEFAULT_SSE_CONTENT_PATHS = [
  "v.message.content.parts.*",
  "message.content.parts.*",
  "choices.0.delta.content",
  "data.choices.0.delta.content",
  "v.response.fragments.*.content",
  "response.fragments.*.content",
  "delta.content",
  "content"
];
const DEFAULT_CONNECT_CONTENT_PATHS = [
  "choices.0.delta.content",
  "data.choices.0.delta.content",
  "message.content",
  "message.blocks.*.text.content",
  "block.text.content",
  "blocks.*.text.content",
  "delta.content",
  "text",
  "content"
];
const DEFAULT_JSON_CONTENT_PATHS = [
  "choices.0.message.content",
  "message.content",
  "output_text",
  "content",
  "data.content"
];
const DEFAULT_RESPONSE_ID_PATHS = [
  "v.message.id",
  "response_id",
  "response_message_id",
  "id",
  "message.id",
  "message_id",
  "block.messageId",
  "data.id",
  "response.id",
  "response.message_id",
  "v.response.message_id"
];
const DEFAULT_CONVERSATION_ID_PATHS = [
  "v.conversation_id",
  "conversation_id",
  "conversation.id",
  "conversationId",
  "chat.id",
  "chat_id",
  "thread.id",
  "thread_id",
  "threadId",
  "session.id",
  "session_id",
  "sessionId",
  "data.conversation_id",
  "data.chat_id",
  "data.thread_id",
  "response.conversation_id"
];

export const sessionPackageStoreModule = {
  sessionPackageSchema,
  sessionPackageStatusResponseSchema,
  sessionPackageDeleteResponseSchema,
  sessionPackageMetadataSchema,
  installedProviderPackageSchema,
  createInMemorySessionPackageStore,
  buildSessionPackageStatus,
  cloneProvider,
  cloneConfig,
  cloneSessionPackage,
  cloneSessionPackageMetadata,
  cloneInstalledProviderPackage,
  buildSessionPackageMetadata,
  inferProviderFromSessionPackage
};

export type {
  InstalledProviderPackage,
  SessionPackageDeleteResponse,
  SessionPackageMetadata,
  SessionPackageRecord,
  SessionPackageStore
};
