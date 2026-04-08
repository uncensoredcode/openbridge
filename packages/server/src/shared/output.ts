import { bridgeRuntime } from "@openbridge/runtime";

const { sanitizeVisibleModelOutput } = bridgeRuntime;
function sanitizeBridgeApiOutput(content: string) {
  return sanitizeVisibleModelOutput(content, {
    packetMessageReason: "packet_message_extracted",
    documentReason: "document_marker_suppressed",
    controlReason: "control_text_suppressed",
    fallbackMessage:
      "The bridge runtime returned internal control text instead of a readable answer.",
    documentFallbackMessage:
      "The bridge runtime returned a document marker instead of a readable answer."
  });
}

export const outputModule = {
  sanitizeBridgeApiOutput
};
