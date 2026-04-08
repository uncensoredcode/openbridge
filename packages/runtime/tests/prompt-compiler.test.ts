import assert from "node:assert/strict";
import test from "node:test";

import { promptCompilerModule } from "../src/prompt-compiler.ts";
import type { ToolResult } from "../src/protocol.ts";
import { protocolModule } from "../src/protocol.ts";

const { compileProviderTurn } = promptCompilerModule;
const { serializeToolResult } = protocolModule;
test("compiler replays bridge-session history when no provider session is available", () => {
  const compiled = compileProviderTurn({
    conversation: {
      sessionHistory: [
        {
          userMessage: "Summarize the repo.",
          assistantMessage: "It is a monorepo.",
          assistantMode: "final"
        }
      ],
      entries: [
        {
          type: "user_message",
          content: "What was the package version again?"
        }
      ]
    },
    availableTools: [],
    runtimePlannerPrimed: false
  });
  assert.equal(compiled.summary.replayedFromBridgeSession, true);
  assert.equal(compiled.summary.turnType, "follow_up");
  assert.match(compiled.messages[1]?.content ?? "", /Previous bridge turns:/);
  assert.match(compiled.messages[1]?.content ?? "", /Summarize the repo/);
  assert.match(compiled.messages[1]?.content ?? "", /What was the package version again/);
  assert.match(compiled.messages[1]?.content ?? "", /Mandatory response protocol for this turn:/);
});
test("compiler replays bridge-session history and tool results after a provider-session reset", () => {
  const toolResult: ToolResult = {
    id: "call_read",
    name: "read",
    ok: true,
    payload: {
      path: "package.json",
      content: '{"version":"0.1.0"}'
    }
  };
  const compiled = compileProviderTurn({
    conversation: {
      sessionHistory: [
        {
          userMessage: "Summarize the repo.",
          assistantMessage: "It is a monorepo.",
          assistantMode: "final"
        }
      ],
      entries: [
        {
          type: "user_message",
          content: "Use the tool result to confirm the version."
        },
        {
          type: "tool_result",
          rawText: serializeToolResult(toolResult),
          result: toolResult
        }
      ]
    },
    availableTools: [],
    forceReplay: true
  });
  assert.equal(compiled.summary.replayedFromBridgeSession, true);
  assert.equal(compiled.summary.toolResultCount, 1);
  assert.match(compiled.messages[1]?.content ?? "", /Tool results:/);
  assert.match(compiled.messages[1]?.content ?? "", /tool_result version="1"/);
  assert.match(compiled.messages[1]?.content ?? "", /Summarize the repo/);
  assert.match(compiled.messages[1]?.content ?? "", /Mandatory response protocol for this turn:/);
});
