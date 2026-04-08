import os from "node:os";
import path from "node:path";

import { z } from "zod";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4318;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_APP_STATE_DIR_NAME = ".bridge";
const DEFAULT_BRIDGE_APP_DIR_NAME = "server";
const nonNegativeIntegerSchema = z.coerce.number().int().min(0);
const positiveIntegerSchema = z.coerce.number().int().min(1);
const bridgeServerConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: nonNegativeIntegerSchema.max(65535),
  stateRoot: z.string().trim().min(1),
  runtimeRoot: z.string().trim().min(1),
  sessionVaultPath: z.string().trim().min(1).optional(),
  sessionVaultKeyPath: z.string().trim().min(1).optional(),
  defaultProvider: z.string().trim().min(1).nullable(),
  defaultModel: z.string().trim().min(1).nullable(),
  maxSteps: positiveIntegerSchema,
  authToken: z.string().trim().min(1).nullable().optional(),
  corsOrigins: z.array(z.string().trim().min(1)).optional()
});
type BridgeServerConfig = z.infer<typeof bridgeServerConfigSchema>;
type BridgeServerConfigOverrides = Partial<{
  host: string;
  port: number | string;
  stateRoot: string;
  runtimeRoot: string;
  sessionVaultPath: string;
  sessionVaultKeyPath: string;
  defaultProvider: string | null;
  defaultModel: string | null;
  maxSteps: number | string;
  authToken: string | null;
  corsOrigins: string[] | string;
}>;
function loadBridgeServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BridgeServerConfigOverrides = {}
): BridgeServerConfig {
  return bridgeServerConfigSchema.parse({
    host: trimOrNull(overrides.host) ?? trimOrNull(env.BRIDGE_SERVER_HOST) ?? DEFAULT_HOST,
    port: overrides.port ?? env.BRIDGE_SERVER_PORT ?? DEFAULT_PORT,
    stateRoot: resolveStateRoot(env, overrides),
    runtimeRoot: resolveRuntimeRoot(env, overrides),
    sessionVaultPath: resolveSessionVaultPath(env, overrides),
    sessionVaultKeyPath: resolveSessionVaultKeyPath(env, overrides),
    defaultProvider:
      trimOrNull(overrides.defaultProvider ?? undefined) ?? trimOrNull(env.BRIDGE_PROVIDER),
    defaultModel: trimOrNull(overrides.defaultModel ?? undefined) ?? trimOrNull(env.BRIDGE_MODEL),
    maxSteps: overrides.maxSteps ?? env.BRIDGE_MAX_STEPS ?? DEFAULT_MAX_STEPS,
    authToken:
      trimOrNull(overrides.authToken ?? undefined) ??
      trimOrNull(env.BRIDGE_AUTH_TOKEN) ??
      undefined,
    corsOrigins: resolveCorsOrigins(overrides.corsOrigins ?? env.BRIDGE_CORS_ORIGINS)
  });
}
function getBridgeServerStartupWarnings(config: BridgeServerConfig) {
  const warnings: string[] = [];
  if (!trimOrNull(config.authToken ?? undefined)) {
    warnings.push(
      "Bridge auth token is not configured; non-health endpoints accept unauthenticated local requests."
    );
  }
  if (!isLocalBridgeHost(config.host)) {
    warnings.push(
      `Bridge is binding to non-local host '${config.host}'; this may expose the server beyond localhost.`
    );
  }
  if (isWildcardCorsOrigins(config.corsOrigins)) {
    warnings.push(
      "Bridge CORS is set to allow any origin; use wildcard CORS only when explicitly needed."
    );
  }
  return warnings;
}
function isLocalBridgeHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
function isWildcardCorsOrigins(value: string[] | undefined) {
  return Boolean(value?.includes("*"));
}
function resolveStateRoot(env: NodeJS.ProcessEnv, overrides: BridgeServerConfigOverrides) {
  const explicit = trimOrNull(overrides.stateRoot) ?? trimOrNull(env.BRIDGE_STATE_ROOT);
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(process.cwd(), ".bridge-server");
}
function resolveRuntimeRoot(env: NodeJS.ProcessEnv, overrides: BridgeServerConfigOverrides) {
  return path.resolve(
    trimOrNull(overrides.runtimeRoot) ?? trimOrNull(env.BRIDGE_RUNTIME_ROOT) ?? process.cwd()
  );
}
function resolveSessionVaultPath(env: NodeJS.ProcessEnv, overrides: BridgeServerConfigOverrides) {
  const explicit =
    trimOrNull(overrides.sessionVaultPath) ?? trimOrNull(env.BRIDGE_SESSION_VAULT_PATH);
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveDefaultBridgeAppRoot(env), "session-vault");
}
function resolveSessionVaultKeyPath(
  env: NodeJS.ProcessEnv,
  overrides: BridgeServerConfigOverrides
) {
  const explicit =
    trimOrNull(overrides.sessionVaultKeyPath) ?? trimOrNull(env.BRIDGE_SESSION_VAULT_KEY_PATH);
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(resolveDefaultBridgeAppRoot(env), "keys", "session-vault.key");
}
function resolveCorsOrigins(value: string[] | string | undefined) {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => entry.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}
function trimOrNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function resolveDefaultBridgeAppRoot(env: NodeJS.ProcessEnv) {
  const homeDir = trimOrNull(env.HOME) ?? os.homedir();
  return path.resolve(homeDir, DEFAULT_APP_STATE_DIR_NAME, DEFAULT_BRIDGE_APP_DIR_NAME);
}

export const bridgeServerConfigModule = {
  bridgeServerConfigSchema,
  loadBridgeServerConfig,
  getBridgeServerStartupWarnings,
  isLocalBridgeHost,
  isWildcardCorsOrigins
};

export type { BridgeServerConfig, BridgeServerConfigOverrides };
