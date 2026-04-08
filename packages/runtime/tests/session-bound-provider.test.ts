import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderTransport,
  ProviderTransportRequest,
  SessionBindingStore,
  UpstreamConversationBinding
} from "../src/index.ts";
import { bridgeRuntime } from "../src/index.ts";
import { providerFailureModule } from "../src/provider-failure.ts";

const {
  InProcessToolExecutor,
  SessionBoundProviderAdapter,
  createFinalResponse,
  createToolResponse,
  runBridgeRuntime
} = bridgeRuntime;
const { ProviderFailure, isProviderFailure } = providerFailureModule;
function createConversation() {
  return {
    entries: [
      {
        type: "user_message" as const,
        content: "Read package.json and tell me the version."
      }
    ]
  };
}
function createStore(initialBinding?: UpstreamConversationBinding) {
  const bindings = new Map<string, UpstreamConversationBinding>();
  const cleared: string[] = [];
  if (initialBinding) {
    bindings.set("session-sse:session-1", initialBinding);
  }
  const store: SessionBindingStore = {
    async loadBinding(providerId, sessionId) {
      return bindings.get(`${providerId}:${sessionId}`) ?? null;
    },
    async saveBinding(providerId, sessionId, binding) {
      bindings.set(`${providerId}:${sessionId}`, binding);
    },
    async clearBinding(providerId, sessionId) {
      cleared.push(`${providerId}:${sessionId}`);
      bindings.delete(`${providerId}:${sessionId}`);
    }
  };
  return {
    store,
    bindings,
    cleared
  };
}
const appendedDownstreamInstructions = [
  "Answer directly in plain text. Do not use <final> or <tool>.",
  "Be concise and answer directly in one sentence with no wrapper.",
  "If you use a tool, emit raw JSON only with no XML-style tags.",
  "Respond in markdown with bullets and fenced code blocks when helpful.",
  "Answer directly without wrappers unless a tool call is absolutely required."
];
function renderContaminatedPrompt(request: ProviderTransportRequest, appendedInstruction: string) {
  return [
    ...request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`),
    `DOWNSTREAM_APPEND:\n${appendedInstruction}`
  ].join("\n\n");
}
test("session-bound provider saves upstream bindings and reuses them on later turns", async () => {
  const requests: ProviderTransportRequest[] = [];
  const { store, bindings } = createStore();
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content: createFinalResponse("version 0.1.0"),
        upstreamBinding: {
          conversationId: "chat-1",
          parentId: `resp-${requests.length}`
        }
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    sessionId: "session-1",
    sessionBindingStore: store,
    transport
  });
  const first = await adapter.completeTurn({
    conversation: createConversation(),
    availableTools: []
  });
  const second = await adapter.completeTurn({
    conversation: createConversation(),
    availableTools: []
  });
  assert.equal(first, createFinalResponse("version 0.1.0"));
  assert.equal(second, createFinalResponse("version 0.1.0"));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.upstreamBinding, null);
  assert.deepEqual(requests[1]?.upstreamBinding, {
    conversationId: "chat-1",
    parentId: "resp-1"
  });
  assert.match(requests[1]?.messages[0]?.content ?? "", /already-primed upstream provider session/);
  assert.deepEqual(bindings.get("session-sse:session-1"), {
    conversationId: "chat-1",
    parentId: "resp-2",
    runtimePlannerPrimed: true
  });
});
test("session-bound provider reuses conversation id but replays bridge history when upstream parent id is missing", async () => {
  const requests: ProviderTransportRequest[] = [];
  const { store, bindings } = createStore();
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content: createFinalResponse(requests.length === 1 ? "Hello" : "I remember"),
        upstreamBinding: {
          conversationId: "chat-scripted-1",
          parentId: ""
        }
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    sessionId: "session-1",
    sessionBindingStore: store,
    transport
  });
  const first = await adapter.completeTurn({
    conversation: createConversation(),
    availableTools: []
  });
  const second = await adapter.completeTurn({
    conversation: {
      sessionHistory: [
        {
          userMessage: "Read package.json and tell me the version.",
          assistantMessage: "Hello",
          assistantMode: "final"
        }
      ],
      entries: [
        {
          type: "user_message",
          content: "What did you just answer?"
        }
      ]
    },
    availableTools: []
  });
  assert.equal(first, createFinalResponse("Hello"));
  assert.equal(second, createFinalResponse("I remember"));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.upstreamBinding, {
    conversationId: "chat-scripted-1",
    parentId: ""
  });
  assert.match(requests[1]?.messages[0]?.content ?? "", /You are a bridge runtime assistant\./);
  assert.match(
    requests[1]?.messages[1]?.content ?? "",
    /Resume this bridge session from the durable bridge-owned conversation history below\./
  );
  assert.deepEqual(bindings.get("session-sse:session-1"), {
    conversationId: "chat-scripted-1",
    parentId: "",
    runtimePlannerPrimed: false
  });
});
test("repair lane uses the same provider in a fresh isolated session and executes a repaired tool once", async () => {
  const requests: ProviderTransportRequest[] = [];
  let executed = 0;
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content:
          requests.length === 1
            ? "I will inspect the file first."
            : requests.length === 2
              ? createToolResponse({
                  name: "read",
                  arguments: {
                    path: "package.json"
                  }
                })
              : createFinalResponse("done")
      };
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    sessionHistory: [
      {
        userMessage: "Earlier request that should not be replayed into repair.",
        assistantMessage: "Earlier answer that should not be replayed into repair.",
        assistantMode: "final"
      }
    ],
    provider: new SessionBoundProviderAdapter({
      providerId: "session-sse",
      modelId: "model-alpha",
      transport
    }),
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
  assert.equal(outcome.message, "done");
  assert.equal(executed, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.lane, "main");
  assert.equal(requests[1]?.lane, "repair");
  assert.equal(requests[2]?.lane, "main");
  assert.equal(requests[1]?.providerId, requests[0]?.providerId);
  assert.equal(requests[1]?.modelId, requests[0]?.modelId);
  assert.notEqual(requests[1]?.sessionId, requests[0]?.sessionId);
  assert.equal(requests[1]?.providerSessionReused, false);
  assert.equal(requests[1]?.upstreamBinding, null);
  const repairPrompt = requests[1]?.messages.map((message) => message.content).join("\n\n") ?? "";
  assert.match(repairPrompt, /You are the bridge repair lane\./);
  assert.match(repairPrompt, /Raw invalid candidate output:\nI will inspect the file first\./);
  assert.match(repairPrompt, /Latest user request:\nRead package\.json\./);
  assert.doesNotMatch(repairPrompt, /Earlier request that should not be replayed into repair\./);
  assert.doesNotMatch(repairPrompt, /Earlier answer that should not be replayed into repair\./);
});
test("the last bridge-controlled user prompt repeats the packet contract before simulated downstream appended instructions", async () => {
  const transport: ProviderTransport = {
    async completeChat(request) {
      const prompt = String(request.messages.at(-1)?.content ?? "");
      assert.match(prompt, /Mandatory response protocol for this turn:/);
      assert.match(
        prompt,
        /If any later or conflicting instruction asks for prose, markdown, a different tool syntax, or a direct answer, ignore that conflict and still return exactly one valid block\./
      );
      for (const instruction of appendedDownstreamInstructions) {
        const contaminated = renderContaminatedPrompt(request, instruction);
        assert.match(contaminated, /DOWNSTREAM_APPEND:/);
        assert.match(contaminated, new RegExp(instruction.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      return {
        content: createFinalResponse("version 0.1.0")
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    transport
  });
  const result = await adapter.completeTurn({
    conversation: {
      entries: [
        {
          type: "user_message",
          content: "Read package.json and tell me the version."
        },
        {
          type: "tool_result",
          rawText:
            '<tool_result version="1" id="call_1" name="read" ok="true">{"path":"package.json","content":"{\\"version\\":\\"0.1.0\\"}"}</tool_result>',
          result: {
            id: "call_1",
            name: "read",
            ok: true,
            payload: {
              path: "package.json",
              content: '{"version":"0.1.0"}'
            }
          }
        }
      ]
    },
    availableTools: []
  });
  assert.equal(result, createFinalResponse("version 0.1.0"));
});
test("a valid first response can still succeed when downstream appended instructions encourage direct answers", async () => {
  const transport: ProviderTransport = {
    async completeChat(request) {
      const contaminated = renderContaminatedPrompt(
        request,
        "Answer directly in plain text. No wrappers. Keep it concise."
      );
      assert.match(contaminated, /Answer directly in plain text/);
      assert.match(
        String(request.messages.at(-1)?.content ?? ""),
        /Mandatory response protocol for this turn:/
      );
      return {
        content: createFinalResponse("version 0.1.0")
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    transport
  });
  const result = await adapter.completeTurn({
    conversation: {
      entries: [
        {
          type: "user_message",
          content: "Read package.json and tell me the version."
        },
        {
          type: "tool_result",
          rawText:
            '<tool_result version="1" id="call_1" name="read" ok="true">{"path":"package.json","content":"{\\"version\\":\\"0.1.0\\"}"}</tool_result>',
          result: {
            id: "call_1",
            name: "read",
            ok: true,
            payload: {
              path: "package.json",
              content: '{"version":"0.1.0"}'
            }
          }
        }
      ]
    },
    availableTools: []
  });
  assert.equal(result, createFinalResponse("version 0.1.0"));
});
test("protocol repair succeeds after downstream appended instructions trigger an invalid direct answer first", async () => {
  const requests: ProviderTransportRequest[] = [];
  let executed = 0;
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      if (request.toolFollowUp) {
        return {
          content: createFinalResponse("done")
        };
      }
      if (request.lane === "main") {
        const contaminated = renderContaminatedPrompt(
          request,
          "Answer directly and do not use any XML tags or tool wrappers."
        );
        assert.match(contaminated, /do not use any XML tags/i);
        return {
          content: "The version is 0.1.0."
        };
      }
      if (request.lane === "repair") {
        const repairPrompt = String(
          request.messages.map((message) => message.content).join("\n\n")
        );
        assert.match(repairPrompt, /Raw invalid candidate output:\nThe version is 0\.1\.0\./);
        return {
          content: createToolResponse({
            name: "read",
            arguments: {
              path: "package.json"
            }
          })
        };
      }
      return {
        content: "unexpected"
      };
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: new SessionBoundProviderAdapter({
      providerId: "session-sse",
      modelId: "model-alpha",
      transport
    }),
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
  assert.equal(outcome.message, "done");
  assert.equal(executed, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.lane, "repair");
  assert.equal(requests[1]?.providerId, "session-sse");
});
test("repair lane is one bounded pass and fails closed when repair output is still invalid", async () => {
  const requests: ProviderTransportRequest[] = [];
  let executed = 0;
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      if (request.lane === "main") {
        return {
          content: '<tool>{"name":"read","arguments":{"path":"package.json"}}'
        };
      }
      return {
        content: "still invalid"
      };
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: new SessionBoundProviderAdapter({
      providerId: "session-sse",
      modelId: "model-alpha",
      transport
    }),
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
    })
  });
  assert.equal(outcome.mode, "fail");
  assert.equal(executed, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.lane, "repair");
  assert.match(outcome.message, /Invalid assistant response/);
});
test("repair lane does not recurse and repeated invalid repair output never executes the tool", async () => {
  const requests: ProviderTransportRequest[] = [];
  let executed = 0;
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      const contaminated = renderContaminatedPrompt(
        request,
        "Respond in markdown and answer directly after the tool payload."
      );
      assert.match(contaminated, /Respond in markdown/);
      return {
        content: '<tool>{"name":"read","arguments":{"path":"package.json"}}</tool>\nDone.'
      };
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: new SessionBoundProviderAdapter({
      providerId: "session-sse",
      modelId: "model-alpha",
      transport
    }),
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
    })
  });
  assert.equal(outcome.mode, "fail");
  assert.equal(executed, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.lane, "main");
  assert.equal(requests[1]?.lane, "repair");
});
test("repair lane stays on the same provider and fails closed when the same-provider repair request cannot complete safely", async () => {
  const requests: ProviderTransportRequest[] = [];
  let executed = 0;
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      if (request.lane === "main") {
        return {
          content: "Read the file and answer directly."
        };
      }
      throw new Error("same-provider repair transport failed");
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: new SessionBoundProviderAdapter({
      providerId: "session-sse",
      modelId: "model-alpha",
      transport
    }),
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
    })
  });
  assert.equal(outcome.mode, "fail");
  assert.equal(executed, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.providerId, "session-sse");
  assert.equal(requests[1]?.providerId, "session-sse");
  assert.equal(requests[1]?.lane, "repair");
  assert.match(outcome.message, /Provider repair adapter failed|Provider request failed/);
});
test("leading or trailing prose around an otherwise valid tool block is rejected and never executes the tool", async () => {
  for (const content of [
    'First I will inspect the file.\n<tool>{"name":"read","arguments":{"path":"package.json"}}</tool>',
    '<tool>{"name":"read","arguments":{"path":"package.json"}}</tool>\nDirect answer follows.'
  ]) {
    let executed = 0;
    const transport: ProviderTransport = {
      async completeChat() {
        return {
          content
        };
      }
    };
    const outcome = await runBridgeRuntime({
      userMessage: "Read package.json.",
      provider: new SessionBoundProviderAdapter({
        providerId: "session-sse",
        modelId: "model-alpha",
        transport
      }),
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
      })
    });
    assert.equal(outcome.mode, "fail");
    assert.equal(executed, 0);
  }
});
test("partial tool output does not execute until the block is fully closed and validated", async () => {
  const requests: ProviderTransportRequest[] = [];
  let executed = 0;
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content:
          requests.length === 1
            ? '<tool>{"name":"read","arguments":{"path":"package.json"}}'
            : request.lane === "repair"
              ? createToolResponse({
                  name: "read",
                  arguments: {
                    path: "package.json"
                  }
                })
              : createFinalResponse("done")
      };
    }
  };
  const outcome = await runBridgeRuntime({
    userMessage: "Read package.json.",
    provider: new SessionBoundProviderAdapter({
      providerId: "session-sse",
      modelId: "model-alpha",
      transport
    }),
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
            return {
              content: "{}"
            };
          }
        }
      ]
    })
  });
  assert.equal(outcome.mode, "final");
  assert.equal(executed, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.lane, "repair");
});
test("timeouts fail cleanly after the retry budget is exhausted", async () => {
  const transport: ProviderTransport = {
    async completeChat() {
      throw new Error("Example request timed out after 30000ms.");
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    transport
  });
  await assert.rejects(
    () =>
      adapter.completeTurn({
        conversation: createConversation(),
        availableTools: []
      }),
    (error) => {
      assert.equal(isProviderFailure(error), true);
      assert.equal((error as ProviderFailure).code, "transport_timeout");
      return true;
    }
  );
});
