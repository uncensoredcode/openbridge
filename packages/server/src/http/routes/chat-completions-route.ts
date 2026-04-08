import type { FastifyInstance } from "fastify";

import { chatCompletionServiceModule } from "../../bridge/chat-completions/chat-completion-service.ts";
import { fileBridgeStateStoreModule } from "../../bridge/state/file-bridge-state-store.ts";
import type { BridgeApiRouteContext } from "../bridge-api-route-context.ts";
import { parseRequestModule } from "../parse-request.ts";

const { chatCompletionsRequestSchema, handleBridgeChatCompletionRequest } =
  chatCompletionServiceModule;
const { FileBridgeStateStore } = fileBridgeStateStoreModule;
const { parseRequest } = parseRequestModule;
function registerChatCompletionRoute(app: FastifyInstance, context: BridgeApiRouteContext) {
  const stateStore = new FileBridgeStateStore(context.config.stateRoot);
  app.post("/v1/chat/completions", async (request, reply) => {
    const body = parseRequest(chatCompletionsRequestSchema, request.body);
    const execution = await handleBridgeChatCompletionRequest({
      body,
      headers: request.headers,
      providerStore: context.providerStore,
      service: context.service,
      stateStore,
      request: {
        method: request.method,
        url: request.url
      },
      onInternalError: context.onInternalError
    });
    if (execution.kind === "json") {
      return execution.response;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    reply.raw.flushHeaders?.();
    try {
      for await (const event of execution.events) {
        reply.raw.write(event === "[DONE]" ? "data: [DONE]\n\n" : formatSseData(event));
      }
    } finally {
      reply.raw.end();
    }
    return reply;
  });
}
function formatSseData(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

export const chatCompletionsRouteModule = {
  registerChatCompletionRoute
};
