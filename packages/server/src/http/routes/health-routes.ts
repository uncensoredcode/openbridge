import type { FastifyInstance } from "fastify";

import type { BridgeHealthResponse, BridgeReadyResponse } from "../../shared/api-schema.ts";

function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async (): Promise<BridgeHealthResponse> => ({ ok: true }));
  app.get("/ready", async (): Promise<BridgeReadyResponse> => ({ ok: true }));
}

export const healthRoutesModule = {
  registerHealthRoutes
};
