import assert from "node:assert/strict";
import test from "node:test";

import { bridgeRuntime } from "../src/index.ts";

const { sanitizeVisibleModelOutput } = bridgeRuntime;
const options = {
  packetMessageReason: "packet_message_extracted",
  documentReason: "document_marker_suppressed",
  controlReason: "control_text_suppressed",
  fallbackMessage: "fallback",
  documentFallbackMessage: "document fallback"
};
test("sanitizer extracts visible text from packet replies", () => {
  assert.deepEqual(sanitizeVisibleModelOutput("<final>hello</final>", options), {
    content: "hello",
    sanitized: true,
    reason: "packet_message_extracted"
  });
});
test("sanitizer suppresses document markers and control text", () => {
  assert.deepEqual(sanitizeVisibleModelOutput("[DOCUMENT:foo]", options), {
    content: "document fallback",
    sanitized: true,
    reason: "document_marker_suppressed"
  });
  assert.deepEqual(
    sanitizeVisibleModelOutput("Respond with exactly one XML packet and nothing else.", options),
    {
      content: "fallback",
      sanitized: true,
      reason: "control_text_suppressed"
    }
  );
});
