import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { bridgeModule } from "../../bridge/index.ts";
import { bridgeApiErrorModule } from "../../shared/bridge-api-error.ts";
import type { BridgeApiRouteContext } from "../bridge-api-route-context.ts";
import { parseRequestModule } from "../parse-request.ts";

const {
  buildModelListResponse,
  createModelRequestSchema,
  buildSessionPackageStatus,
  createProviderRequestSchema,
  modelMutationResponseSchema,
  createSessionRequestSchema,
  providerDeleteResponseSchema,
  providerIdParamsSchema,
  providerListResponseSchema,
  providerResponseSchema,
  sessionDeleteResponseSchema,
  sessionIdParamsSchema,
  sessionListResponseSchema,
  sessionPackageDeleteResponseSchema,
  sessionPackageSchema,
  sessionPackageStatusResponseSchema,
  sessionResponseSchema,
  updateProviderRequestSchema,
  updateSessionRequestSchema
} = bridgeModule;
const { BridgeApiError } = bridgeApiErrorModule;
const { parseRequest } = parseRequestModule;
function registerAdminRoutes(app: FastifyInstance, context: BridgeApiRouteContext) {
  app.get("/v1/models", async () => buildModelListResponse(context.providerStore.list()));
  app.post("/v1/models", async (request, reply) => {
    const body = parseRequest(createModelRequestSchema, request.body);
    const provider = requireProvider(context, body.provider);
    const modelId = body.model.trim();
    const currentModels = Array.isArray(provider.config.models)
      ? provider.config.models.filter((value): value is string => typeof value === "string")
      : [];
    const nextModels = [...new Set([...currentModels.map((value) => value.trim()), modelId])]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    context.providerStore.update(provider.id, {
      config: {
        ...provider.config,
        models: nextModels
      }
    });
    reply.code(201);
    return modelMutationResponseSchema.parse({
      ok: true,
      providerId: provider.id,
      modelId
    });
  });
  app.get("/v1/providers", async () =>
    providerListResponseSchema.parse({
      providers: context.providerStore.list()
    })
  );
  app.post("/v1/providers", async (request, reply) => {
    const body = parseRequest(createProviderRequestSchema, request.body);
    const provider = context.providerStore.create(body);
    reply.code(201);
    return providerResponseSchema.parse({ provider });
  });
  app.get("/v1/providers/:id", async (request) => {
    const params = parseRequest(providerIdParamsSchema, request.params);
    const provider = context.providerStore.get(params.id);
    if (!provider) {
      throw providerNotFoundError(params.id);
    }
    return providerResponseSchema.parse({ provider });
  });
  app.patch("/v1/providers/:id", async (request) => {
    const params = parseRequest(providerIdParamsSchema, request.params);
    const body = parseRequest(updateProviderRequestSchema, request.body);
    const provider = context.providerStore.update(params.id, body);
    return providerResponseSchema.parse({ provider });
  });
  app.delete("/v1/providers/:id", async (request) => {
    const params = parseRequest(providerIdParamsSchema, request.params);
    const deleted = context.providerStore.delete(params.id);
    return providerDeleteResponseSchema.parse(deleted);
  });
  app.put("/v1/providers/:id/session-package", async (request) => {
    const params = parseRequest(providerIdParamsSchema, request.params);
    const body = parseRequest(sessionPackageSchema, request.body);
    const stored = context.sessionPackageStore.put(params.id, body);
    return sessionPackageStatusResponseSchema.parse(buildSessionPackageStatus(params.id, stored));
  });
  app.get("/v1/providers/:id/session-package", async (request) => {
    const params = parseRequest(providerIdParamsSchema, request.params);
    requireProvider(context, params.id);
    const stored = context.sessionPackageStore.getStatus(params.id);
    if (!stored || !stored.hasSessionPackage) {
      throw new BridgeApiError({
        statusCode: 404,
        code: "session_package_not_found",
        message: `Provider '${params.id}' does not have a session package.`
      });
    }
    return sessionPackageStatusResponseSchema.parse(buildSessionPackageStatus(params.id, stored));
  });
  app.delete("/v1/providers/:id/session-package", async (request) => {
    const params = parseRequest(providerIdParamsSchema, request.params);
    requireProvider(context, params.id);
    return sessionPackageDeleteResponseSchema.parse(
      context.sessionPackageStore.deleteSession(params.id)
    );
  });
  app.get("/v1/sessions", async () =>
    sessionListResponseSchema.parse({
      sessions: context.sessionStore.list()
    })
  );
  app.post("/v1/sessions", async (request, reply) => {
    const body = parseRequest(createSessionRequestSchema, request.body);
    const session = context.sessionStore.create(body);
    reply.code(201);
    return sessionResponseSchema.parse({ session });
  });
  app.get("/v1/sessions/:id", async (request) => {
    const params = parseRequest(sessionIdParamsSchema, request.params);
    const session = context.sessionStore.get(params.id);
    if (!session) {
      throw sessionNotFoundError(params.id);
    }
    return sessionResponseSchema.parse({ session });
  });
  app.patch("/v1/sessions/:id", async (request) => {
    const params = parseRequest(sessionIdParamsSchema, request.params);
    const body = parseRequest(updateSessionRequestSchema, request.body);
    const session = context.sessionStore.update(params.id, body);
    return sessionResponseSchema.parse({ session });
  });
  app.delete("/v1/sessions/:id", async (request) => {
    const params = parseRequest(sessionIdParamsSchema, request.params);
    return sessionDeleteResponseSchema.parse(context.sessionStore.delete(params.id));
  });
}
function requireProvider(context: BridgeApiRouteContext, providerId: string) {
  const provider = context.providerStore.get(providerId);
  if (provider) {
    return provider;
  }
  throw providerNotFoundError(providerId);
}
function providerNotFoundError(providerId: string) {
  return new BridgeApiError({
    statusCode: 404,
    code: "provider_not_found",
    message: `Provider '${providerId}' was not found.`
  });
}
function sessionNotFoundError(sessionId: string) {
  return new BridgeApiError({
    statusCode: 404,
    code: "session_not_found",
    message: `Session '${sessionId}' was not found.`
  });
}

export const adminRoutesModule = {
  registerAdminRoutes
};
