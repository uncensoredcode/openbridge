import { bridgeApiErrorModule } from "./bridge-api-error.ts";
import { outputModule } from "./output.ts";

export const sharedModule = {
  BridgeApiError: bridgeApiErrorModule.BridgeApiError,
  isBridgeApiError: bridgeApiErrorModule.isBridgeApiError,
  sanitizeBridgeApiOutput: outputModule.sanitizeBridgeApiOutput
};

export type {
  BridgeApiErrorResponse,
  BridgeChatCompletionMessage,
  BridgeChatCompletionRequest,
  BridgeChatCompletionResponse,
  BridgeHealthResponse,
  BridgeMessageRequest,
  BridgeMessageResponse,
  BridgeReadyResponse
} from "./api-schema.ts";

export type { BridgeApiError } from "./bridge-api-error.ts";
