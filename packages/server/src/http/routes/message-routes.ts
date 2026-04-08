import type { FastifyInstance } from "fastify";

import type { BridgeMessageRequest } from "../../shared/api-schema.ts";
import type { BridgeApiRouteContext } from "../bridge-api-route-context.ts";

function registerMessageRoutes(app: FastifyInstance, context: BridgeApiRouteContext) {
  app.post<{
    Body: BridgeMessageRequest;
  }>("/v1/respond", async (request) => context.service.respond(request.body));
  app.post<{
    Params: {
      sessionId: string;
    };
    Body: BridgeMessageRequest;
  }>("/v1/sessions/:sessionId/messages", async (request) =>
    context.service.respond(request.body, request.params.sessionId)
  );
}

export const messageRoutesModule = {
  registerMessageRoutes
};
