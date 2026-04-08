import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import type { FastifyRequest } from "fastify";

function isAuthorizedBridgeRequest(
  headers: IncomingHttpHeaders,
  configuredToken: string | null | undefined
) {
  if (!configuredToken) {
    return true;
  }
  const providedToken =
    readBearerToken(headers.authorization) ?? readHeaderString(headers["x-bridge-token"]);
  if (!providedToken) {
    return false;
  }
  const expected = Buffer.from(configuredToken, "utf8");
  const actual = Buffer.from(providedToken, "utf8");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
function requiresBridgeAuth(request: FastifyRequest, configuredToken: string | null | undefined) {
  if (!configuredToken) {
    return false;
  }
  const pathname = request.raw.url?.split("?")[0] ?? request.url;
  return pathname !== "/health" && pathname !== "/ready";
}
function readBearerToken(value: string | string[] | undefined) {
  const normalized = readHeaderString(value);
  if (!normalized || !/^Bearer\s+/i.test(normalized)) {
    return null;
  }
  const token = normalized.replace(/^Bearer\s+/i, "").trim();
  return token || null;
}
function readHeaderString(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return value?.trim() || null;
}

export const bridgeAuthModule = {
  isAuthorizedBridgeRequest,
  requiresBridgeAuth
};
