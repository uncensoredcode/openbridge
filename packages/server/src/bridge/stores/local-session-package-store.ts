import crypto from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import { bridgeApiErrorModule } from "../../shared/bridge-api-error.ts";
import type {
  CreateProviderRequest as ProviderCreateProviderRequest,
  UpdateProviderRequest as ProviderUpdateProviderRequest
} from "./provider-store.ts";
import { providerStoreModule } from "./provider-store.ts";
import type {
  InstalledProviderPackage,
  SessionPackageMetadata,
  SessionPackageRecord,
  SessionPackageStore
} from "./session-package-store.ts";
import { sessionPackageStoreModule } from "./session-package-store.ts";

const {
  buildQwenConversationRequestBody,
  buildSessionPackageMetadata,
  cloneConfig,
  cloneInstalledProviderPackage,
  cloneProvider,
  cloneSessionPackage,
  cloneSessionPackageMetadata,
  inferProviderFromSessionPackage,
  installedProviderPackageSchema,
  sessionPackageDeleteResponseSchema,
  sessionPackageSchema,
  sessionPackageMetadataSchema
} = sessionPackageStoreModule;
const { createProviderRequestSchema, providerDeleteResponseSchema, providerSchema } =
  providerStoreModule;
const { BridgeApiError } = bridgeApiErrorModule;
const SESSION_VAULT_VERSION = 1;
const SESSION_VAULT_ALGORITHM = "aes-256-gcm";
const SESSION_VAULT_KEY_BYTES = 32;
const vaultIndexSchema = z
  .object({
    version: z.literal(SESSION_VAULT_VERSION),
    sessions: z.record(z.string(), sessionPackageMetadataSchema)
  })
  .strict();
const vaultEntrySchema = z
  .object({
    version: z.literal(SESSION_VAULT_VERSION),
    algorithm: z.literal(SESSION_VAULT_ALGORITHM),
    handle: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    metadata: sessionPackageMetadataSchema,
    iv: z.string().trim().min(1),
    authTag: z.string().trim().min(1),
    ciphertext: z.string().trim().min(1)
  })
  .strict();
const legacySessionPackageMetadataSchema = z
  .object({
    handle: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    source: z.string().trim().min(1).optional(),
    capturedAt: z.string().datetime({ offset: true }).optional(),
    origin: z.string().url().optional(),
    createdAt: z.string().datetime({ offset: true }),
    lastUsedAt: z.string().datetime({ offset: true }).optional(),
    lastVerifiedAt: z.string().datetime({ offset: true }).optional(),
    idleExpiresAt: z.string().datetime({ offset: true }).optional(),
    absoluteExpiresAt: z.string().datetime({ offset: true }).optional(),
    status: sessionPackageMetadataSchema.shape.status,
    version: z.number().int().min(1)
  })
  .strict();
const legacyVaultIndexSchema = z
  .object({
    version: z.literal(SESSION_VAULT_VERSION),
    sessions: z.record(z.string(), legacySessionPackageMetadataSchema)
  })
  .strict();
const legacyVaultEntrySchema = z
  .object({
    version: z.literal(SESSION_VAULT_VERSION),
    algorithm: z.literal(SESSION_VAULT_ALGORITHM),
    handle: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    metadata: legacySessionPackageMetadataSchema,
    iv: z.string().trim().min(1),
    authTag: z.string().trim().min(1),
    ciphertext: z.string().trim().min(1)
  })
  .strict();
