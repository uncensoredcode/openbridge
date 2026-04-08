import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ProviderAdapter,
  ProviderTurnInput,
  RuntimeEvent,
  RuntimeTool
} from "../src/index.ts";
import { bridgeRuntime } from "../src/index.ts";

const {
  InProcessToolExecutor,
  createBashTool,
  createFinalResponse,
  createToolResponse,
  runBridgeRuntime
} = bridgeRuntime;
class ToolLoopProvider implements ProviderAdapter {
  readonly id = "mock-provider";
  async completeTurn(input: ProviderTurnInput): Promise<string> {
    const toolResults = input.conversation.entries.filter((entry) => entry.type === "tool_result");
    if (toolResults.length === 0) {
      return createToolResponse({
        name: "lookup_value",
        arguments: {
          key: "color"
        }
      });
    }
    return createFinalResponse("The color is blue.");
  }
}
function createRepairAwareProvider(input: {
  main: (turn: ProviderTurnInput, callIndex: number) => Promise<string> | string;
  repair: (
    input: {
      conversation: ProviderTurnInput["conversation"];
      availableTools: Awaited<ReturnType<InProcessToolExecutor["getAvailableTools"]>>;
      invalidResponse: string;
      validationError: string;
    },
    callIndex: number
  ) => Promise<string> | string;
}) {
  const repairInputs: Array<{
    conversation: ProviderTurnInput["conversation"];
    availableTools: Awaited<ReturnType<InProcessToolExecutor["getAvailableTools"]>>;
    invalidResponse: string;
    validationError: string;
  }> = [];
  let mainCalls = 0;
  let repairCalls = 0;
  const provider: ProviderAdapter = {
    id: "repair-aware-provider",
    async completeTurn(turn) {
      mainCalls += 1;
      return await input.main(turn, mainCalls);
    },
    async repairInvalidResponse(repairInput) {
      repairCalls += 1;
      repairInputs.push(repairInput);
      return await input.repair(repairInput, repairCalls);
    }
  };
  return {
    provider,
    get mainCalls() {
      return mainCalls;
    },
    get repairCalls() {
      return repairCalls;
    },
    repairInputs
  };
}
test("runtime handles a generic tool loop without any transport-specific concepts", async () => {
  const lookupTool: RuntimeTool = {
    definition: {
      name: "lookup_value",
      description: "Look up a value from a generic key-value store.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Key to look up."
          }
        },
        required: ["key"]
      }
    },
    async execute(args) {
      return {
        key: String(args.key),
        value: "blue"
      };
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "What is the stored color?",
    provider: new ToolLoopProvider(),
    toolExecutor: new InProcessToolExecutor({
      tools: [lookupTool]
    })
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "The color is blue.");
  assert.equal(outcome.steps, 2);
  assert.equal(
    outcome.conversation.entries.filter((entry) => entry.type === "tool_result").length,
    1
  );
});
test("runtime fails closed on malformed assistant responses", async () => {
  const outcome = await runBridgeRuntime({
    userMessage: "bad response please",
    provider: {
      id: "bad-response-provider",
      async completeTurn() {
        return "not a valid block";
      }
    },
    toolExecutor: new InProcessToolExecutor()
  });
  assert.equal(outcome.mode, "fail");
  assert.match(outcome.message, /Invalid assistant response/);
});
test("runtime accepts a repaired final response after one invalid provider output", async () => {
  const events: RuntimeEvent[] = [];
  const provider = createRepairAwareProvider({
    async main() {
      return "The answer is 42.";
    },
    async repair() {
      return createFinalResponse("The answer is 42.");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "What is the answer?",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor(),
    config: {
      onEvent(event) {
        events.push(event);
      }
    }
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "The answer is 42.");
  assert.equal(provider.mainCalls, 1);
  assert.equal(provider.repairCalls, 1);
  assert.equal(provider.repairInputs[0]?.invalidResponse, "The answer is 42.");
  assert.match(provider.repairInputs[0]?.validationError ?? "", /exactly one <final>/);
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "main_response_invalid" ||
          event.type === "repair_attempted" ||
          event.type === "repair_valid"
      )
      .map((event) => event.type),
    ["main_response_invalid", "repair_attempted", "repair_valid"]
  );
  const mainInvalid = events.find((event) => event.type === "main_response_invalid");
  const repairValid = events.find((event) => event.type === "repair_valid");
  assert.equal(mainInvalid?.rawTextLength, "The answer is 42.".length);
  assert.equal(repairValid?.mode, "final");
});
test("runtime accepts a repaired tool response and executes the repaired tool exactly once", async () => {
  let executed = 0;
  const provider = createRepairAwareProvider({
    async main(turn) {
      const toolResults = turn.conversation.entries.filter((entry) => entry.type === "tool_result");
      if (toolResults.length === 0) {
        return "I will inspect package.json first.";
      }
      return createFinalResponse("Read complete.");
    },
    async repair() {
      return createToolResponse({
        name: "read",
        arguments: {
          path: "package.json"
        }
      });
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor({
      tools: [
        {
          definition: {
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
          async execute(args) {
            executed += 1;
            return {
              path: String(args.path),
              content: "{}"
            };
          }
        }
      ]
    })
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "Read complete.");
  assert.equal(executed, 1);
  assert.equal(provider.repairCalls, 1);
});
test("runtime accepts a valid leading final block when provider appends trailing metadata text", async () => {
  const provider = createRepairAwareProvider({
    async main() {
      return "<final>Hello</final>User Greeting Response";
    },
    async repair() {
      throw new Error("repair should not be called");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Say hello.",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor()
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "Hello");
  assert.equal(provider.mainCalls, 1);
  assert.equal(provider.repairCalls, 0);
});
test("runtime recovers the last valid final block when provider echoes protocol text before it", async () => {
  const provider = createRepairAwareProvider({
    async main() {
      return [
        "<final> with no extra spaces or line breaks? Or the previous response had a period? Let me re-emit cleanly.",
        "final>Hello. How can I help?</final>"
      ].join("");
    },
    async repair() {
      throw new Error("repair should not be called");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Hello?",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor()
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "Hello. How can I help?");
  assert.equal(provider.mainCalls, 1);
  assert.equal(provider.repairCalls, 0);
});
test("runtime accepts bash tool calls with an optional description argument", async () => {
  const provider = createRepairAwareProvider({
    async main(turn) {
      const toolResults = turn.conversation.entries.filter((entry) => entry.type === "tool_result");
      if (toolResults.length === 0) {
        return createToolResponse({
          name: "bash",
          arguments: {
            command: "printf 'pong'",
            description: "Ping localhost substitute"
          }
        });
      }
      return createFinalResponse("done");
    },
    async repair() {
      throw new Error("repair should not be called");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Ping localhost and tell me what you get.",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor({
      tools: [createBashTool({ runtimeRoot: process.cwd() })]
    })
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "done");
  assert.equal(provider.repairCalls, 0);
});
test("runtime normalizes execute_shell_command tool calls to bash", async () => {
  const provider = createRepairAwareProvider({
    async main(turn) {
      const toolResults = turn.conversation.entries.filter((entry) => entry.type === "tool_result");
      if (toolResults.length === 0) {
        return createToolResponse({
          name: "execute_shell_command",
          arguments: {
            command: "printf 'pong'"
          }
        });
      }
      return createFinalResponse("done");
    },
    async repair() {
      throw new Error("repair should not be called");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Ping localhost and tell me what you get.",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor({
      tools: [createBashTool({ runtimeRoot: process.cwd() })]
    })
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "done");
  assert.equal(provider.repairCalls, 0);
});
test("bash tool detaches long-running commands and returns process metadata", async (t) => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-runtime-bash-"));
  const bashTool = createBashTool({ runtimeRoot });
  const result = (await bashTool.execute({
    command: "sleep 300"
  })) as {
    detached?: boolean;
    pid?: number | null;
    logPath?: string;
    exitCode?: number | null;
  };
  t.after(() => {
    if (typeof result.pid === "number") {
      try {
        process.kill(result.pid, "SIGTERM");
      } catch {}
    }
  });
  assert.equal(result.detached, true);
  assert.equal(result.exitCode, null);
  assert.equal(typeof result.pid, "number");
  assert.equal(typeof result.logPath, "string");
  const logText = await readFile(result.logPath!, "utf8");
  assert.match(logText, /\$ sleep 300/u);
});
test("runtime replays bridge-owned history on later turns when upstream binding has no parent id", async () => {
  const events: RuntimeEvent[] = [];
  let callIndex = 0;
  const provider: ProviderAdapter = {
    id: "history-replay-provider",
    async completeTurn(turn) {
      callIndex += 1;
      if (callIndex === 1) {
        return createFinalResponse("Hello");
      }
      const replayedHistory = JSON.stringify(turn.conversation.sessionHistory ?? []);
      return createFinalResponse(
        replayedHistory.includes("Hello") ? "History replayed" : "History missing"
      );
    }
  };
  const toolExecutor = new InProcessToolExecutor();
  const first = await runBridgeRuntime({
    userMessage: "Hello?",
    provider,
    toolExecutor,
    config: {
      onEvent(event) {
        events.push(event);
      }
    }
  });
  assert.equal(first.mode, "final");
  const second = await runBridgeRuntime({
    userMessage: "What did I say before?",
    sessionHistory: [
      {
        userMessage: "Hello?",
        assistantMessage: "Hello",
        assistantMode: "final"
      }
    ],
    provider,
    toolExecutor
  });
  assert.equal(second.mode, "final");
  assert.equal(second.message, "History replayed");
});
for (const scenario of [
  {
    name: "invalid repair output",
    repairOutput: "still invalid",
    expectedError: /Invalid assistant response/
  },
  {
    name: "repair output with extra prose",
    repairOutput: '<tool>{"name":"read","arguments":{"path":"package.json"}}</tool>\nDone.',
    expectedError: /Invalid assistant response/
  },
  {
    name: "repair output with invalid JSON",
    repairOutput: '<tool>{"name":"read","arguments":}</tool>',
    expectedError: /valid JSON/
  },
  {
    name: "repair output with an unknown tool",
    repairOutput: createToolResponse({
      name: "unknown_tool",
      arguments: {}
    }),
    expectedError: /not registered/
  },
  {
    name: "repair output with invalid args schema",
    repairOutput: createToolResponse({
      name: "read",
      arguments: {
        path: false
      } as never
    }),
    expectedError: /must be a string/
  }
]) {
  test(`runtime fails closed on ${scenario.name} and never executes a tool`, async () => {
    const events: RuntimeEvent[] = [];
    let executed = 0;
    const provider = createRepairAwareProvider({
      async main() {
        return "I will inspect package.json first.";
      },
      async repair() {
        return scenario.repairOutput;
      }
    });
    const outcome = await runBridgeRuntime({
      userMessage: "Read package.json.",
      provider: provider.provider,
      toolExecutor: new InProcessToolExecutor({
        tools: [
          {
            definition: {
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
            async execute() {
              executed += 1;
              return {};
            }
          }
        ]
      }),
      config: {
        onEvent(event) {
          events.push(event);
        }
      }
    });
    assert.equal(outcome.mode, "fail");
    assert.equal(executed, 0);
    assert.equal(provider.repairCalls, 1);
    assert.match(outcome.message, scenario.expectedError);
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.type === "main_response_invalid" ||
            event.type === "repair_attempted" ||
            event.type === "repair_failed"
        )
        .map((event) => event.type),
      ["main_response_invalid", "repair_attempted", "repair_failed"]
    );
  });
}
test("runtime marks repair_failed with provider_failure when the repair attempt throws", async () => {
  const events: RuntimeEvent[] = [];
  const provider = createRepairAwareProvider({
    async main() {
      return "I will inspect package.json first.";
    },
    async repair() {
      throw new Error("repair transport failed");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: provider.provider,
    toolExecutor: new InProcessToolExecutor(),
    config: {
      onEvent(event) {
        events.push(event);
      }
    }
  });
  assert.equal(outcome.mode, "fail");
  const repairFailed = events.find((event) => event.type === "repair_failed");
  assert.equal(repairFailed?.reason, "provider_failure");
  assert.match(repairFailed?.providerFailure?.message ?? "", /repair transport failed/);
});
test("runtime rejects unknown tools without executing anything", async () => {
  let executed = false;
  const outcome = await runBridgeRuntime({
    userMessage: "Inspect the system",
    provider: {
      id: "unknown-tool-provider",
      async completeTurn() {
        return createToolResponse({
          name: "wifi_scan",
          arguments: {
            interface: "auto"
          }
        });
      }
    },
    toolExecutor: {
      async getAvailableTools() {
        return [];
      },
      async executeTool() {
        executed = true;
        return {
          ok: true,
          payload: {}
        };
      }
    }
  });
  assert.equal(outcome.mode, "fail");
  assert.equal(executed, false);
  assert.match(outcome.message, /not registered/);
});
test("runtime rejects invalid tool arguments without executing anything", async () => {
  let executed = false;
  const outcome = await runBridgeRuntime({
    userMessage: "Toggle the flag",
    provider: {
      id: "bad-args-provider",
      async completeTurn() {
        return createToolResponse({
          name: "toggle",
          arguments: {
            enabled: "yes"
          } as never
        });
      }
    },
    toolExecutor: {
      async getAvailableTools() {
        return [
          {
            name: "toggle",
            description: "Toggle a flag.",
            inputSchema: {
              type: "object",
              properties: {
                enabled: {
                  type: "boolean",
                  description: "Next flag state."
                }
              },
              required: ["enabled"]
            }
          }
        ];
      },
      async executeTool() {
        executed = true;
        return {
          ok: true,
          payload: {}
        };
      }
    }
  });
  assert.equal(outcome.mode, "fail");
  assert.equal(executed, false);
  assert.match(outcome.message, /must be a boolean/);
});
