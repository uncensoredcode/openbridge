import type { BridgeProviderSession } from "../state/file-bridge-state-store.ts";
import type { FileBridgeStateStore } from "../state/file-bridge-state-store.ts";
import type { SessionPackageStore } from "../stores/session-package-store.ts";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36";
type BridgeProviderSessionResolver = {
  rootDir: string;
  loadProviderSession(input: { providerId: string }): Promise<BridgeProviderSession | null>;
};
function createBridgeProviderSessionResolver(input: {
  sessionPackageStore?: SessionPackageStore;
  stateStore: FileBridgeStateStore;
}): BridgeProviderSessionResolver {
  return {
    rootDir: input.stateStore.rootDir,
    async loadProviderSession({ providerId }) {
      const uploaded = input.sessionPackageStore?.get(providerId);
      const normalizedUploaded = uploaded
        ? normalizeUploadedSessionPackage(providerId, uploaded)
        : null;
      if (normalizedUploaded) {
        return normalizedUploaded;
      }
      const legacyProviderSession = await input.stateStore.loadProviderSession(providerId);
      if (legacyProviderSession) {
        return legacyProviderSession;
      }
      return null;
    }
  };
}
function normalizeUploadedSessionPackage(
  providerId: string,
  stored: {
    capturedAt: string;
    cookies: unknown[];
    headers: Record<string, unknown>;
  }
): BridgeProviderSession | null {
  const cookie = serializeCookies(stored.cookies);
  const userAgent = readHeaderValue(stored.headers, "user-agent") || DEFAULT_USER_AGENT;
  const authorization = readHeaderValue(stored.headers, "authorization");
  const bearerToken = extractBearerToken(authorization);
  const extraHeaders = extractExtraHeaders(stored.headers);
  if (!cookie && !bearerToken && Object.keys(extraHeaders).length === 0) {
    return null;
  }
  return {
    providerId,
    cookie,
    userAgent,
    bearerToken,
    extraHeaders,
    updatedAt: stored.capturedAt
  };
}
function serializeCookies(cookies: unknown[]) {
  const parts: string[] = [];
  for (const cookie of cookies) {
    if (typeof cookie !== "object" || cookie === null) {
      continue;
    }
    const name = "name" in cookie && typeof cookie.name === "string" ? cookie.name.trim() : "";
    const value = "value" in cookie && typeof cookie.value === "string" ? cookie.value : "";
    if (!name) {
      continue;
    }
    parts.push(`${name}=${value}`);
  }
  return parts.join("; ");
}
function readHeaderValue(headers: Record<string, unknown>, headerName: string) {
  const target = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}
function extractBearerToken(value: string) {
  if (!value || !/^Bearer\s+/i.test(value)) {
    return "";
  }
  return value.replace(/^Bearer\s+/i, "").trim();
}
function extractExtraHeaders(headers: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "authorization" ||
      normalizedKey === "user-agent" ||
      normalizedKey === "cookie"
    ) {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    result[key] = trimmed;
  }
  return result;
}

export const providerSessionResolverModule = {
  createBridgeProviderSessionResolver
};

export type { BridgeProviderSessionResolver };
