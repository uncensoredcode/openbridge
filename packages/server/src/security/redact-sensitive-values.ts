import type { BridgeApiError } from "../shared/bridge-api-error.ts";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(authorization|headers?|cookie|cookies|set-cookie|localstorage|token|secret|bearer|session[-_]?package|extraheaders?|ciphertext|authtag|vaultkey|sessionvaultkey)/i;
function sanitizeBridgeApiErrorPayload(error: BridgeApiError) {
  return {
    code: error.code,
    message: sanitizeSensitiveText(error.message),
    details: error.details === undefined ? undefined : redactSensitiveValue(error.details)
  };
}
function formatBridgeServerErrorLog(
  error: unknown,
  context: {
    method?: string;
    url?: string;
  } = {}
) {
  const prefix = [
    context.method && context.url ? `${context.method} ${context.url}` : (context.url ?? null),
    "bridge-server error"
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(": ");
  if (typeof error === "object" && error !== null) {
    const name = "name" in error && typeof error.name === "string" ? error.name : "Error";
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    const details =
      "details" in error && error.details !== undefined
        ? ` details=${JSON.stringify(redactSensitiveValue(error.details))}`
        : "";
    return `${prefix}: ${sanitizeSensitiveText([name, code, message].filter(Boolean).join(" "))}${details}`;
  }
  return `${prefix}: ${sanitizeSensitiveText(String(error))}`;
}
function redactSensitiveValue(value: unknown, path: string[] = []): unknown {
  const currentKey = path.at(-1) ?? "";
  if (isSensitiveKey(currentKey)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return sanitizeSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValue(entry, path));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactSensitiveValue(entry, [...path, key]);
    }
    return result;
  }
  return value;
}
function sanitizeSensitiveText(value: string) {
  return value
    .replace(/(Authorization\s*:\s*)Bearer\s+[^\s",]+/gi, "$1Bearer [REDACTED]")
    .replace(/(["']authorization["']\s*:\s*["'])Bearer\s+[^"']+(["'])/gi, `$1Bearer ${REDACTED}$2`)
    .replace(/Bearer\s+[^\s",]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:cookie|set-cookie)\s*[:=]\s*)([^"'\n}]+)/gi,
      (_match, prefix: string, cookieHeader: string) => {
        return `${prefix}${cookieHeader.replace(/([A-Za-z0-9._-]+\s*=)[^;,\s]+/g, `$1${REDACTED}`)}`;
      }
    )
    .replace(
      /(["']?(?:token|access_token|refresh_token|bearerToken)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      `$1${REDACTED}`
    )
    .replace(/((?:session|cookie)\s*=\s*)[^;\s",]+/gi, `$1${REDACTED}`);
}
function isSensitiveKey(value: string) {
  return SENSITIVE_KEY_PATTERN.test(value);
}

export const redactSensitiveValuesModule = {
  sanitizeBridgeApiErrorPayload,
  formatBridgeServerErrorLog,
  redactSensitiveValue,
  sanitizeSensitiveText
};
