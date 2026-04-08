import { configModule } from "../config/index.ts";

const { isLocalBridgeHost, isWildcardCorsOrigins } = configModule;
function resolveCorsOrigin(origin: string | undefined, configuredOrigins: string[] | undefined) {
  const normalizedOrigin = origin?.trim();
  if (!normalizedOrigin) {
    return null;
  }
  if (isWildcardCorsOrigins(configuredOrigins)) {
    return "*";
  }
  if (configuredOrigins && configuredOrigins.length > 0) {
    return configuredOrigins.includes(normalizedOrigin) ? normalizedOrigin : null;
  }
  return isDefaultAllowedCorsOrigin(normalizedOrigin) ? normalizedOrigin : null;
}
function isDefaultAllowedCorsOrigin(origin: string) {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "chrome-extension:" || parsed.protocol === "moz-extension:") {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return isLocalBridgeHost(parsed.hostname);
}

export const corsPolicyModule = {
  resolveCorsOrigin
};
