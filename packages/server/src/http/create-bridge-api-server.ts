import type { Server } from "node:http";
import path from "node:path";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import { bridgeModule } from "../bridge/index.ts";
import { providerTransportProfileModule } from "../bridge/providers/provider-transport-profile.ts";
import { localSessionPackageStoreModule } from "../bridge/stores/local-session-package-store.ts";
import type { ProviderRecord } from "../bridge/stores/provider-store.ts";
import { sessionBackedProviderStoreModule } from "../bridge/stores/session-backed-provider-store.ts";
import type { BridgeServerConfig } from "../config/index.ts";
import { configModule } from "../config/index.ts";
import { securityModule } from "../security/index.ts";
import { bridgeApiErrorModule } from "../shared/bridge-api-error.ts";
import { registerBridgeApiRoutesModule } from "./register-bridge-api-routes.ts";

const { createBridgeRuntimeService, createInMemorySessionStore } = bridgeModule;
const { resolveProviderTransportProfile } = providerTransportProfileModule;
const { createSessionBackedProviderStore } = sessionBackedProviderStoreModule;
const { createLocalSessionPackageStore } = localSessionPackageStoreModule;
const { loadBridgeServerConfig } = configModule;
const { isBridgeApiError } = bridgeApiErrorModule;
const {
  formatBridgeServerErrorLog,
  isAuthorizedBridgeRequest,
  requiresBridgeAuth,
  resolveCorsOrigin,
  sanitizeBridgeApiErrorPayload
} = securityModule;
const { registerBridgeApiRoutes } = registerBridgeApiRoutesModule;
const BRIDGE_API_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
type BridgeApiServerLogger = {
  warn(message: string): void;
  error(message: string): void;
};
type BridgeApiServerOptions = {
  config?: BridgeServerConfig;
  service?: ReturnType<typeof createBridgeRuntimeService>;
  logger?: BridgeApiServerLogger;
};
function createBridgeApiServer(options: BridgeApiServerOptions = {}) {
  const { app, server } = createBridgeApiApp(options);
  void app.ready((error) => {
    if (error) {
      const logger = options.logger ?? defaultBridgeApiServerLogger;
      logger.error(formatBridgeServerErrorLog(error));
    }
  });
  return server;
}
async function startBridgeApiServer(options: BridgeApiServerOptions = {}) {
  const { app, config } = createBridgeApiApp(options);
  await app.listen({
    host: config.host,
    port: config.port
  });
  return app.server;
}
function createBridgeApiApp(options: BridgeApiServerOptions = {}) {
  const config = options.config ?? loadBridgeServerConfig();
  const logger = options.logger ?? defaultBridgeApiServerLogger;
  const sessionPackageStore = createLocalSessionPackageStore({
    vaultPath: config.sessionVaultPath ?? path.join(config.stateRoot, "session-vault"),
    keyPath: config.sessionVaultKeyPath ?? path.join(config.stateRoot, "keys", "session-vault.key")
  });
  const providerStore = createSessionBackedProviderStore(sessionPackageStore);
  const sessionStore = createInMemorySessionStore();
  const service =
    options.service ??
    createBridgeRuntimeService({
      config,
      loadProvider(providerId) {
        return providerStore.get(providerId);
      },
      sessionPackageStore
    });
  const app = Fastify({
    logger: false,
    bodyLimit: BRIDGE_API_BODY_LIMIT_BYTES
  });
  for (const warning of collectInstalledProviderWarnings(config, providerStore.list())) {
    logger.warn(warning);
  }
  app.addHook("onRequest", async (request, reply) => {
    setCorsHeaders(request, reply, config);
    reply.header("Cache-Control", "no-store");
    if (request.method === "OPTIONS" || !requiresBridgeAuth(request, config.authToken)) {
      return;
    }
    if (isAuthorizedBridgeRequest(request.headers, config.authToken)) {
      return;
    }
    reply.header("WWW-Authenticate", 'Bearer realm="bridge-server"');
    await writeJson(reply, 401, {
      error: {
        code: "unauthorized",
        message: "Bridge authorization failed."
      }
    });
  });
  app.options("*", async (_request, reply) => {
    reply.code(204).send();
  });
  registerBridgeApiRoutes(app, {
    config,
    service,
    providerStore,
    sessionPackageStore,
    sessionStore,
    onInternalError(error, request) {
      logger.error(
        formatBridgeServerErrorLog(error, {
          method: request.method,
          url: request.url
        })
      );
    }
  });
  app.setNotFoundHandler(async (_request, reply) => {
    await writeJson(reply, 404, {
      error: {
        code: "not_found",
        message: "Route not found."
      }
    });
  });
  app.setErrorHandler(async (error, _request, reply) => {
    if (isBridgeApiError(error)) {
      if (shouldLogBridgeApiError(error)) {
        logger.warn(
          formatBridgeServerErrorLog(error, {
            method: _request.method,
            url: _request.url
          })
        );
      }
      const safeError = sanitizeBridgeApiErrorPayload(error);
      await writeJson(reply, error.statusCode, {
        error: {
          code: safeError.code,
          message: safeError.message,
          details: safeError.details
        }
      });
      return;
    }
    if (isInvalidJsonBodyError(error)) {
      await writeJson(reply, 400, {
        error: {
          code: "invalid_json",
          message: "Request body must contain valid JSON."
        }
      });
      return;
    }
    if (isRequestBodyTooLargeError(error)) {
      await writeJson(reply, 413, {
        error: {
          code: "request_too_large",
          message: "Request body exceeds the bridge server upload limit."
        }
      });
      return;
    }
    logger.error(
      formatBridgeServerErrorLog(error, {
        method: _request.method,
        url: _request.url
      })
    );
    await writeJson(reply, 500, {
      error: {
        code: "internal_error",
        message: "Internal bridge server error."
      }
    });
  });
  return {
    app,
    config,
    server: app.server
  };
}
function setCorsHeaders(request: FastifyRequest, reply: FastifyReply, config: BridgeServerConfig) {
  const allowedOrigin = resolveCorsOrigin(request.headers.origin, config.corsOrigins);
  if (!allowedOrigin) {
    return;
  }
  if (allowedOrigin === "*") {
    reply.header("Access-Control-Allow-Origin", "*");
  } else {
    reply.header("Access-Control-Allow-Origin", allowedOrigin);
    reply.header("Vary", "Origin");
  }
  reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Bridge-Token");
  reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
}
async function writeJson(reply: FastifyReply, statusCode: number, value: unknown) {
  await reply.code(statusCode).send(value);
}
function isInvalidJsonBodyError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY")
  );
}
function isRequestBodyTooLargeError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  );
}
const defaultBridgeApiServerLogger: BridgeApiServerLogger = {
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  }
};
function collectInstalledProviderWarnings(config: BridgeServerConfig, providers: ProviderRecord[]) {
  const warnings: string[] = [];
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  if (config.defaultProvider && providers.length > 0) {
    const defaultProvider = providersById.get(config.defaultProvider);
    if (!defaultProvider) {
      warnings.push(`Bridge default provider '${config.defaultProvider}' is not installed.`);
    } else if (!resolveProviderTransportProfile(defaultProvider)) {
      warnings.push(
        `Bridge default provider '${defaultProvider.id}' is not runnable; unsupported kind '${defaultProvider.kind}' or missing transport config.`
      );
    }
  }
  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }
    if (resolveProviderTransportProfile(provider)) {
      continue;
    }
    warnings.push(
      `Provider '${provider.id}' is enabled but not runnable; unsupported kind '${provider.kind}' or missing transport config.`
    );
  }
  return warnings;
}
function shouldLogBridgeApiError(error: { statusCode: number; code: string }) {
  return (
    error.statusCode >= 500 ||
    error.code.startsWith("provider_") ||
    error.code === "provider_unavailable"
  );
}

export const createBridgeApiServerModule = {
  createBridgeApiServer,
  startBridgeApiServer
};

export type { BridgeApiServerLogger, BridgeApiServerOptions };
