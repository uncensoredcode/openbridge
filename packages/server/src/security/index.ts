import { bridgeAuthModule } from "./bridge-auth.ts";
import { corsPolicyModule } from "./cors-policy.ts";
import { redactSensitiveValuesModule } from "./redact-sensitive-values.ts";

export const securityModule = {
  isAuthorizedBridgeRequest: bridgeAuthModule.isAuthorizedBridgeRequest,
  requiresBridgeAuth: bridgeAuthModule.requiresBridgeAuth,
  resolveCorsOrigin: corsPolicyModule.resolveCorsOrigin,
  formatBridgeServerErrorLog: redactSensitiveValuesModule.formatBridgeServerErrorLog,
  redactSensitiveValue: redactSensitiveValuesModule.redactSensitiveValue,
  sanitizeBridgeApiErrorPayload: redactSensitiveValuesModule.sanitizeBridgeApiErrorPayload,
  sanitizeSensitiveText: redactSensitiveValuesModule.sanitizeSensitiveText
};