type VaultIndex = z.infer<typeof vaultIndexSchema>;
type VaultEntry = z.infer<typeof vaultEntrySchema>;
type LocalSessionPackageStoreOptions = {
  vaultPath: string;
  keyPath: string;
  keyMaterial?: string | null;
  now?: () => string;
  testHooks?: {
    afterTempWrite?: (targetPath: string, tempPath: string) => void;
  };
};
class SessionPackageVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPackageVaultError";
  }
}
function clearLocalSessionVault(input: { vaultPath: string }) {
  const vaultPath = path.resolve(input.vaultPath);
  const entriesPath = path.join(vaultPath, "entries");
  const indexPath = path.join(vaultPath, "index.json");
  const archivedEntriesPath = existsSync(entriesPath)
    ? `${entriesPath}.${crypto.randomUUID()}.clearing`
    : null;
  ensureSecureDir(vaultPath);
  try {
    if (archivedEntriesPath) {
      renameSync(entriesPath, archivedEntriesPath);
    }
    ensureSecureDir(entriesPath);
    writeAtomicJson(
      indexPath,
      vaultIndexSchema.parse({
        version: SESSION_VAULT_VERSION,
        sessions: {}
      })
    );
  } catch (error) {
    try {
      if (archivedEntriesPath && existsSync(archivedEntriesPath)) {
        rmSync(entriesPath, {
          recursive: true,
          force: true
        });
        renameSync(archivedEntriesPath, entriesPath);
      }
    } catch {}
    if (error instanceof SessionPackageVaultError) {
      throw error;
    }
    throw new SessionPackageVaultError("Failed to clear session vault data.");
  }
  if (!archivedEntriesPath) {
    return;
  }
  try {
    rmSync(archivedEntriesPath, {
      recursive: true,
      force: true
    });
  } catch {
    throw new SessionPackageVaultError("Failed to remove previous session vault entries.");
  }
}
function createLocalSessionPackageStore(
  options: LocalSessionPackageStoreOptions
): SessionPackageStore {
  const vaultPath = path.resolve(options.vaultPath);
  const keyPath = path.resolve(options.keyPath);
  const entriesPath = path.join(vaultPath, "entries");
  const indexPath = path.join(vaultPath, "index.json");
  const now = options.now ?? (() => new Date().toISOString());
  const key = loadOrCreateVaultKey({
    keyMaterial: options.keyMaterial ?? process.env.BRIDGE_SESSION_VAULT_KEY ?? null,
    keyPath
  });
  ensureSecureDir(vaultPath);
  ensureSecureDir(entriesPath);
  const store: SessionPackageStore = {
    listProviders() {
      return Object.keys(readVaultIndex().sessions)
        .map((providerId) => readInstalledPackage(providerId)?.provider ?? null)
        .filter((provider): provider is InstalledProviderPackage["provider"] => provider !== null)
        .map(cloneProvider)
        .sort((left, right) => left.id.localeCompare(right.id));
    },
    getProvider(providerId) {
      const stored = readInstalledPackage(providerId);
      return stored ? cloneProvider(stored.provider) : null;
    },
    createProvider(input: ProviderCreateProviderRequest) {
      const normalized = createProviderRequestSchema.parse(input);
      if (readVaultMetadata(normalized.id)) {
        throw new BridgeApiError({
          statusCode: 409,
          code: "provider_exists",
          message: `Provider '${normalized.id}' already exists.`
        });
      }
      const timestamp = now();
      const provider = providerSchema.parse({
        ...normalized,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const installed = installedProviderPackageSchema.parse({
        provider,
        session: null
      });
      const metadata = buildSessionPackageMetadata(provider.id, null, {
        existing: null,
        now: timestamp,
        handle: crypto.randomUUID()
      });
      writeInstalledPackage(metadata, installed);
      return cloneProvider(provider);
    },
    updateProvider(providerId, patch: ProviderUpdateProviderRequest) {
      const existing = readInstalledPackage(providerId);
      if (!existing) {
        throw missingProviderError(providerId);
      }
      const nextProvider = providerSchema.parse({
        ...existing.provider,
        ...patch,
        config: patch.config === undefined ? existing.provider.config : cloneConfig(patch.config),
        updatedAt: createTimestamp(existing.provider.updatedAt, now())
      });
      const nextPackage = installedProviderPackageSchema.parse({
        provider: nextProvider,
        session: existing.session ? cloneSessionPackage(existing.session) : null
      });
      const nextMetadata = buildSessionPackageMetadata(providerId, nextPackage.session, {
        existing: readVaultMetadata(providerId),
        now: nextProvider.updatedAt,
        handle: crypto.randomUUID()
      });
      writeInstalledPackage(nextMetadata, nextPackage);
      return cloneProvider(nextProvider);
    },
    get(providerId) {
      const metadata = readVaultMetadata(providerId);
      if (!metadata || !metadata.hasSessionPackage || !isUsableMetadata(metadata, now())) {
        return null;
      }
      const installed = readInstalledPackage(providerId);
      if (!installed?.session) {
        return null;
      }
      const lastUsedAt = now();
      const nextMetadata = buildSessionPackageMetadata(providerId, installed.session, {
        existing: {
          ...metadata,
          lastUsedAt
        },
        now: lastUsedAt,
        handle: crypto.randomUUID()
      });
      writeInstalledPackage(nextMetadata, installed);
      return cloneSessionPackage(installed.session);
    },
    getStatus(providerId) {
      const metadata = readVaultMetadata(providerId);
      return metadata ? cloneSessionPackageMetadata(metadata) : null;
    },
    put(providerId, value) {
      const normalized = cloneSessionPackage(value);
      const existing = readInstalledPackage(providerId);
      const timestamp = createTimestamp(existing?.provider.updatedAt, now());
      const provider = inferProviderFromSessionPackage({
        providerId,
        value: normalized,
        existing: existing?.provider ?? null,
        now: timestamp
      });
      const nextPackage = installedProviderPackageSchema.parse({
        provider,
        session: normalized
      });
      const nextMetadata = buildSessionPackageMetadata(providerId, normalized, {
        existing: readVaultMetadata(providerId),
        now: timestamp,
        handle: crypto.randomUUID()
      });
      writeInstalledPackage(nextMetadata, nextPackage);
      return cloneSessionPackageMetadata(nextMetadata);
    },
    delete(providerId) {
      const metadata = readVaultMetadata(providerId);
      if (!metadata) {
        throw missingProviderError(providerId);
      }
      const nextIndex = {
        ...readVaultIndex(),
        sessions: {
          ...readVaultIndex().sessions
        }
      };
      delete nextIndex.sessions[providerId];
      writeVaultIndex(nextIndex, options.testHooks);
      try {
        unlinkSync(getEntryPath(metadata.handle));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new SessionPackageVaultError("Failed to remove session vault entry.");
        }
      }
      const deleted = providerDeleteResponseSchema.parse({
        ok: true,
        id: providerId
      });
      return sessionPackageDeleteResponseSchema.parse({
        ok: true,
        providerId: deleted.id
      });
    },
    deleteSession(providerId) {
      const installed = readInstalledPackage(providerId);
      if (!installed) {
        throw missingProviderError(providerId);
      }
      const timestamp = createTimestamp(installed.provider.updatedAt, now());
      const nextProvider = providerSchema.parse({
        ...installed.provider,
        updatedAt: timestamp
      });
      const nextPackage = installedProviderPackageSchema.parse({
        provider: nextProvider,
        session: null
      });
      const nextMetadata = buildSessionPackageMetadata(providerId, null, {
        existing: readVaultMetadata(providerId),
        now: timestamp,
        handle: crypto.randomUUID()
      });
      writeInstalledPackage(nextMetadata, nextPackage);
      return sessionPackageDeleteResponseSchema.parse({
        ok: true,
        providerId
      });
    },
    listPackages() {
      return Object.keys(readVaultIndex().sessions)
        .map((providerId) => readInstalledPackage(providerId))
        .filter((entry): entry is InstalledProviderPackage => entry !== null)
        .map(cloneInstalledProviderPackage)
        .sort((left, right) => left.provider.id.localeCompare(right.provider.id));
    },
    getPackage(providerId) {
      const installed = readInstalledPackage(providerId);
      return installed ? cloneInstalledProviderPackage(installed) : null;
    }
  };
  return store;
  function readVaultMetadata(providerId: string) {
    const metadata = readVaultIndex().sessions[providerId];
    return metadata ? sessionPackageMetadataSchema.parse(metadata) : null;
  }
  function readInstalledPackage(providerId: string) {
    const metadata = readVaultMetadata(providerId);
    if (!metadata) {
      return null;
    }
    const entry = readVaultEntry(metadata);
    return normalizeInstalledProviderPackage(decryptInstalledPackage(entry, key));
  }
  function readVaultIndex(): VaultIndex {
    if (!existsSync(indexPath)) {
      return vaultIndexSchema.parse({
        version: SESSION_VAULT_VERSION,
        sessions: {}
      });
    }
    const raw = parseJsonFile(indexPath, z.unknown(), "Session vault index is invalid.");
    const parsed = vaultIndexSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    const legacy = legacyVaultIndexSchema.safeParse(raw);
    if (legacy.success) {
      return vaultIndexSchema.parse({
        version: legacy.data.version,
        sessions: Object.fromEntries(
          Object.entries(legacy.data.sessions).map(([providerId, metadata]) => [
            providerId,
            {
              ...metadata,
              hasSessionPackage: true
            }
          ])
        )
      });
    }
    throw new SessionPackageVaultError("Session vault index is invalid.");
  }
  function writeVaultIndex(
    index: VaultIndex,
    testHooks?: LocalSessionPackageStoreOptions["testHooks"]
  ) {
    writeAtomicJson(indexPath, vaultIndexSchema.parse(index), testHooks);
  }
  function readVaultEntry(metadata: SessionPackageMetadata): VaultEntry {
    const entryPath = getEntryPath(metadata.handle);
    const raw = parseJsonFile(entryPath, z.unknown(), "Session vault entry is invalid.");
    const parsed = vaultEntrySchema.safeParse(raw);
    const entry = parsed.success ? parsed.data : normalizeLegacyVaultEntry(raw);
    if (entry.providerId !== metadata.providerId || entry.handle !== metadata.handle) {
      throw new SessionPackageVaultError(
        "Session vault entry metadata does not match the provider mapping."
      );
    }
    return entry;
  }
  function writeInstalledPackage(
    metadata: SessionPackageMetadata,
    value: InstalledProviderPackage
  ) {
    const entry = encryptInstalledPackage(metadata, value, key);
    writeAtomicJson(getEntryPath(metadata.handle), entry, options.testHooks);
    writeVaultIndex(
      vaultIndexSchema.parse({
        ...readVaultIndex(),
        sessions: {
          ...readVaultIndex().sessions,
          [metadata.providerId]: metadata
        }
      }),
      options.testHooks
    );
  }
  function getEntryPath(handle: string) {
    return path.join(entriesPath, `${handle}.json`);
  }
}
function normalizeInstalledProviderPackage(
  installed: InstalledProviderPackage
): InstalledProviderPackage {
  const transport = readInstalledQwenTransport(installed.provider.config);
  if (!transport) {
    return installed;
  }
  const request = readInstalledTransportRequest(transport);
  if (!request || !("body" in request)) {
    return installed;
  }
  const normalizedBody = buildQwenConversationRequestBody(request.body);
  if (JSON.stringify(normalizedBody) === JSON.stringify(request.body)) {
    return installed;
  }
  return installedProviderPackageSchema.parse({
    provider: {
      ...cloneProvider(installed.provider),
      config: {
        ...cloneConfig(installed.provider.config),
        transport: {
          ...transport,
          request: {
            ...request,
            body: normalizedBody
          }
        }
      }
    },
    session: installed.session ? cloneSessionPackage(installed.session) : null
  });
}
function readInstalledQwenTransport(config: Record<string, unknown>) {
  const transport =
    typeof config.transport === "object" &&
    config.transport !== null &&
    !Array.isArray(config.transport)
      ? (config.transport as Record<string, unknown>)
      : null;
  const request = readInstalledTransportRequest(transport);
  const url = typeof request?.url === "string" ? request.url.trim() : "";
  return /^https:\/\/chat\.qwen\.ai\/api\/v2\/chat\/completions\b/u.test(url) ? transport : null;
}
function readInstalledTransportRequest(transport: Record<string, unknown> | null) {
  return typeof transport?.request === "object" &&
    transport.request !== null &&
    !Array.isArray(transport.request)
    ? (transport.request as Record<string, unknown>)
    : null;
}
function encryptInstalledPackage(
  metadata: SessionPackageMetadata,
  value: InstalledProviderPackage,
  key: Buffer
): VaultEntry {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(
    JSON.stringify(installedProviderPackageSchema.parse(value)),
    "utf8"
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return vaultEntrySchema.parse({
    version: SESSION_VAULT_VERSION,
    algorithm: SESSION_VAULT_ALGORITHM,
    handle: metadata.handle,
    providerId: metadata.providerId,
    metadata,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  });
}
function decryptInstalledPackage(entry: VaultEntry, key: Buffer) {
  try {
    const decipher = crypto.createDecipheriv(
      SESSION_VAULT_ALGORITHM,
      key,
      Buffer.from(entry.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(entry.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final()
    ]);
    const decoded = JSON.parse(plaintext.toString("utf8"));
    const installed = installedProviderPackageSchema.safeParse(decoded);
    if (installed.success) {
      return installed.data;
    }
    const legacySession = sessionPackageSchema.safeParse(decoded);
    if (legacySession.success) {
      return migrateLegacySessionPackage(entry, legacySession.data);
    }
    throw new Error("invalid installed package payload");
  } catch {
    throw new SessionPackageVaultError("Session vault entry ciphertext is unreadable.");
  }
}
function migrateLegacySessionPackage(
  entry: VaultEntry,
  session: SessionPackageRecord
): InstalledProviderPackage {
  const provider = inferProviderFromSessionPackage({
    providerId: entry.providerId,
    value: session,
    existing: null,
    now: entry.metadata.lastUsedAt ?? entry.metadata.createdAt
  });
  return installedProviderPackageSchema.parse({
    provider,
    session
  });
}
function normalizeLegacyVaultEntry(raw: unknown): VaultEntry {
  const legacy = legacyVaultEntrySchema.safeParse(raw);
  if (!legacy.success) {
    throw new SessionPackageVaultError("Session vault entry is invalid.");
  }
  return vaultEntrySchema.parse({
    ...legacy.data,
    metadata: {
      ...legacy.data.metadata,
      hasSessionPackage: true
    }
  });
}
function loadOrCreateVaultKey(input: { keyMaterial: string | null; keyPath: string }) {
  if (input.keyMaterial) {
    return decodeVaultKeyMaterial(input.keyMaterial);
  }
  ensureSecureDir(path.dirname(input.keyPath));
  try {
    const fileValue = readFileSync(input.keyPath, "utf8").trim();
    return decodeVaultKeyMaterial(fileValue);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SessionPackageVaultError) {
        throw error;
      }
      throw new SessionPackageVaultError("Failed to load the session vault key.");
    }
  }
  const createdKey = crypto.randomBytes(SESSION_VAULT_KEY_BYTES).toString("base64");
  const fileDescriptor = openSync(input.keyPath, "wx", 0o600);
  try {
    writeFileSync(fileDescriptor, `${createdKey}\n`, "utf8");
  } finally {
    closeSync(fileDescriptor);
  }
  chmodSync(input.keyPath, 0o600);
  return decodeVaultKeyMaterial(createdKey);
}
function decodeVaultKeyMaterial(value: string) {
  const key = Buffer.from(value.trim(), "base64");
  if (key.byteLength !== SESSION_VAULT_KEY_BYTES) {
    throw new SessionPackageVaultError(
      "Session vault key must be base64-encoded 32-byte material."
    );
  }
  return key;
}
function parseJsonFile<T>(targetPath: string, schema: z.ZodType<T>, message: string) {
  try {
    const raw = readFileSync(targetPath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionPackageVaultError("Session vault entry is missing.");
    }
    if (error instanceof SessionPackageVaultError) {
      throw error;
    }
    throw new SessionPackageVaultError(message);
  }
}
function ensureSecureDir(targetPath: string) {
  mkdirSync(targetPath, {
    recursive: true,
    mode: 0o700
  });
}
function writeAtomicJson(
  targetPath: string,
  value: unknown,
  testHooks?: LocalSessionPackageStoreOptions["testHooks"]
) {
  ensureSecureDir(path.dirname(targetPath));
  const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    testHooks?.afterTempWrite?.(targetPath, tempPath);
    renameSync(tempPath, targetPath);
    chmodSync(targetPath, 0o600);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    if (error instanceof SessionPackageVaultError) {
      throw error;
    }
    throw new SessionPackageVaultError("Failed to commit session vault data.");
  }
}
function isUsableMetadata(metadata: SessionPackageMetadata, referenceTime: string) {
  if (metadata.status !== "active" || !metadata.hasSessionPackage) {
    return false;
  }
  if (metadata.absoluteExpiresAt && metadata.absoluteExpiresAt <= referenceTime) {
    return false;
  }
  if (metadata.idleExpiresAt && metadata.idleExpiresAt <= referenceTime) {
    return false;
  }
  return true;
}
function createTimestamp(previous: string | undefined, fallbackNow: string) {
  const previousTime = previous ? Date.parse(previous) : 0;
  const now = Date.parse(fallbackNow);
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

export const localSessionPackageStoreModule = {
  SessionPackageVaultError,
  clearLocalSessionVault,
  createLocalSessionPackageStore
};

export type { LocalSessionPackageStoreOptions, SessionPackageVaultError };
