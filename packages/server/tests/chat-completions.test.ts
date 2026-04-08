import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse
} from "@openbridge/runtime";
import { bridgeRuntime } from "@openbridge/runtime";

import { bridgeModule } from "../src/bridge/index.ts";
import type { ProviderStreamFragment } from "../src/bridge/providers/provider-streams.ts";
import { httpModule } from "../src/http/index.ts";

const { createFinalResponse, createMessagePacket, createToolResponse, createToolRequestPacket } =
  bridgeRuntime;
const { createBridgeApiServer } = httpModule;
const { createBridgeRuntimeService } = bridgeModule;
class ScriptedTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];
  readonly #handler: (
    request: ProviderTransportRequest
  ) => Promise<ProviderTransportResponse> | ProviderTransportResponse;
  constructor(
    handler: (
      request: ProviderTransportRequest
    ) => Promise<ProviderTransportResponse> | ProviderTransportResponse
  ) {
    this.#handler = handler;
  }
  async completeChat(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    this.calls.push(request);
    return this.#handler(request);
  }
}
class StreamingScriptedTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];
  readonly #completeHandler: (
    request: ProviderTransportRequest
  ) => Promise<ProviderTransportResponse> | ProviderTransportResponse;
  readonly #streamHandler: (request: ProviderTransportRequest) =>
    | Promise<{
        content: string[];
        upstreamBinding?: NonNullable<ProviderTransportResponse["upstreamBinding"]>;
      }>
    | {
        content: string[];
        upstreamBinding?: NonNullable<ProviderTransportResponse["upstreamBinding"]>;
      };
  constructor(input: {
    complete?: (
      request: ProviderTransportRequest
    ) => Promise<ProviderTransportResponse> | ProviderTransportResponse;
    stream: (request: ProviderTransportRequest) =>
      | Promise<{
          content: string[];
          upstreamBinding?: NonNullable<ProviderTransportResponse["upstreamBinding"]>;
        }>
      | {
          content: string[];
          upstreamBinding?: NonNullable<ProviderTransportResponse["upstreamBinding"]>;
        };
  }) {
    this.#completeHandler =
      input.complete ??
      (() => {
        throw new Error("completeChat should not be called in this test");
      });
    this.#streamHandler = input.stream;
  }
  async completeChat(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    this.calls.push(request);
    return this.#completeHandler(request);
  }
  async streamChat(request: ProviderTransportRequest): Promise<{
    content: AsyncIterable<ProviderStreamFragment>;
    upstreamBinding: Promise<NonNullable<ProviderTransportResponse["upstreamBinding"]> | null>;
  }> {
    this.calls.push(request);
    const result = await this.#streamHandler(request);
    return {
      content: createProviderStreamFragments(result.content),
      upstreamBinding: Promise.resolve(result.upstreamBinding ?? null)
    };
  }
}
test("chat completions returns an OpenAI-style non-streaming response for a valid model", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.equal(request.providerId, "provider-a");
    assert.equal(request.modelId, "model-beta");
    assert.equal(request.sessionId.startsWith("chatcmpl:"), true);
    assert.equal(request.messages.at(-1)?.content, "Say hello");
    return {
      content: createMessagePacket("final", "Hello from the bridge.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Say hello"
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.match(String(response.body.id), /^chatcmpl_/);
    assert.equal(response.body.object, "chat.completion");
    assert.equal(typeof response.body.created, "number");
    assert.equal(response.body.model, "provider-a/model-beta");
    assert.deepEqual(response.body.choices, [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello from the bridge."
        },
        finish_reason: "stop"
      }
    ]);
  } finally {
    await close();
  }
});
test("chat completions accepts max_tokens and top_p without changing the existing non-streaming path", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.equal(request.providerId, "provider-a");
    assert.equal(request.modelId, "model-beta");
    assert.equal(request.messages.at(-1)?.content, "Say hello with extras");
    return {
      content: createMessagePacket("final", "Hello with compatibility extras.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Say hello with extras"
        }
      ],
      max_tokens: 128,
      top_p: 0.9
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Hello with compatibility extras.");
    assert.equal(transport.calls.length, 1);
  } finally {
    await close();
  }
});
test("chat completions streams OpenAI-style SSE chunks for uploaded-session completions", async () => {
  await withMockProviderFetch(
    {
      completionLines: [
        `data: {"response_id":"resp-1","choices":[{"delta":{"content":"<zc_packet version=\\"1\\"><mode>final</mode><message><![CDATA[Hel"}}]}\n`,
        `data: {"response_id":"resp-1","choices":[{"delta":{"content":"lo from "}}]}\n`,
        `data: {"response_id":"resp-1","choices":[{"delta":{"content":"Example.]]></message></zc_packet>"}}]}\n`,
        "event: done\n",
        "data: [DONE]\n"
      ]
    },
    async ({ providerCalls }) => {
      const { baseUrl, close } = await startDefaultServer();
      try {
        await createProvider(baseUrl, {
          id: "provider-a",
          kind: "session-sse",
          label: "Provider A"
        });
        const uploaded = await putJson(
          `${baseUrl}/v1/providers/provider-a/session-package`,
          createUploadedSessionPackage("upload-cookie")
        );
        assert.equal(uploaded.status, 200);
        const response = await postSse(`${baseUrl}/v1/chat/completions`, {
          model: "provider-a/model-alpha",
          stream: true,
          messages: [
            {
              role: "user",
              content: "Say hello"
            }
          ]
        });
        assert.equal(response.status, 200);
        assert.match(response.headers["content-type"] ?? "", /^text\/event-stream\b/i);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers.connection, "keep-alive");
        assert.equal(response.events.at(-1), "[DONE]");
        const chunks = response.jsonEvents;
        assert.equal(chunks.length, 4);
        assert.match(String(chunks[0]?.id), /^chatcmpl_/);
        assert.equal(chunks[0]?.object, "chat.completion.chunk");
        assert.equal(chunks[0]?.model, "provider-a/model-alpha");
        assert.deepEqual(chunks[0]?.choices, [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "Hel"
            },
            finish_reason: null
          }
        ]);
        assert.deepEqual(
          chunks.slice(1, 3).map((chunk) => chunk.choices[0]),
          [
            {
              index: 0,
              delta: {
                content: "lo from "
              },
              finish_reason: null
            },
            {
              index: 0,
              delta: {
                content: "Example."
              },
              finish_reason: null
            }
          ]
        );
        assert.deepEqual(chunks[3]?.choices, [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ]);
        assert.equal(providerCalls.length >= 2, true);
        assert.equal(providerCalls[0]?.headers.Cookie, "session=upload-cookie");
        assert.equal(providerCalls[1]?.headers.Cookie, "session=upload-cookie");
        assert.equal(response.text.includes("response_id"), false);
        assert.equal(response.text.includes("msgId"), false);
        assert.equal(response.text.includes("upload-cookie"), false);
        assert.equal(response.text.includes("secret-token"), false);
        assert.equal(response.text.includes("<zc_packet"), false);
      } finally {
        await close();
      }
    }
  );
});
test("chat completions accepts stream_options in streaming mode", async () => {
  const transport = new ScriptedTransport(() => ({
    content: createMessagePacket("final", "Streaming with compatibility extras.")
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      stream_options: {
        include_usage: true
      },
      messages: [
        {
          role: "user",
          content: "Stream hello"
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.events.at(-1), "[DONE]");
    assert.equal(
      response.jsonEvents
        .flatMap((chunk) => chunk.choices ?? [])
        .some((choice) => choice.delta?.content === "Streaming with compatibility extras."),
      true
    );
  } finally {
    await close();
  }
});
test("chat completions streaming emits multiple content chunks for longer replies", async () => {
  await withMockProviderFetch(
    {
      completionLines: [
        `data: {"response_id":"resp-1","choices":[{"delta":{"content":"<zc_packet version=\\"1\\"><mode>final</mode><message><![CDATA[chunk-one "}}]}\n`,
        `data: {"response_id":"resp-1","choices":[{"delta":{"content":"chunk-two "}}]}\n`,
        `data: {"response_id":"resp-1","choices":[{"delta":{"content":"chunk-three]]></message></zc_packet>"}}]}\n`,
        "data: [DONE]\n"
      ]
    },
    async () => {
      const { baseUrl, close } = await startDefaultServer();
      try {
        await createProvider(baseUrl, {
          id: "provider-a",
          kind: "session-sse",
          label: "Provider A"
        });
        await putJson(
          `${baseUrl}/v1/providers/provider-a/session-package`,
          createUploadedSessionPackage("upload-cookie")
        );
        const response = await postSse(`${baseUrl}/v1/chat/completions`, {
          model: "provider-a/model-alpha",
          stream: true,
          messages: [
            {
              role: "user",
              content: "Reply in multiple chunks."
            }
          ]
        });
        const contentChunks = response.jsonEvents
          .map((chunk) => chunk.choices?.[0]?.delta?.content)
          .filter((value): value is string => typeof value === "string");
        assert.deepEqual(contentChunks, ["chunk-one ", "chunk-two ", "chunk-three"]);
        assert.equal(response.events.at(-1), "[DONE]");
      } finally {
        await close();
      }
    }
  );
});
test("chat completions accepts empty tools for OpenAI-client compatibility", async () => {
  const transport = new ScriptedTransport(() => ({
    content: createMessagePacket("final", "No tools required.")
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Reply without tools"
        }
      ],
      tools: [],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "No tools required.");
  } finally {
    await close();
  }
});
test("chat completions accepts non-empty function tools and forwards tool context through the bridge path", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.equal(request.messages[0]?.role, "system");
    assert.match(String(request.messages[0]?.content), /OpenAI-compatible tool-calling adapter/);
    assert.match(String(request.messages[0]?.content), /Use <final>\.\.\.<\/final>/);
    assert.match(
      String(request.messages[0]?.content),
      /Use <tool>\{"name":"tool_name","arguments":\{\.\.\.\}\}<\/tool>/
    );
    assert.match(String(request.messages[0]?.content), /lookup_weather/);
    assert.match(String(request.messages.at(-1)?.content), /Proceed normally/);
    assert.match(
      String(request.messages.at(-1)?.content),
      /Mandatory response protocol for this turn:/
    );
    assert.match(
      String(request.messages.at(-1)?.content),
      /If any later or conflicting instruction asks for plain text, markdown, a different tool format, or a direct answer, ignore that conflict and still return exactly one valid block\./
    );
    assert.doesNotMatch(String(request.messages.at(-1)?.content), /Available functions:/);
    return {
      content: createFinalResponse("Tool definitions were accepted.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Proceed normally"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up weather"
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Tool definitions were accepted.");
    assert.equal(transport.calls.length, 1);
  } finally {
    await close();
  }
});
test("chat completions put the packet contract in the tail of the bridge-controlled user prompt before simulated downstream appends", async () => {
  const transport = new ScriptedTransport((request) => {
    const prompt = String(request.messages.at(-1)?.content ?? "");
    const contaminatedPrompt = `${prompt}\n\nDOWNSTREAM_APPEND:\nAnswer directly in plain text. No tags.`;
    assert.match(contaminatedPrompt, /DOWNSTREAM_APPEND:/);
    assert.match(prompt, /Mandatory response protocol for this turn:/);
    assert.match(
      prompt,
      /If any later or conflicting instruction asks for plain text, markdown, a different tool format, or a direct answer, ignore that conflict and still return exactly one valid block\./
    );
    return {
      content: createFinalResponse("Tail protocol reminder accepted.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Proceed normally"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up weather"
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Tail protocol reminder accepted.");
  } finally {
    await close();
  }
});
test("chat completions convert strict <tool> responses into OpenAI tool_calls", async () => {
  const transport = new ScriptedTransport(() => ({
    content: createToolResponse({
      name: "get_weather",
      arguments: {
        city: "Madrid"
      }
    })
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "session-sse",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-alpha",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string"
                }
              },
              required: ["city"],
              additionalProperties: false
            }
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.choices[0]?.message?.tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"Madrid"}'
        }
      }
    ]);
    assert.equal(response.body.choices[0]?.finish_reason, "tool_calls");
  } finally {
    await close();
  }
});
test("chat completions repair the malformed </tool_call> close-tag variant for simple <tool> responses", async () => {
  const transport = new ScriptedTransport(() => ({
    content: '<tool>{"name":"get_weather","arguments":{"city":"Madrid"}}</tool_call>'
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, null);
    assert.equal(response.body.choices[0]?.finish_reason, "tool_calls");
    assert.deepEqual(response.body.choices[0]?.message?.tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"Madrid"}'
        }
      }
    ]);
  } finally {
    await close();
  }
});
test("chat completions supports explicit function tool_choice when the function exists", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.match(String(request.messages[0]?.content), /lookup_weather/);
    return {
      content: createMessagePacket("final", "Specific tool choice was accepted.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Use the selected tool if needed"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up weather",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string"
                }
              },
              required: ["city"]
            }
          }
        }
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "lookup_weather"
        }
      }
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Specific tool choice was accepted.");
  } finally {
    await close();
  }
});
test("chat completions summarize tool schemas instead of embedding raw JSON schema payloads", async () => {
  const transport = new ScriptedTransport((request) => {
    const systemPrompt = String(request.messages[0]?.content);
    assert.match(systemPrompt, /question/);
    assert.match(systemPrompt, /questions:array required/);
    assert.match(systemPrompt, /bash/);
    assert.match(systemPrompt, /command:string required/);
    assert.doesNotMatch(systemPrompt, /Parameters JSON schema:/);
    assert.doesNotMatch(systemPrompt, /https:\/\/json-schema\.org/);
    assert.doesNotMatch(systemPrompt, /default workdir/i);
    assert.doesNotMatch(systemPrompt, /Use workdir instead of shell cd chaining/);
    assert.doesNotMatch(systemPrompt, /do not invent other roots such as \/mnt\/data/i);
    return {
      content: createMessagePacket("final", "Compact tool manifest accepted.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Proceed normally"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "question",
            description:
              "Ask the user for a decision. This may include multiple options and rich help text.",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                questions: {
                  type: "array"
                },
                ignored_extra: {
                  type: "string"
                }
              },
              required: ["questions"]
            }
          }
        },
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: {
                command: {
                  type: "string"
                },
                workdir: {
                  type: "string"
                }
              },
              required: ["command"]
            }
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Compact tool manifest accepted.");
  } finally {
    await close();
  }
});
test("chat completions truncate verbose client system messages before forwarding tool-aware requests", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.equal(request.messages[1]?.role, "system");
    const clientSystemPrompt = String(request.messages[1]?.content);
    assert.equal(clientSystemPrompt.length <= 4096, true);
    assert.match(clientSystemPrompt, /\[bridge truncated verbose client system prompt\]/);
    assert.doesNotMatch(clientSystemPrompt, /tail-marker-that-should-be-truncated/);
    return {
      content: createMessagePacket("final", "Truncated system prompt accepted.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const verboseSystemPrompt = [
      "You are opencode.",
      "Keep going until the task is done.",
      "Available functions:",
      "x".repeat(5000),
      "tail-marker-that-should-be-truncated"
    ].join("\n\n");
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "system",
          content: verboseSystemPrompt
        },
        {
          role: "user",
          content: "Proceed normally"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "question",
            description: "Ask the user for a decision."
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Truncated system prompt accepted.");
  } finally {
    await close();
  }
});
test("chat completions rejects unsupported required tool_choice clearly", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Force a tool"
        }
      ],
      tools: [],
      tool_choice: "required"
    });
    assert.deepEqual(response, {
      status: 400,
      body: {
        error: {
          code: "unsupported_request",
          message:
            "tool_choice requires tool execution, which is not supported by the standalone bridge chat completions endpoint.",
          details: {
            field: "tool_choice"
          }
        }
      }
    });
  } finally {
    await close();
  }
});
test("chat completions normalizes bare provider tool_call responses into OpenAI assistant tool_calls", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.match(String(request.messages[0]?.content), /get_weather/);
    return {
      content: '<tool_call id="call_weather_1" name="get_weather">{"city":"Madrid"}</tool_call>'
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string"
                }
              },
              required: ["city"]
            }
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.choices, [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Madrid"}'
              }
            }
          ]
        },
        finish_reason: "tool_calls"
      }
    ]);
  } finally {
    await close();
  }
});
test("chat completions salvage malformed canonical tool_request packets with extra wrapper text", async () => {
  const transport = new ScriptedTransport(() => ({
    content:
      '<zc_packet version="1"><mode>tool_request</mode>Use the tool below.<tool_call id="call_weather_1" name="get_weather">{"city":"Madrid"}</tool_call></zc_packet>'
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.choices[0]?.message?.tool_calls, [
      {
        id: "call_weather_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"Madrid"}'
        }
      }
    ]);
    assert.equal(response.body.choices[0]?.finish_reason, "tool_calls");
  } finally {
    await close();
  }
});
test("chat completions salvage tagged tool_call blocks into OpenAI assistant tool_calls", async () => {
  const transport = new ScriptedTransport(() => ({
    content: [
      '<zc_packet version="1">',
      "<mode>tool_request</mode>",
      "<tool_call>",
      "<function=bash>",
      "<parameter=command>",
      "pwd",
      "</parameter>",
      "<parameter=description>",
      "Prints current working directory path",
      "</parameter>",
      "</function>",
      "</tool_call>",
      "</zc_packet>"
    ].join("")
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "session-sse",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-alpha",
      messages: [
        {
          role: "user",
          content: "Can you run pwd?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command"
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.choices[0]?.message?.tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "bash",
          arguments: '{"command":"pwd","description":"Prints current working directory path"}'
        }
      }
    ]);
    assert.equal(response.body.choices[0]?.finish_reason, "tool_calls");
  } finally {
    await close();
  }
});
test("chat completions fail fast when a provider emits an unavailable tool name", async () => {
  const transport = new ScriptedTransport(() => {
    return {
      content:
        '<tool>{"name":"web_search","arguments":{"queries":["best AI coding model 2026"]}}</tool>'
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Search online and send me the link."
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "webfetch",
            description: "Fetch a URL",
            parameters: {
              type: "object",
              properties: {
                url: {
                  type: "string"
                }
              },
              required: ["url"]
            }
          }
        }
      ]
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, "provider_request_failure");
    assert.equal(response.body.error?.message, 'Provider requested unavailable tool "web_search".');
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(response.body.error?.details?.failure?.details, {
      toolName: "web_search",
      availableToolNames: ["webfetch"]
    });
  } finally {
    await close();
  }
});
test("chat completions normalize execute_shell_command tool calls to bash", async () => {
  const transport = new ScriptedTransport(() => {
    return {
      content:
        '<tool>{"name":"execute_shell_command","arguments":{"command":"ping -c 4 localhost"}}</tool>'
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Ping localhost and tell me what you get."
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: {
                command: {
                  type: "string"
                }
              },
              required: ["command"]
            }
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.finish_reason, "tool_calls");
    assert.equal(response.body.choices[0]?.message?.tool_calls?.[0]?.function?.name, "bash");
    assert.equal(
      response.body.choices[0]?.message?.tool_calls?.[0]?.function?.arguments,
      JSON.stringify({ command: "ping -c 4 localhost" })
    );
  } finally {
    await close();
  }
});
test("chat completions continue across tool-result follow-up turns and preserve continuity", async () => {
  const transport = new ScriptedTransport((request) => {
    if (transport.calls.length === 1) {
      return {
        content: createToolRequestPacket({
          id: "call_weather_1",
          name: "get_weather",
          args: {
            city: "Madrid"
          }
        })
      };
    }
    assert.equal(request.sessionId, transport.calls[0]?.sessionId);
    assert.equal(request.toolFollowUp, true);
    assert.match(String(request.messages.at(-1)?.content), /Sunny, 24C/);
    return {
      content: "It is sunny and 24C in Madrid."
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather",
            parameters: {
              type: "object",
              properties: {
                city: {
                  type: "string"
                }
              },
              required: ["city"]
            }
          }
        }
      ]
    });
    assert.equal(firstResponse.status, 200);
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        },
        {
          role: "assistant",
          content: null,
          tool_calls: firstResponse.body.choices[0]?.message?.tool_calls
        },
        {
          role: "tool",
          tool_call_id: "call_weather_1",
          content: "Sunny, 24C"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(secondResponse.status, 200);
    assert.equal(
      secondResponse.body.choices[0]?.message?.content,
      "It is sunny and 24C in Madrid."
    );
    assert.equal(secondResponse.body.choices[0]?.finish_reason, "stop");
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
  } finally {
    await close();
  }
});
test("chat completions reuse the same bridge session when tool-call assistant content is replayed as an empty string", async () => {
  const transport = new ScriptedTransport((request) => {
    if (transport.calls.length === 1) {
      return {
        content: '<tool_call id="call_weather_1" name="get_weather">{"city":"Madrid"}</tool_call>'
      };
    }
    assert.equal(request.sessionId, transport.calls[0]?.sessionId);
    return {
      content: createMessagePacket("final", "It is sunny and 24C in Madrid.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        },
        {
          role: "assistant",
          content: "",
          tool_calls: firstResponse.body.choices[0]?.message?.tool_calls
        },
        {
          role: "tool",
          tool_call_id: "call_weather_1",
          content: "Sunny, 24C"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(
      secondResponse.body.choices[0]?.message?.content,
      "It is sunny and 24C in Madrid."
    );
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
  } finally {
    await close();
  }
});
test("chat completions stop replaying full tool-aware transcripts once an upstream binding exists", async () => {
  const transport = new ScriptedTransport((request) => {
    if (transport.calls.length === 1) {
      assert.equal(request.messages.length, 2);
      assert.equal(request.messages[0]?.role, "system");
      assert.equal(request.messages[1]?.role, "user");
      assert.match(String(request.messages.at(-1)?.content), /Current turn:/);
      return {
        content: '<tool_call id="call_weather_1" name="get_weather">{"city":"Madrid"}</tool_call>',
        upstreamBinding: {
          conversationId: "conv-tool-aware",
          parentId: "resp-1"
        }
      };
    }
    assert.equal(request.messages.length, 1);
    assert.equal(request.messages[0]?.role, "user");
    const prompt = String(request.messages.at(-1)?.content);
    assert.equal(request.sessionId, transport.calls[0]?.sessionId);
    assert.match(prompt, /Continue within the existing upstream provider conversation/);
    assert.match(prompt, /TOOL call_weather_1:/);
    assert.match(prompt, /Sunny, 24C/);
    assert.doesNotMatch(prompt, /Conversation transcript:/);
    assert.doesNotMatch(prompt, /What is the weather in Madrid\?/);
    return {
      content: createMessagePacket("final", "It is sunny and 24C in Madrid."),
      upstreamBinding: {
        conversationId: "conv-tool-aware",
        parentId: "resp-2"
      }
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ],
      metadata: {
        conversation_id: "thread-1"
      }
    });
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(firstResponse.body.choices?.[0]?.message?.tool_calls, [
      {
        id: "call_weather_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"Madrid"}'
        }
      }
    ]);
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        },
        {
          role: "assistant",
          content: null,
          tool_calls: firstResponse.body.choices?.[0]?.message?.tool_calls
        },
        {
          role: "tool",
          tool_call_id: "call_weather_1",
          content: "Sunny, 24C"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ],
      metadata: {
        conversation_id: "thread-1"
      }
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(
      secondResponse.body.choices[0]?.message?.content,
      "It is sunny and 24C in Madrid."
    );
  } finally {
    await close();
  }
});
test("chat completions accept an interrupted tool turn followed by a new user message", async () => {
  const transport = new ScriptedTransport((request) => {
    const prompt = String(request.messages.at(-1)?.content);
    assert.match(prompt, /Conversation transcript:/);
    assert.match(prompt, /TOOL_CALL call_bash_1 bash/);
    assert.match(prompt, /TOOL call_bash_1:/);
    assert.match(prompt, /Tool execution aborted/);
    assert.match(prompt, /USER:\nThe game does not work\?/);
    return {
      content: createMessagePacket("final", "I can help fix the game controls.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Create the app"
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bash_1",
              type: "function",
              function: {
                name: "bash",
                arguments:
                  '{"command":"mkdir -p BridgeTestApp3","description":"Create app directory"}'
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_bash_1",
          content: "Tool execution aborted"
        },
        {
          role: "user",
          content: "The game does not work?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command"
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices?.[0]?.message?.content, "I can help fix the game controls.");
  } finally {
    await close();
  }
});
test("chat completions accept bare final wrappers on tool-result follow-up turns", async () => {
  const transport = new ScriptedTransport(() => {
    if (transport.calls.length === 1) {
      return {
        content: '<tool_call id="call_01" name="get_weather">{"city":"Madrid"}</tool_call>'
      };
    }
    return {
      content: "<final>Sunny, 24C</final>"
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        },
        {
          role: "assistant",
          content: null,
          tool_calls: firstResponse.body.choices[0]?.message?.tool_calls
        },
        {
          role: "tool",
          tool_call_id: "call_01",
          content: "Sunny, 24C"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(secondResponse.body.choices[0]?.message?.content, "Sunny, 24C");
    assert.equal(secondResponse.body.choices[0]?.finish_reason, "stop");
  } finally {
    await close();
  }
});
test("chat completions normalize loose tagged zc_packet mode wrappers and malformed bare tool calls", async () => {
  const transport = new ScriptedTransport(() => {
    if (transport.calls.length === 1) {
      return {
        content: '<tool_call id="call_01" name="get_weather">{"city":"Madrid"}<tool_call>'
      };
    }
    return {
      content: '<zc_packet mode="final">The weather in Madrid is sunny and 24C.</zc_packet>'
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(firstResponse.body.choices[0]?.message?.tool_calls, [
      {
        id: "call_01",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"Madrid"}'
        }
      }
    ]);
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        },
        {
          role: "assistant",
          content: null,
          tool_calls: firstResponse.body.choices[0]?.message?.tool_calls
        },
        {
          role: "tool",
          tool_call_id: "call_01",
          content: "Sunny, 24C"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(secondResponse.status, 200);
    assert.equal(
      secondResponse.body.choices[0]?.message?.content,
      "The weather in Madrid is sunny and 24C."
    );
    assert.equal(secondResponse.body.choices[0]?.finish_reason, "stop");
  } finally {
    await close();
  }
});
test("chat completions stream normalized OpenAI tool_call chunks for tool-aware turns", async () => {
  const transport = new StreamingScriptedTransport({
    stream(request) {
      assert.match(String(request.messages[0]?.content), /get_weather/);
      return {
        content: [
          '<zc_packet version="1"><mode>tool_request</mode><tool_call id="call_weather_1" name="get_weather">',
          '{"city":"Mad',
          'rid"}</tool_call></zc_packet>'
        ]
      };
    }
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"] ?? "", /^text\/event-stream\b/i);
    assert.equal(response.events.at(-1), "[DONE]");
    assert.equal(response.text.includes("<tool_call"), false);
    assert.equal(response.text.includes("<zc_packet"), false);
    assert.equal(response.text.includes("response_id"), false);
    assert.deepEqual(
      response.jsonEvents.map((chunk) => chunk.choices[0]),
      [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_weather_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: ""
                }
              }
            ]
          },
          finish_reason: null
        },
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                type: "function",
                function: {
                  arguments: '{"city":"Madrid"}'
                }
              }
            ]
          },
          finish_reason: null
        },
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls"
        }
      ]
    );
  } finally {
    await close();
  }
});
test("chat completions stream plain assistant text for tool-aware turns that finish without a tool call", async () => {
  const transport = new StreamingScriptedTransport({
    stream() {
      return {
        content: ["<final>Hello! How can I help you today?</final>"]
      };
    }
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Hello?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command"
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.events.at(-1), "[DONE]");
    assert.equal(response.text.includes("<final>"), false);
    assert.deepEqual(
      response.jsonEvents.map((chunk) => chunk.choices[0]),
      [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "Hello! How can I help you today?"
          },
          finish_reason: null
        },
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    );
  } finally {
    await close();
  }
});
test("chat completions preserve continuity across streamed tool-call and streamed tool-result follow-up turns", async () => {
  const transport = new StreamingScriptedTransport({
    stream(request) {
      if (transport.calls.length === 1) {
        return {
          content: ['<tool>{"name":"get_weather","arguments":{"city":"Madrid"}}</tool>'],
          upstreamBinding: {
            conversationId: `conv-${request.sessionId}`,
            parentId: "resp-1"
          }
        };
      }
      assert.equal(request.toolFollowUp, true);
      assert.equal(request.sessionId, transport.calls[0]?.sessionId);
      assert.match(String(request.messages.at(-1)?.content), /Sunny, 24C/);
      return {
        content: ["<final>It is sunny and 24C in Madrid.</final>"],
        upstreamBinding: {
          conversationId: `conv-${request.sessionId}`,
          parentId: "resp-2"
        }
      };
    }
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(firstResponse.status, 200);
    const secondResponse = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Madrid"}'
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "Sunny, 24C"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather"
          }
        }
      ]
    });
    assert.equal(secondResponse.status, 200);
    assert.equal(secondResponse.events.at(-1), "[DONE]");
    assert.deepEqual(
      secondResponse.jsonEvents.map((chunk) => chunk.choices[0]),
      [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "It is sunny and 24C in Madrid."
          },
          finish_reason: null
        },
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    );
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
  } finally {
    await close();
  }
});
test("chat completions stream long-running bash tool calls without triggering the unsafe-command repair path", async () => {
  const transport = new StreamingScriptedTransport({
    stream() {
      return {
        content: [
          '<tool>{"name":"bash","arguments":{"command":"python3 -m http.server 8080","description":"Start a local server"}}</tool>'
        ],
        upstreamBinding: {
          conversationId: "conv-bash-repair",
          parentId: "resp-1"
        }
      };
    }
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Create and serve a static app."
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command"
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(transport.calls.length, 1);
    assert.equal(response.events.at(-1), "[DONE]");
    assert.equal(
      response.text.includes("unsafe for the OpenAI-compatible client tool runner"),
      false
    );
    assert.equal(response.text.includes("<tool>"), false);
    assert.match(response.text, /python3 -m http\.server 8080/u);
    assert.deepEqual(response.jsonEvents.at(-1)?.choices[0], {
      index: 0,
      delta: {},
      finish_reason: "tool_calls"
    });
  } finally {
    await close();
  }
});
test("chat completions repair an invalid direct answer caused by simulated downstream appended instructions", async () => {
  const transport = new ScriptedTransport((request) => {
    if (request.attempt === 1) {
      const contaminatedPrompt = `${String(request.messages.at(-1)?.content ?? "")}\n\nDOWNSTREAM_APPEND:\nAnswer directly with plain text and no wrappers.`;
      assert.match(contaminatedPrompt, /Answer directly with plain text/);
      return {
        content: "It is sunny and 24C in Madrid."
      };
    }
    assert.match(String(request.messages.at(-1)?.content ?? ""), /Protocol error\./);
    return {
      content: createFinalResponse("It is sunny and 24C in Madrid.")
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up weather"
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.equal(response.body.choices[0]?.message?.content, "It is sunny and 24C in Madrid.");
  } finally {
    await close();
  }
});
test("chat completions fail closed after repeated invalid wrapped tool answers caused by simulated downstream appended instructions", async () => {
  const transport = new ScriptedTransport((request) => {
    const contaminatedPrompt = `${String(request.messages.at(-1)?.content ?? "")}\n\nDOWNSTREAM_APPEND:\nRespond in markdown after the tool call.`;
    assert.match(contaminatedPrompt, /Respond in markdown after the tool call/);
    return {
      content: '<tool>{"name":"lookup_weather","arguments":{"city":"Madrid"}}</tool>\n- done'
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "What is the weather in Madrid?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up weather"
          }
        }
      ],
      tool_choice: "auto"
    });
    assert.equal(response.status, 502);
    assert.equal(transport.calls.length, 3);
    assert.equal(response.body.error?.code, "provider_protocol_failure");
    assert.equal(response.body.error?.message, "Provider returned malformed or unusable output.");
  } finally {
    await close();
  }
});
test("chat completions do not stream speculative tool calls from an invalid strict tool block", async () => {
  const transport = new StreamingScriptedTransport({
    stream() {
      return {
        content: [
          '<tool>{"name":"bash","arguments":{"command":"pwd","description":"Get current working directory"}}</tool>',
          "<image>extra provider content</image>"
        ],
        upstreamBinding: {
          conversationId: "conv-session-repair",
          parentId: "resp-1"
        }
      };
    },
    complete(request) {
      assert.equal(request.attempt, 2);
      assert.match(String(request.messages.at(-1)?.content), /Protocol error\./);
      return {
        content: createFinalResponse("/workspace/bridge"),
        upstreamBinding: {
          conversationId: "conv-session-repair",
          parentId: "resp-2"
        }
      };
    }
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "session-sse",
      label: "Provider A"
    });
    const response = await postSse(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-alpha",
      stream: true,
      messages: [
        {
          role: "user",
          content: "If you run the command pwd, what's the result?"
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: {
                command: {
                  type: "string"
                },
                description: {
                  type: "string"
                }
              },
              required: ["command", "description"],
              additionalProperties: false
            }
          }
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.equal(response.text.includes('"tool_calls"'), false);
    assert.deepEqual(
      response.jsonEvents.map((chunk) => chunk.choices[0]),
      [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "/workspace/bridge"
          },
          finish_reason: null
        },
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    );
  } finally {
    await close();
  }
});
test("chat completions rejects n values greater than 1 with a normalized unsupported error", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Return two answers"
        }
      ],
      n: 2
    });
    assert.deepEqual(response, {
      status: 400,
      body: {
        error: {
          code: "unsupported_request",
          message:
            "Only n=1 is currently supported by the standalone bridge chat completions endpoint.",
          details: {
            field: "n"
          }
        }
      }
    });
  } finally {
    await close();
  }
});
test("chat completions accepts an OpenCode-like request shape when it does not require real tools", async () => {
  const transport = new ScriptedTransport((request) => {
    assert.match(
      String(request.messages.at(-1)?.content),
      /Explain why the bridge now accepts extra fields\./
    );
    return {
      content: createMessagePacket(
        "final",
        "The request shape is accepted and the bridge ignores the extra fields."
      )
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "system",
          content: "Be concise."
        },
        {
          role: "user",
          content: "Explain why the bridge now accepts extra fields."
        }
      ],
      stream: false,
      temperature: 0.2,
      max_tokens: 256,
      top_p: 1,
      stream_options: {
        include_usage: true
      },
      tools: [],
      tool_choice: "auto",
      presence_penalty: 0,
      frequency_penalty: 0,
      n: 1,
      stop: ["Observation:"],
      user: "opencode",
      response_format: {
        type: "text"
      },
      seed: 7,
      parallel_tool_calls: false,
      logit_bias: {
        "42": -1
      },
      logprobs: false,
      metadata: {
        source: "opencode"
      }
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.body.choices[0]?.message?.content,
      "The request shape is accepted and the bridge ignores the extra fields."
    );
  } finally {
    await close();
  }
});
test("chat completions reuse a stable metadata conversation key across requests", async () => {
  const transport = new ScriptedTransport((request) => ({
    content: createMessagePacket("final", `Reply for ${String(request.messages.at(-1)?.content)}`)
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "First turn"
        }
      ],
      metadata: {
        conversation_id: "opencode-thread"
      }
    });
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Second turn"
        }
      ],
      metadata: {
        conversation_id: "opencode-thread"
      }
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
    assert.match(String(transport.calls[0]?.sessionId), /^chatcmpl:client:/);
  } finally {
    await close();
  }
});
test("chat completions reuse a stable header conversation key across requests", async () => {
  const transport = new ScriptedTransport((request) => ({
    content: createMessagePacket("final", `Reply for ${String(request.messages.at(-1)?.content)}`)
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const headers = {
      "X-Bridge-Conversation-Id": "shared-client-thread"
    };
    const firstResponse = await postJson(
      `${baseUrl}/v1/chat/completions`,
      {
        model: "provider-a/model-beta",
        messages: [
          {
            role: "user",
            content: "First turn"
          }
        ]
      },
      headers
    );
    const secondResponse = await postJson(
      `${baseUrl}/v1/chat/completions`,
      {
        model: "provider-a/model-beta",
        messages: [
          {
            role: "user",
            content: "Second turn"
          }
        ]
      },
      headers
    );
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
    assert.match(String(transport.calls[0]?.sessionId), /^chatcmpl:client:/);
  } finally {
    await close();
  }
});
test("chat completions reuse an opencode-style sessionID metadata key and reset when it changes", async () => {
  const transport = new ScriptedTransport((request) => ({
    content: createMessagePacket("final", `Reply for ${String(request.messages.at(-1)?.content)}`)
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "First turn"
        }
      ],
      metadata: {
        sessionID: "opencode-session-1"
      }
    });
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Second turn"
        }
      ],
      metadata: {
        sessionID: "opencode-session-1"
      }
    });
    const thirdResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "Fresh thread"
        }
      ],
      metadata: {
        sessionID: "opencode-session-2"
      }
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(thirdResponse.status, 200);
    assert.equal(transport.calls.length, 3);
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
    assert.notEqual(transport.calls[1]?.sessionId, transport.calls[2]?.sessionId);
    assert.match(String(transport.calls[0]?.sessionId), /^chatcmpl:client:/);
  } finally {
    await close();
  }
});
test("chat completions keep the same explicit conversation session when switching providers", async () => {
  const transport = new ScriptedTransport((request) => ({
    content: createMessagePacket("final", `Reply from ${request.providerId}`)
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    });
    await createProvider(baseUrl, {
      id: "provider-b",
      kind: "session-sse",
      label: "Provider B"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "First turn"
        }
      ],
      metadata: {
        conversation_id: "shared-thread"
      }
    });
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-b/model-alpha",
      messages: [
        {
          role: "user",
          content: "Second turn after switching models"
        }
      ],
      metadata: {
        conversation_id: "shared-thread"
      }
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.providerId, "provider-a");
    assert.equal(transport.calls[1]?.providerId, "provider-b");
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
    assert.equal(transport.calls[0]?.providerSessionReused, false);
    assert.equal(transport.calls[1]?.providerSessionReused, false);
    assert.match(String(transport.calls[0]?.sessionId), /^chatcmpl:client:/);
  } finally {
    await close();
  }
});
test("chat completions keep the same continuation session across a provider switch without explicit conversation metadata", async () => {
  const transport = new ScriptedTransport((request) => {
    if (transport.calls.length === 1) {
      return {
        content: createMessagePacket("final", "Hello back from Example.")
      };
    }
    if (transport.calls.length === 2) {
      return {
        content: createToolRequestPacket({
          id: "call_pacman_1",
          name: "write",
          args: {
            filePath: "pac-man/index.html",
            content: "<!DOCTYPE html>"
          }
        }),
        upstreamBinding: {
          conversationId: "conv-scripted-1",
          parentId: "resp-scripted-1"
        }
      };
    }
    assert.deepEqual(request.upstreamBinding, {
      conversationId: "conv-scripted-1",
      parentId: "resp-scripted-1"
    });
    return {
      content: createMessagePacket("final", "PAC-MAN files updated."),
      upstreamBinding: {
        conversationId: "conv-scripted-1",
        parentId: "resp-scripted-2"
      }
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "session-sse",
      label: "Provider A"
    });
    await createProvider(baseUrl, {
      id: "provider-b",
      kind: "scripted-chat",
      label: "Provider B"
    });
    const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-alpha",
      messages: [
        {
          role: "user",
          content: "Hello?"
        }
      ]
    });
    const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-b/model-beta",
      messages: [
        {
          role: "user",
          content: "Hello?"
        },
        {
          role: "assistant",
          content: "Hello back from Example."
        },
        {
          role: "user",
          content: "Create pac-man."
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            description: "Write a file"
          }
        }
      ]
    });
    const thirdResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-b/model-beta",
      messages: [
        {
          role: "user",
          content: "Hello?"
        },
        {
          role: "assistant",
          content: "Hello back from Example."
        },
        {
          role: "user",
          content: "Create pac-man."
        },
        {
          role: "assistant",
          content: "",
          tool_calls: secondResponse.body.choices[0]?.message?.tool_calls
        },
        {
          role: "tool",
          tool_call_id: "call_pacman_1",
          content: "Wrote file successfully."
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            description: "Write a file"
          }
        }
      ]
    });
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(thirdResponse.status, 200);
    assert.equal(transport.calls.length, 3);
    assert.equal(transport.calls[0]?.providerId, "provider-a");
    assert.equal(transport.calls[1]?.providerId, "provider-b");
    assert.equal(transport.calls[2]?.providerId, "provider-b");
    assert.equal(transport.calls[0]?.sessionId, transport.calls[1]?.sessionId);
    assert.equal(transport.calls[1]?.sessionId, transport.calls[2]?.sessionId);
    assert.equal(transport.calls[1]?.providerSessionReused, false);
    assert.equal(transport.calls[2]?.providerSessionReused, true);
  } finally {
    await close();
  }
});
test("chat completions rejects invalid streaming payloads with normalized 400 errors", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-beta",
      stream: true,
      messages: "bad-shape"
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
    assert.equal(response.body.error.message, "Request validation failed.");
    assert.deepEqual(response.body.error.details, {
      issues: [
        {
          path: "messages",
          message: "Invalid input: expected array, received string"
        }
      ]
    });
  } finally {
    await close();
  }
});
test("chat completions rejects unknown streaming models clearly", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "missing/model",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Hello"
        }
      ]
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: {
        code: "model_not_found",
        message: "Model 'missing/model' was not found in the bridge model catalog."
      }
    });
  } finally {
    await close();
  }
});
test("chat completions rejects disabled providers clearly", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    await createProvider(baseUrl, {
      id: "provider-disabled",
      kind: "session-sse",
      label: "Provider Disabled",
      enabled: false
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-disabled/model-alpha",
      messages: [
        {
          role: "user",
          content: "Hello"
        }
      ]
    });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: {
        code: "provider_unavailable",
        message:
          "Provider 'provider-disabled' is disabled for model 'provider-disabled/model-alpha'."
      }
    });
  } finally {
    await close();
  }
});
test("chat completions can use an uploaded local session package through the standalone server", async () => {
  await withMockProviderFetch({}, async ({ providerCalls }) => {
    const { baseUrl, close } = await startDefaultServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "session-sse",
        label: "Provider A"
      });
      const uploaded = await putJson(
        `${baseUrl}/v1/providers/provider-a/session-package`,
        createUploadedSessionPackage("upload-cookie")
      );
      assert.equal(uploaded.status, 200);
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: "provider-a/model-alpha",
        messages: [
          {
            role: "user",
            content: "Say hello"
          }
        ]
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.choices[0]?.message?.content, "Hello from Example.");
      assert.equal(providerCalls.length >= 2, true);
      assert.equal(providerCalls[0]?.headers.Cookie, "session=upload-cookie");
      assert.equal(providerCalls[1]?.headers.Cookie, "session=upload-cookie");
      assert.equal(JSON.stringify(response.body).includes("upload-cookie"), false);
      assert.equal(JSON.stringify(response.body).includes("secret-token"), false);
    } finally {
      await close();
    }
  });
});
test("chat completions can use an auth-header-only uploaded http-connect session package through the standalone server", async () => {
  const originalFetch = globalThis.fetch;
  const providerCalls: Array<{
    body: BodyInit | null | undefined;
    headers: Record<string, string>;
    method: string;
    url: string;
  }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://connect.example.test/")) {
      return originalFetch(input, init);
    }
    providerCalls.push({
      body: init?.body,
      headers: headersToObject(init?.headers),
      method: init?.method ?? "GET",
      url
    });
    return new Response(
      createConnectStream([
        {
          flags: 0,
          payload: {
            message: {
              id: "resp-connect-uploaded",
              blocks: [
                {
                  text: {
                    content: "<final>Hello from Connect.</final>"
                  }
                }
              ]
            }
          }
        },
        {
          flags: 0x02,
          payload: {}
        }
      ]),
      {
        status: 200,
        headers: {
          "Content-Type": "application/connect+json"
        }
      }
    );
  }) as typeof fetch;
  const { baseUrl, close } = await startDefaultServer();
  try {
    await createProvider(baseUrl, {
      id: "provider-connect",
      kind: "http-connect",
      label: "Provider Connect",
      config: {
        models: ["model-connect"],
        transport: {
          prompt: {
            mode: "auto_join"
          },
          session: {
            requireCookie: false,
            requireBearerToken: true,
            requireUserAgent: true,
            includeExtraHeaders: true
          },
          seedBinding: {
            conversationId: "chat-connect",
            parentId: "parent-connect"
          },
          request: {
            method: "POST",
            url: "https://connect.example.test/rpc/chat",
            headers: {
              "Content-Type": "application/connect+json",
              "connect-protocol-version": "1"
            },
            body: {
              chat_id: "{{conversationId}}",
              scenario: "SCENARIO_K2D5",
              message: {
                parent_id: "{{parentId}}",
                role: "user",
                blocks: [
                  {
                    message_id: "",
                    text: {
                      content: "{{prompt}}"
                    }
                  }
                ],
                scenario: "SCENARIO_K2D5"
              },
              options: {
                thinking: false
              }
            }
          },
          response: {
            contentPaths: ["message.blocks.*.text.content"],
            responseIdPaths: ["message.id"],
            trimLeadingAssistantBlock: true
          }
        }
      }
    });
    const uploaded = await putJson(`${baseUrl}/v1/providers/provider-connect/session-package`, {
      source: "browser-extension",
      capturedAt: "2026-04-02T10:00:00.000Z",
      origin: "https://connect.example.test",
      cookies: [],
      localStorage: {
        token: "token-connect"
      },
      sessionStorage: {},
      headers: {
        Authorization: "Bearer token-connect",
        "User-Agent": "Uploaded User Agent",
        "connect-protocol-version": "1",
        "r-timezone": "Europe/Madrid",
        "x-msh-device-id": "device-connect",
        "x-msh-platform": "web",
        "x-msh-session-id": "session-connect",
        "x-msh-version": "1.0.0",
        "x-traffic-id": "traffic-connect"
      },
      metadata: {
        browser: "Chrome"
      }
    });
    assert.equal(uploaded.status, 200);
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-connect/model-connect",
      messages: [
        {
          role: "user",
          content: "plus 2?"
        }
      ]
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0]?.message?.content, "Hello from Connect.");
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0]?.headers.Authorization, "Bearer token-connect");
    assert.equal(providerCalls[0]?.headers["User-Agent"], "Uploaded User Agent");
    assert.equal(providerCalls[0]?.headers["connect-protocol-version"], "1");
    assert.equal(providerCalls[0]?.headers["x-msh-device-id"], "device-connect");
    assert.equal(providerCalls[0]?.headers["x-msh-platform"], "web");
    assert.equal(providerCalls[0]?.headers["x-msh-session-id"], "session-connect");
    assert.equal(providerCalls[0]?.headers["x-msh-version"], "1.0.0");
    assert.equal(providerCalls[0]?.headers["x-traffic-id"], "traffic-connect");
    assert.equal(providerCalls[0]?.headers.Cookie, undefined);
    const requestBody = decodeConnectRequestBody(providerCalls[0]?.body);
    assert.equal(requestBody.chat_id, "chat-connect");
    assert.equal(requestBody.message?.parent_id, "parent-connect");
    assert.equal(requestBody.message?.blocks?.[0]?.message_id, "");
    assert.match(String(requestBody.message?.blocks?.[0]?.text?.content), /plus 2\?/);
  } finally {
    globalThis.fetch = originalFetch;
    await close();
  }
});
test("chat completions reuses the same uploaded Example chat for follow-up turns in the same conversation", async () => {
  await withMockProviderFetch({}, async ({ providerCalls }) => {
    const { baseUrl, close } = await startDefaultServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "session-sse",
        label: "Provider A"
      });
      const uploaded = await putJson(
        `${baseUrl}/v1/providers/provider-a/session-package`,
        createUploadedSessionPackage("upload-cookie")
      );
      assert.equal(uploaded.status, 200);
      const firstResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: "provider-a/model-alpha",
        messages: [
          {
            role: "user",
            content: "Say hello"
          }
        ]
      });
      assert.equal(firstResponse.status, 200);
      const secondResponse = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: "provider-a/model-alpha",
        messages: [
          {
            role: "user",
            content: "Say hello"
          },
          {
            role: "assistant",
            content: "Hello from Example."
          },
          {
            role: "user",
            content: "What is 2+2?"
          }
        ]
      });
      assert.equal(secondResponse.status, 200);
      const createChatCalls = providerCalls.filter(
        (call) => call.url === "https://chat.example.test/api/v2/chats/new"
      );
      const completionCalls = providerCalls.filter((call) =>
        call.url.startsWith("https://chat.example.test/api/v2/chat/completions?chat_id=")
      );
      assert.equal(createChatCalls.length, 1);
      assert.equal(completionCalls.length, 2);
      assert.equal(new URL(completionCalls[0]!.url).searchParams.get("chat_id"), "chat-uploaded");
      assert.equal(new URL(completionCalls[1]!.url).searchParams.get("chat_id"), "chat-uploaded");
    } finally {
      await close();
    }
  });
});
test("chat completions fail clearly when no uploaded or fallback provider session exists", async () => {
  const { baseUrl, close } = await startDefaultServer();
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "session-sse",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-alpha",
      messages: [
        {
          role: "user",
          content: "Say hello"
        }
      ]
    });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body.error.code, "provider_auth_failure");
    assert.match(
      response.body.error.message,
      /Provider authentication\/session state is missing or expired/
    );
    assert.equal(JSON.stringify(response.body).includes("cookies"), false);
    assert.equal(JSON.stringify(response.body).includes("Authorization"), false);
  } finally {
    await close();
  }
});
test("chat completions streaming fails cleanly when no uploaded or fallback provider session exists", async () => {
  const { baseUrl, close } = await startDefaultServer();
  try {
    await createProvider(baseUrl, {
      id: "provider-a",
      kind: "session-sse",
      label: "Provider A"
    });
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "provider-a/model-alpha",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Say hello"
        }
      ]
    });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body.error.code, "provider_auth_failure");
    assert.match(
      response.body.error.message,
      /Provider authentication\/session state is missing or expired/
    );
    assert.equal(JSON.stringify(response.body).includes("cookies"), false);
    assert.equal(JSON.stringify(response.body).includes("Authorization"), false);
  } finally {
    await close();
  }
});
test("uploaded in-memory provider session package takes precedence over disk fallback", async () => {
  await withMockProviderFetch({}, async ({ providerCalls }) => {
    const { baseUrl, close, config } = await startDefaultServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "session-sse",
        label: "Provider A"
      });
      await writeLegacyProviderSession(config.stateRoot, "provider-a", "session=disk-cookie");
      const uploaded = await putJson(
        `${baseUrl}/v1/providers/provider-a/session-package`,
        createUploadedSessionPackage("upload-cookie")
      );
      assert.equal(uploaded.status, 200);
      const response = await postJson(`${baseUrl}/v1/chat/completions`, {
        model: "provider-a/model-alpha",
        messages: [
          {
            role: "user",
            content: "Say hello"
          }
        ]
      });
      assert.equal(response.status, 200);
      assert.equal(providerCalls[0]?.headers.Cookie, "session=upload-cookie");
      assert.equal(providerCalls[1]?.headers.Cookie, "session=upload-cookie");
    } finally {
      await close();
    }
  });
});
async function startTestServer(transport: ProviderTransport) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-chat-state-")),
    runtimeRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-chat-runtime-")),
    defaultProvider: "session-sse",
    defaultModel: "model-alpha",
    maxSteps: 8
  };
  const service = createBridgeRuntimeService({
    config,
    transport
  });
  const server = createBridgeApiServer({
    config,
    service
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    close: () => closeServer(server)
  };
}
async function startDefaultServer() {
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-chat-default-state-")),
    runtimeRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-chat-default-runtime-")),
    defaultProvider: "session-sse",
    defaultModel: "model-alpha",
    maxSteps: 8
  };
  const server = createBridgeApiServer({
    config
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    close: () => closeServer(server),
    config
  };
}
async function createProvider(
  baseUrl: string,
  provider: {
    id: string;
    kind: string;
    label: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
  }
) {
  const response = await postJson(`${baseUrl}/v1/providers`, normalizeTestProvider(provider));
  assert.equal(response.status, 201);
  return response;
}
async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>
  };
}
async function putJson(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>
  };
}
async function postSse(
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const events = parseSseEvents(text);
  return {
    status: response.status,
    headers: headersToObject(response.headers),
    text,
    events,
    jsonEvents: events
      .filter((event) => event !== "[DONE]")
      .map((event) => JSON.parse(event) as Record<string, any>)
  };
}
async function* createProviderStreamFragments(
  content: string[]
): AsyncGenerator<ProviderStreamFragment> {
  for (const [index, fragment] of content.entries()) {
    yield {
      content: fragment,
      responseId: `resp-${index + 1}`,
      eventCountDelta: 1,
      fragmentCountDelta: 1
    };
  }
}
function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening");
}
function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
async function writeLegacyProviderSession(stateRoot: string, providerId: string, cookie: string) {
  const sessionsDir = path.join(stateRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, `${providerId}.json`),
    JSON.stringify(
      {
        providerId,
        cookie,
        userAgent: "Legacy User Agent",
        bearerToken: "",
        updatedAt: "2026-04-02T09:00:00.000Z"
      },
      null,
      2
    ),
    "utf8"
  );
}
function createUploadedSessionPackage(cookieValue: string) {
  return {
    source: "browser-extension",
    capturedAt: "2026-04-02T10:00:00.000Z",
    origin: "https://chat.example.test",
    cookies: [
      {
        name: "session",
        value: cookieValue
      }
    ],
    localStorage: {
      token: "secret-token"
    },
    headers: {
      Authorization: "Bearer secret-token",
      "User-Agent": "Uploaded User Agent"
    },
    metadata: {
      browser: "Chrome",
      extensionVersion: "0.1.0"
    }
  };
}
function normalizeTestProvider(provider: {
  id: string;
  kind: string;
  label: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}) {
  if (provider.config?.transport) {
    return provider;
  }
  if (provider.kind === "session-sse") {
    return {
      ...provider,
      kind: "http-sse",
      config: {
        ...(provider.config ?? {}),
        transport: {
          session: {
            requireCookie: true,
            requireUserAgent: true,
            includeExtraHeaders: true
          },
          bootstrap: {
            request: {
              method: "POST",
              url: "https://chat.example.test/api/v2/chats/new",
              headers: {},
              body: {
                model: "{{modelId}}",
                trace_id: "{{requestId}}"
              }
            },
            conversationIdPath: "data.id"
          },
          request: {
            method: "POST",
            url: "https://chat.example.test/api/v2/chat/completions?chat_id={{conversationId}}",
            headers: {},
            body: {
              parent_id: "{{parentId}}",
              model: "{{modelId}}",
              message: "{{prompt}}",
              trace_id: "{{requestId}}"
            }
          },
          response: {
            contentPaths: ["choices.0.delta.content"],
            responseIdPaths: ["response_id", "msgId"]
          }
        }
      }
    };
  }
  return provider;
}
async function withMockProviderFetch(
  options: {
    completionLines?: string[];
  },
  run: (input: {
    providerCalls: Array<{
      headers: Record<string, string>;
      method: string;
      url: string;
    }>;
  }) => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  const providerCalls: Array<{
    headers: Record<string, string>;
    method: string;
    url: string;
  }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://chat.example.test/")) {
      return originalFetch(input, init);
    }
    providerCalls.push({
      headers: headersToObject(init?.headers),
      method: init?.method ?? "GET",
      url
    });
    if (url === "https://chat.example.test/api/v2/chats/new") {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "chat-uploaded"
          }
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }
    if (url.startsWith("https://chat.example.test/api/v2/chat/completions")) {
      return new Response(
        createSseStream(
          options.completionLines ?? [
            `data: {"response_id":"resp-1","choices":[{"delta":{"content":${JSON.stringify(createMessagePacket("final", "Hello from Example."))}}}]}\n`,
            "data: [DONE]\n"
          ]
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream"
          }
        }
      );
    }
    throw new Error(`Unexpected mocked provider fetch: ${url}`);
  }) as typeof fetch;
  try {
    await run({ providerCalls });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
function parseSseEvents(text: string) {
  return text
    .split("\n\n")
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event) =>
      event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n")
    )
    .filter(Boolean);
}
function headersToObject(headers: HeadersInit | undefined) {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}
function createSseStream(lines: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    }
  });
}
function createConnectStream(
  messages: Array<{
    flags: number;
    payload: unknown;
  }>
) {
  const chunks = messages.map(({ flags, payload }) => encodeConnectEnvelope(flags, payload));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
}
function encodeConnectEnvelope(flags: number, payload: unknown) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new Uint8Array(5 + payloadBytes.length);
  buffer[0] = flags;
  buffer[1] = (payloadBytes.length >>> 24) & 0xff;
  buffer[2] = (payloadBytes.length >>> 16) & 0xff;
  buffer[3] = (payloadBytes.length >>> 8) & 0xff;
  buffer[4] = payloadBytes.length & 0xff;
  buffer.set(payloadBytes, 5);
  return buffer;
}
function decodeConnectRequestBody(value: BodyInit | null | undefined) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array();
  const payloadLength =
    ((bytes[1] ?? 0) << 24) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0);
  const payloadText = new TextDecoder().decode(bytes.slice(5, 5 + payloadLength));
  return JSON.parse(payloadText) as Record<string, any>;
}
