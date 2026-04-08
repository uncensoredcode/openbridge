import assert from "node:assert/strict";
import test from "node:test";

import * as bridgeRuntime from "../src/index.ts";

const { compileProviderTurn } = bridgeRuntime.bridgeRuntime;
test("public bridge runtime exports do not leak Telegram or product-specific names", () => {
  const exportNames = Object.keys(bridgeRuntime);
  assert.equal(
    exportNames.some((name) => /telegram|discord|openclaw|bridge-core/i.test(name)),
    false
  );
});
test("core prompt assembly avoids Telegram and legacy product wording", () => {
  const compiled = compileProviderTurn({
    conversation: {
      entries: [
        {
          type: "user_message",
          content: "What tools are available?"
        }
      ]
    },
    availableTools: []
  });
  assert.doesNotMatch(
    compiled.messages[0]?.content ?? "",
    /Telegram|Discord|OpenClaw|ZeroClaw|BridgeCore/
  );
});
