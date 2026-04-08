import type { FastifyInstance } from "fastify";

import type { BridgeApiRouteContext } from "./bridge-api-route-context.ts";
import { adminRoutesModule } from "./routes/admin-routes.ts";
import { chatCompletionsRouteModule } from "./routes/chat-completions-route.ts";
import { healthRoutesModule } from "./routes/health-routes.ts";
import { messageRoutesModule } from "./routes/message-routes.ts";

const { registerAdminRoutes } = adminRoutesModule;
const { registerChatCompletionRoute } = chatCompletionsRouteModule;
const { registerHealthRoutes } = healthRoutesModule;
const { registerMessageRoutes } = messageRoutesModule;
function registerBridgeApiRoutes(app: FastifyInstance, context: BridgeApiRouteContext) {
  registerHealthRoutes(app);
  registerAdminRoutes(app, context);
  registerChatCompletionRoute(app, context);
  registerMessageRoutes(app, context);
}

export const registerBridgeApiRoutesModule = {
  registerBridgeApiRoutes
};
