import assert from "node:assert/strict";
import test from "node:test";

import type { ToolDefinition } from "../src/index.ts";
import { bridgeRuntime } from "../src/index.ts";

const {
  AssistantProtocolError,
  createFinalResponse,
  createToolResponse,
  parseAndValidateAssistantResponse,
  parseAssistantResponse
} = bridgeRuntime;
const tools: ToolDefinition[] = [
  {
    name: "read",
    description: "Read a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to read."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "toggle",
    description: "Toggle a feature.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Next enabled state."
        }
      },
      required: ["enabled"]
    }
  }
];
test("parseAssistantResponse accepts a valid <final> response", () => {
  assert.deepEqual(parseAssistantResponse(createFinalResponse("User-facing final answer here")), {
    type: "final",
    message: "User-facing final answer here"
  });
});
test("parseAndValidateAssistantResponse accepts a valid <tool> response", () => {
  assert.deepEqual(
    parseAndValidateAssistantResponse(
      createToolResponse({ name: "read", arguments: { path: "package.json" } }),
      tools
    ),
    {
      type: "tool",
      toolCall: {
        name: "read",
        arguments: {
          path: "package.json"
        }
      }
    }
  );
});
test("parseAssistantResponse rejects invalid JSON inside <tool>", () => {
  assert.throws(
    () => parseAssistantResponse('<tool>{"name":"read","arguments":</tool>'),
    /valid JSON/
  );
});
test("parseAndValidateAssistantResponse rejects unknown tool names", () => {
  assert.throws(
    () =>
      parseAndValidateAssistantResponse(
        createToolResponse({ name: "wifi_scan", arguments: {} }),
        tools
      ),
    /not registered/
  );
});
test("parseAndValidateAssistantResponse rejects invalid argument schemas", () => {
  assert.throws(
    () =>
      parseAndValidateAssistantResponse(
        createToolResponse({ name: "toggle", arguments: { enabled: "yes" } as never }),
        tools
      ),
    /must be a boolean/
  );
});
test("parseAssistantResponse rejects extra text before the block", () => {
  assert.throws(
    () => parseAssistantResponse(`prefix ${createFinalResponse("done")}`),
    AssistantProtocolError
  );
});
test("parseAssistantResponse rejects extra text after the block", () => {
  assert.throws(
    () => parseAssistantResponse(`${createFinalResponse("done")} suffix`),
    AssistantProtocolError
  );
});
test("parseAssistantResponse rejects mixed final and tool content", () => {
  assert.throws(
    () =>
      parseAssistantResponse(
        `${createFinalResponse("done")}${createToolResponse({ name: "read", arguments: { path: "package.json" } })}`
      ),
    AssistantProtocolError
  );
});
test("parseAssistantResponse rejects multiple tool blocks", () => {
  assert.throws(
    () =>
      parseAssistantResponse(
        `${createToolResponse({ name: "read", arguments: { path: "package.json" } })}${createToolResponse({ name: "read", arguments: { path: "README.md" } })}`
      ),
    AssistantProtocolError
  );
});
test("parseAndValidateAssistantResponse rejects unknown tool arguments", () => {
  assert.throws(
    () =>
      parseAndValidateAssistantResponse(
        createToolResponse({ name: "read", arguments: { path: "package.json", mode: "full" } }),
        tools
      ),
    /unknown argument "mode"/
  );
});
