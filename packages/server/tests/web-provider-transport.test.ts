import assert from "node:assert/strict";
import test from "node:test";

import { webProviderTransportModule } from "../src/bridge/providers/web-provider-transport.ts";

const { WebProviderTransport } = webProviderTransportModule;
test("generic http-sse transport preserves bridge tool-aware prompt text without adding nested wrappers", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-1"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-1") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-1"},"choices":[{"delta":{"content":"<zc_packet version=\\"1\\"><mode>final</mode><message><![CDATA[OK]]></message></zc_packet>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-1",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: null,
      messages: [
        {
          role: "system",
          content:
            "You are an OpenAI-compatible tool-calling adapter for the standalone bridge server."
        },
        {
          role: "user",
          content: [
            "Respond to the current user request below.",
            "Tool choice: auto.",
            "Current turn:",
            "USER:",
            "hello?"
          ].join("\n\n")
        }
      ]
    });
    assert.match(response.content, /OK/);
    const completionCall = calls.find(
      (call) => call.url === "https://example.test/messages?conversation_id=conversation-1"
    );
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.equal(
      requestBody.message,
      [
        "You are an OpenAI-compatible tool-calling adapter for the standalone bridge server.",
        [
          "Respond to the current user request below.",
          "Tool choice: auto.",
          "Current turn:",
          "USER:",
          "hello?"
        ].join("\n\n")
      ].join("\n\n")
    );
    assert.equal(requestBody.parent_id, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport trims trailing metadata after a valid tool block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-2"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-2") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"response":{"id":"resp-2"},"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"ping -c 4 localhost\\"}}</tool>"}}]}\n',
            'data: {"response":{"id":"resp-2"},"choices":[{"delta":{"content":"Title metadata"}}]}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-2",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "Ping localhost and tell me what you get."
        }
      ]
    });
    assert.equal(
      response.content,
      '<tool>{"name":"bash","arguments":{"command":"ping -c 4 localhost"}}</tool>'
    );
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-2",
      parentId: "resp-2"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport recovers the latest valid assistant block after reasoning noise", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-reasoning-noise"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-reasoning-noise") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"response":{"id":"resp-reasoning-noise"},"choices":[{"delta":{"content":"Thinking about the answer. "}}]}\n',
            'data: {"response":{"id":"resp-reasoning-noise"},"choices":[{"delta":{"content":"<final>4</final>"}}]}\n',
            'data: {"response":{"id":"resp-reasoning-noise"},"choices":[{"delta":{"content":"FINISHED"}}]}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-reasoning-noise",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "2*2?"
        }
      ]
    });
    assert.equal(response.content, "<final>4</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-reasoning-noise",
      parentId: "resp-reasoning-noise"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport ignores protocol text that mentions packet tags before the real final block", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-protocol-echo"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-protocol-echo") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"response":{"id":"resp-protocol-echo"},"choices":[{"delta":{"content":"Use <final> or <tool>. The user said \\"Hello?\\" - no tool needed. "}}]}\n',
            'data: {"response":{"id":"resp-protocol-echo"},"choices":[{"delta":{"content":"So use <final> with a concise greeting."}}]}\n',
            'data: {"response":{"id":"resp-protocol-echo"},"choices":[{"delta":{"content":"<final>Hello</final>"}}]}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-protocol-echo",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "Hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>Hello</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-protocol-echo",
      parentId: "resp-protocol-echo"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport recovers a trailing final block when an outer final wrapper is polluted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-polluted-final"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-polluted-final") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"response":{"id":"resp-polluted-final"},"choices":[{"delta":{"content":"<final>. Ensure no extra text, no markdown, no backticks. Just the block."}}]}\n',
            'data: {"response":{"id":"resp-polluted-final"},"choices":[{"delta":{"content":"final>Hello</final>"}}]}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-polluted-final",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "Hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>Hello</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-polluted-final",
      parentId: "resp-polluted-final"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport ignores DeepSeek THINK fragments and resolves inherited DeepSeek response fragment paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-deepseek"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-deepseek") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"response_message_id":"resp-deepseek"}\n',
            'data: {"response":{"fragments":[{"type":"THINK","content":"Reasoning: say hello."}]}}\n',
            'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"<"}]}\n',
            'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"final"}\n',
            'data: {"v":">"}\n',
            'data: {"v":"Hello"}\n',
            'data: {"v":"</"}\n',
            'data: {"v":"final"}\n',
            'data: {"v":">"}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              ...createSseProviderRecord().config.transport,
              response: {
                contentPaths: ["__bridge__.deepseek.response"],
                responseIdPaths: ["response_message_id"],
                trimLeadingAssistantBlock: true
              }
            }
          }
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "deepseek-chat",
      sessionId: "bridge-session",
      requestId: "request-deepseek",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "Hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>Hello</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-deepseek",
      parentId: "resp-deepseek"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can render a null parent id for the first bootstrapped turn", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-null-parent"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-null-parent") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-null-parent"},"choices":[{"delta":{"content":"<final>OK</final>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              ...createSseProviderRecord().config.transport,
              request: {
                method: "POST",
                url: "https://example.test/messages?conversation_id={{conversationId}}",
                headers: {},
                body: {
                  parent_id: "{{parentIdOrNull}}",
                  model: "{{modelId}}",
                  message: "{{prompt}}"
                }
              }
            }
          }
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-null-parent",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>OK</final>");
    const completionCall = calls.find(
      (call) =>
        call.url === "https://example.test/messages?conversation_id=conversation-null-parent"
    );
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.equal(requestBody.parent_id, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can bootstrap a fresh conversation when first turn binding is empty", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-empty-bootstrap"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-empty-bootstrap") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-empty-bootstrap"},"choices":[{"delta":{"content":"<final>OK</final>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              ...createSseProviderRecord().config.transport,
              binding: {
                firstTurn: "empty"
              }
            }
          }
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-empty-bootstrap",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>OK</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-empty-bootstrap",
      parentId: "resp-empty-bootstrap"
    });
    const bootstrapCall = calls.find((call) => call.url === "https://example.test/conversations");
    assert.ok(bootstrapCall);
    const completionCall = calls.find(
      (call) =>
        call.url === "https://example.test/messages?conversation_id=conversation-empty-bootstrap"
    );
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.equal(requestBody.parent_id, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can bind headers from a preflight response", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-preflight"
        }
      });
    }
    if (url === "https://example.test/request-preflight") {
      return jsonResponse({
        auth: {
          transient_header: "signed-value"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-preflight") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-preflight"},"choices":[{"delta":{"content":"<final>OK</final>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              ...createSseProviderRecord().config.transport,
              preflight: {
                request: {
                  method: "POST",
                  url: "https://example.test/request-preflight",
                  headers: {},
                  body: {
                    conversation_id: "{{conversationId}}"
                  }
                },
                headerBindings: {
                  "X-Transient-Auth": "auth.transient_header"
                }
              }
            }
          }
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-preflight",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>OK</final>");
    const preflightCall = calls.find(
      (call) => call.url === "https://example.test/request-preflight"
    );
    assert.ok(preflightCall);
    assert.equal(preflightCall.init.headers instanceof Headers, false);
    const completionCall = calls.find(
      (call) => call.url === "https://example.test/messages?conversation_id=conversation-preflight"
    );
    assert.ok(completionCall);
    assert.equal(
      (completionCall.init.headers as Record<string, string>)["X-Transient-Auth"],
      "signed-value"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport preserves a bootstrapped conversation binding when the response has no id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-no-id"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-no-id") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"choices":[{"delta":{"content":"<final>OK</final>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session-no-id",
      requestId: "request-no-id",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>OK</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-no-id",
      parentId: ""
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can wrap visible text as a final packet when configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-visible-final"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-visible-final") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-visible-final"},"choices":[{"delta":{"content":"Plain text answer"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              ...createSseProviderRecord().config.transport,
              response: {
                ...createSseProviderRecord().config.transport.response,
                allowVisibleTextFinal: true
              }
            }
          }
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-visible-final",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>Plain text answer</final>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport does not re-wrap assistant packets when visible-text wrapping is enabled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "https://example.test/conversations") {
      return jsonResponse({
        data: {
          id: "conversation-visible-packet"
        }
      });
    }
    if (url === "https://example.test/messages?conversation_id=conversation-visible-packet") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-visible-packet"},"choices":[{"delta":{"content":"<tool>{\\"name\\":\\"bash\\",\\"arguments\\":{\\"command\\":\\"pwd\\"}}</tool>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              ...createSseProviderRecord().config.transport,
              response: {
                ...createSseProviderRecord().config.transport.response,
                allowVisibleTextFinal: true
              }
            }
          }
        };
      }
    });
    const stream = await transport.streamChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-visible-packet",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    const fragments: string[] = [];
    for await (const fragment of stream.content) {
      fragments.push(fragment.content);
    }
    assert.equal(fragments.join(""), '<tool>{"name":"bash","arguments":{"command":"pwd"}}</tool>');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport reuses upstream conversation binding for follow-up turns", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://example.test/messages?conversation_id=conversation-3") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-3"},"choices":[{"delta":{"content":"<final>OK</final>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            bearerToken: "secret-bearer",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createSseProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-3",
      attempt: 1,
      continuation: true,
      toolFollowUp: true,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "conversation-3",
        parentId: "resp-2"
      },
      messages: [
        {
          role: "user",
          content: "Continue"
        }
      ]
    });
    assert.equal(response.content, "<final>OK</final>");
    const completionCall = calls.find(
      (call) => call.url === "https://example.test/messages?conversation_id=conversation-3"
    );
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.equal(requestBody.parent_id, "resp-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport uses a captured seed conversation binding on the first turn", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://example.test/messages?conversation_id=conversation-seed") {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          'data: {"response":{"id":"resp-seed"},"choices":[{"delta":{"content":"<final>Hello</final>"}}]}\n'
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              prompt: {
                mode: "auto_join"
              },
              session: {
                requireCookie: true,
                requireUserAgent: true
              },
              seedBinding: {
                conversationId: "conversation-seed",
                parentId: "parent-seed"
              },
              request: {
                method: "POST",
                url: "https://example.test/messages?conversation_id={{conversationId}}",
                headers: {},
                body: {
                  parent_id: "{{parentId}}",
                  model: "{{modelId}}",
                  message: "{{prompt}}"
                }
              },
              response: {
                contentPaths: ["choices.0.delta.content"],
                responseIdPaths: ["response.id"],
                trimLeadingAssistantBlock: true
              }
            }
          }
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-seed",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    assert.equal(response.content, "<final>Hello</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "conversation-seed",
      parentId: "resp-seed"
    });
    const completionCall = calls.find(
      (call) => call.url === "https://example.test/messages?conversation_id=conversation-seed"
    );
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.equal(requestBody.parent_id, "parent-seed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic templating regenerates dynamic message fields for replayed requests", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    return {
      ok: true,
      status: 200,
      body: createReadableStream(
        'data: {"response":{"id":"resp-dynamic"},"choices":[{"delta":{"content":"<final>OK</final>"}}]}\n'
      ),
      headers: new Headers({ "content-type": "text/event-stream" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          ...createSseProviderRecord(),
          config: {
            transport: {
              prompt: {
                mode: "auto_join"
              },
              session: {
                requireCookie: true,
                requireUserAgent: true
              },
              seedBinding: {
                conversationId: "conversation-seed",
                parentId: "parent-seed"
              },
              request: {
                method: "POST",
                url: "https://example.test/messages?conversation_id={{conversationId}}",
                headers: {
                  "X-Request-Id": "{{requestUuid}}"
                },
                body: {
                  fid: "{{messageId}}",
                  parent_id: "{{parentId}}",
                  childrenIds: [],
                  timestamp: "{{unixTimestampSec}}",
                  message: "{{prompt}}"
                }
              },
              response: {
                contentPaths: ["choices.0.delta.content"],
                responseIdPaths: ["response.id"],
                trimLeadingAssistantBlock: true
              }
            }
          }
        };
      }
    });
    await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-dynamic",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "conversation-seed",
        parentId: "parent-next"
      },
      messages: [
        {
          role: "user",
          content: "hello?"
        }
      ]
    });
    const completionCall = calls.at(-1);
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.match(requestBody.fid, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(requestBody.childrenIds, []);
    assert.equal(requestBody.parent_id, "parent-next");
    assert.equal(typeof requestBody.timestamp, "number");
    assert.ok(requestBody.timestamp > 1700000000);
    const requestHeaders = completionCall.init.headers as Record<string, string>;
    assert.match(String(requestHeaders["X-Request-Id"]), /^[0-9a-f-]{36}$/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic templating can replay numeric parent ids as numbers for exact JSON tokens", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    return {
      ok: true,
      status: 200,
      body: createReadableStream(
        'data: {"response_message_id":3}\n' +
          'data: {"v":{"response":{"message_id":3,"fragments":[{"content":"<final>4</final>"}]}}}\n'
      ),
      headers: new Headers({ "content-type": "text/event-stream" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            bearerToken: "token-1",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          id: "provider-a",
          kind: "http-sse",
          label: "Provider A",
          enabled: true,
          config: {
            models: ["model-a"],
            transport: {
              prompt: {
                mode: "auto_join"
              },
              session: {
                requireCookie: true,
                requireBearerToken: true,
                requireUserAgent: true
              },
              request: {
                method: "POST",
                url: "https://example.test/messages",
                headers: {},
                body: {
                  parent_message_id: "{{parentIdNumberOrNull}}",
                  message: "{{prompt}}"
                }
              },
              response: {
                contentPaths: ["v.response.fragments.*.content"],
                responseIdPaths: ["response_message_id", "v.response.message_id"],
                trimLeadingAssistantBlock: true
              }
            }
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-a",
      sessionId: "bridge-session",
      requestId: "request-parent-number",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "conversation-seed",
        parentId: "2"
      },
      messages: [
        {
          role: "user",
          content: "2*2?"
        }
      ]
    });
    assert.equal(response.content, "<final>4</final>");
    const completionCall = calls.at(-1);
    assert.ok(completionCall);
    const requestBody = JSON.parse(String(completionCall.init.body));
    assert.equal(requestBody.parent_message_id, 2);
    assert.equal(typeof requestBody.parent_message_id, "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-connect transport frames requests and extracts framed responses", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    return {
      ok: true,
      status: 200,
      body: createConnectReadableStream([
        {
          flags: 0,
          payload: {
            message: {
              id: "resp-connect",
              blocks: [
                {
                  text: {
                    content: "<final>Hello from Connect</final>"
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
      headers: new Headers({ "content-type": "application/connect+json" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            bearerToken: "secret-bearer",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createConnectProviderRecord();
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect",
      sessionId: "bridge-session",
      requestId: "request-connect",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "chat-1",
        parentId: "parent-1"
      },
      messages: [
        {
          role: "user",
          content: "minus 2"
        }
      ]
    });
    assert.equal(response.content, "<final>Hello from Connect</final>");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "chat-1",
      parentId: "resp-connect"
    });
    const completionCall = calls.at(-1);
    assert.ok(completionCall);
    const requestHeaders = completionCall.init.headers as Record<string, string>;
    assert.equal(requestHeaders["Content-Type"], "application/connect+json");
    const requestBody = decodeConnectRequestBody(completionCall.init.body);
    assert.equal(requestBody.chat_id, "chat-1");
    assert.equal(requestBody.message.parent_id, "parent-1");
    assert.equal(requestBody.message.blocks[0]?.text?.content, "minus 2");
    assert.equal(requestBody.options.thinking, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-connect transport extracts incremental connect block content and preserves response id across non-content envelopes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      body: createConnectReadableStream([
        {
          flags: 0,
          payload: {
            message: {
              id: "resp-kimi-user",
              parentId: "parent-1",
              role: "user",
              status: "MESSAGE_STATUS_COMPLETED",
              blocks: [
                {
                  text: {
                    content: "plus 10?"
                  }
                }
              ]
            }
          }
        },
        {
          flags: 0,
          payload: {
            message: {
              id: "resp-kimi-assistant",
              parentId: "resp-kimi-user",
              role: "assistant",
              status: "MESSAGE_STATUS_GENERATING"
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              id: "4",
              parentId: "",
              text: {
                content: "-"
              }
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              id: "4",
              parentId: "",
              text: {
                content: "1"
              }
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              id: "4",
              parentId: "",
              text: {
                content: " +"
              }
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              id: "4",
              parentId: "",
              text: {
                content: " 10"
              }
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              id: "4",
              parentId: "",
              text: {
                content: " ="
              }
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              id: "4",
              parentId: "",
              text: {
                content: " 9"
              }
            }
          }
        },
        {
          flags: 0x02,
          payload: {}
        }
      ]),
      headers: new Headers({ "content-type": "application/connect+json" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            bearerToken: "secret-bearer",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          id: "provider-a",
          kind: "http-connect",
          label: "Provider A",
          enabled: true,
          config: {
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
              request: {
                method: "POST",
                url: "https://example.test/connect/chat",
                headers: {
                  "Content-Type": "application/connect+json",
                  "connect-protocol-version": "1"
                },
                body: {
                  chat_id: "{{conversationIdOrOmit}}",
                  message: {
                    parent_id: "{{parentIdOrOmit}}",
                    role: "user",
                    blocks: [
                      {
                        text: {
                          content: "{{prompt}}"
                        }
                      }
                    ]
                  },
                  options: {
                    thinking: true
                  }
                }
              },
              response: {
                contentPaths: ["block.text.content"],
                responseIdPaths: ["message.id", "block.messageId"],
                trimLeadingAssistantBlock: false
              }
            }
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
      }
    });
    const response = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect",
      sessionId: "bridge-session",
      requestId: "request-connect-incremental",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "chat-1",
        parentId: "parent-1"
      },
      messages: [
        {
          role: "user",
          content: "plus 10?"
        }
      ]
    });
    assert.equal(response.content, "-1 + 10 = 9");
    assert.deepEqual(response.upstreamBinding, {
      conversationId: "chat-1",
      parentId: "resp-kimi-assistant"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-connect transport can start a fresh conversation with empty bindings and reuse the returned conversation id", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      init: init ?? {}
    });
    return {
      ok: true,
      status: 200,
      body: createConnectReadableStream([
        {
          flags: 0,
          payload: {
            chat: {
              id: "chat-fresh"
            }
          }
        },
        {
          flags: 0,
          payload: {
            message: {
              id: "resp-fresh"
            }
          }
        },
        {
          flags: 0,
          payload: {
            block: {
              text: {
                content: "<final>Fresh</final>"
              }
            }
          }
        },
        {
          flags: 0x02,
          payload: {}
        }
      ]),
      headers: new Headers({ "content-type": "application/connect+json" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            bearerToken: "secret-bearer",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          id: "provider-a",
          kind: "http-connect",
          label: "Provider A",
          enabled: true,
          config: {
            transport: {
              prompt: {
                mode: "auto_join"
              },
              binding: {
                firstTurn: "empty"
              },
              session: {
                requireCookie: false,
                requireBearerToken: true,
                requireUserAgent: true,
                includeExtraHeaders: true
              },
              request: {
                method: "POST",
                url: "https://example.test/connect/chat",
                headers: {
                  "Content-Type": "application/connect+json",
                  "connect-protocol-version": "1"
                },
                body: {
                  chat_id: "{{conversationIdOrOmit}}",
                  message: {
                    parent_id: "{{parentIdOrOmit}}",
                    role: "user",
                    blocks: [
                      {
                        text: {
                          content: "{{prompt}}"
                        }
                      }
                    ]
                  }
                }
              },
              response: {
                contentPaths: ["block.text.content"],
                responseIdPaths: ["message.id"],
                conversationIdPaths: ["chat.id"],
                trimLeadingAssistantBlock: true
              }
            }
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
      }
    });
    const first = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect",
      sessionId: "bridge-session",
      requestId: "request-connect-fresh-1",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    });
    assert.equal(first.content, "<final>Fresh</final>");
    assert.deepEqual(first.upstreamBinding, {
      conversationId: "chat-fresh",
      parentId: "resp-fresh"
    });
    const firstRequestBody = decodeConnectRequestBody(calls[0]?.init.body);
    assert.equal(firstRequestBody.chat_id, undefined);
    assert.equal(firstRequestBody.message.parent_id, undefined);
    const second = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect",
      sessionId: "bridge-session",
      requestId: "request-connect-fresh-2",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: first.upstreamBinding,
      messages: [
        {
          role: "user",
          content: "hello"
        },
        {
          role: "assistant",
          content: "Fresh"
        },
        {
          role: "user",
          content: "again"
        }
      ]
    });
    assert.equal(second.content, "<final>Fresh</final>");
    const secondRequestBody = decodeConnectRequestBody(calls[1]?.init.body);
    assert.equal(secondRequestBody.chat_id, "chat-fresh");
    assert.equal(secondRequestBody.message.parent_id, "resp-fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-connect transport renders captured boolean request variants from model suffixes", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      init: init ?? {}
    });
    return {
      ok: true,
      status: 200,
      body: createConnectReadableStream([
        {
          flags: 0,
          payload: {
            message: {
              id: "resp-thinking-variant",
              blocks: [
                {
                  text: {
                    content: "<final>OK</final>"
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
      headers: new Headers({ "content-type": "application/connect+json" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            bearerToken: "secret-bearer",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return {
          id: "provider-a",
          kind: "http-connect",
          label: "Provider A",
          enabled: true,
          config: {
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
              request: {
                method: "POST",
                url: "https://example.test/connect/chat",
                headers: {
                  "Content-Type": "application/connect+json",
                  "connect-protocol-version": "1"
                },
                body: {
                  chat_id: "{{conversationId}}",
                  message: {
                    parent_id: "{{parentId}}",
                    role: "user",
                    blocks: [
                      {
                        text: {
                          content: "{{prompt}}"
                        }
                      }
                    ]
                  },
                  options: {
                    thinking: "{{thinkingEnabledOrFalse}}"
                  }
                }
              },
              response: {
                contentPaths: ["message.blocks.0.text.content"],
                responseIdPaths: ["message.id"],
                trimLeadingAssistantBlock: true
              }
            }
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
      }
    });
    await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect@thinking",
      sessionId: "bridge-session",
      requestId: "request-connect-thinking-variant",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "chat-1",
        parentId: "parent-1"
      },
      messages: [
        {
          role: "user",
          content: "plus 2"
        }
      ]
    });
    await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect@instant",
      sessionId: "bridge-session",
      requestId: "request-connect-instant-variant",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "chat-1",
        parentId: "parent-1"
      },
      messages: [
        {
          role: "user",
          content: "plus 2"
        }
      ]
    });
    await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "model-connect@no-thinking",
      sessionId: "bridge-session",
      requestId: "request-connect-no-thinking-variant",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: {
        conversationId: "chat-1",
        parentId: "parent-1"
      },
      messages: [
        {
          role: "user",
          content: "plus 2"
        }
      ]
    });
    const firstBody = decodeConnectRequestBody(calls[0]?.init.body);
    const secondBody = decodeConnectRequestBody(calls[1]?.init.body);
    const thirdBody = decodeConnectRequestBody(calls[2]?.init.body);
    assert.equal(firstBody.options.thinking, true);
    assert.equal(secondBody.options.thinking, false);
    assert.equal(thirdBody.options.thinking, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can replay ChatGPT conversation requests and ignore hidden widget markers", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    return {
      ok: true,
      status: 200,
      body: createReadableStream(
        [
          "event: delta_encoding\n",
          'data: "v1"\n',
          "\n",
          'data: {"type":"resume_conversation_token","conversation_id":"chatgpt-conversation-1"}\n',
          "\n",
          "event: delta\n",
          'data: {"v":{"message":{"id":"widget-message","author":{"role":"assistant","metadata":{}},"content":{"content_type":"text","parts":["\\ue200genui\\ue202N0Ws\\ue201"]},"status":"finished_partial_completion","end_turn":false}},"conversation_id":"chatgpt-conversation-1","c":0}\n',
          "\n",
          "event: delta\n",
          'data: {"v":{"message":{"id":"assistant-message-1","author":{"role":"assistant","metadata":{"real_author":"tool:web"}},"content":{"content_type":"text","parts":["\\n\\nThat comes out to 4."]},"status":"finished_successfully","end_turn":true}},"conversation_id":"chatgpt-conversation-1","c":1}\n',
          "\n",
          'data: {"type":"message_stream_complete","conversation_id":"chatgpt-conversation-1"}\n',
          "\n",
          "data: [DONE]\n"
        ].join("")
      ),
      headers: new Headers({ "content-type": "text/event-stream" }),
      async text() {
        return "";
      }
    } as Response;
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            bearerToken: "secret-bearer",
            userAgent: "Mozilla/5.0",
            extraHeaders: {
              Accept: "text/event-stream",
              "Content-Type": "application/json"
            },
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createOpenAiChatProviderRecord();
      }
    });
    const first = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "auto",
      sessionId: "bridge-session",
      requestId: "request-openai-chat-1",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "2*2?"
        }
      ]
    });
    assert.equal(first.content, "<final>That comes out to 4.</final>");
    assert.deepEqual(first.upstreamBinding, {
      conversationId: "chatgpt-conversation-1",
      parentId: "assistant-message-1"
    });
    const firstRequest = JSON.parse(String(calls[0]?.init.body));
    assert.equal(firstRequest.parent_message_id, "client-created-root");
    assert.equal(firstRequest.model, "auto");
    assert.match(String(firstRequest.messages[0]?.id), /^[0-9a-f-]{36}$/i);
    assert.equal(firstRequest.messages[0]?.content?.parts?.[0], "2*2?");
    await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "gpt-5-4-thinking",
      sessionId: "bridge-session",
      requestId: "request-openai-chat-2",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: first.upstreamBinding,
      messages: [
        {
          role: "user",
          content: "and 3*3?"
        }
      ]
    });
    const secondRequest = JSON.parse(String(calls[1]?.init.body));
    assert.equal(secondRequest.parent_message_id, "assistant-message-1");
    assert.equal(secondRequest.model, "gpt-5-4-thinking");
    assert.equal(secondRequest.messages[0]?.content?.parts?.[0], "and 3*3?");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport surfaces upstream HTTP status details for rejected requests", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response('{"detail":"token expired"}', {
      status: 403,
      headers: {
        "content-type": "application/json"
      }
    });
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            bearerToken: "secret-bearer",
            userAgent: "Mozilla/5.0",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createOpenAiChatProviderRecord();
      }
    });
    await assert.rejects(
      () =>
        transport.completeChat({
          lane: "main",
          providerId: "provider-a",
          modelId: "auto",
          sessionId: "bridge-session",
          requestId: "request-openai-chat-http-error",
          attempt: 1,
          continuation: false,
          toolFollowUp: false,
          providerSessionReused: false,
          upstreamBinding: null,
          messages: [
            {
              role: "user",
              content: "2*2?"
            }
          ]
        }),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal("code" in (error as Record<string, unknown>), true);
        assert.equal(
          (
            error as {
              code?: unknown;
            }
          ).code,
          "request_invalid"
        );
        assert.equal(
          (
            error as {
              displayMessage?: unknown;
            }
          ).displayMessage,
          "Provider request failed with HTTP 403."
        );
        assert.deepEqual(
          (
            error as {
              details?: unknown;
            }
          ).details,
          {
            stage: "request",
            httpStatus: 403,
            responsePreview: '{"detail":"token expired"}'
          }
        );
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can bootstrap and sign z.ai-style conversations", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://chat.z.ai/api/v1/chats/new") {
      return jsonResponse({
        id: "chat-zai-1"
      });
    }
    if (url.startsWith("https://chat.z.ai/api/v2/chat/completions?")) {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"type":"chat:completion","data":{"delta_content":"thinking...","phase":"thinking"}}\n',
            'data: {"type":"chat:completion","data":{"delta_content":"4","phase":"answer"}}\n',
            'data: {"type":"chat:completion","data":{"phase":"done","done":true}}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "token=session-cookie",
            bearerToken:
              "eyJhbGciOiJFUzI1NiJ9.eyJpZCI6InVzZXItMSIsImVtYWlsIjoiZ3Vlc3QtMUBndWVzdC5jb20ifQ.signature",
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            extraHeaders: {
              "Accept-Language": "en-US",
              "sec-ch-ua-platform": '"macOS"'
            },
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createZaiProviderRecord();
      }
    });
    const first = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "glm-4.7",
      sessionId: "bridge-session",
      requestId: "request-zai-1",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "2*2?"
        }
      ]
    });
    assert.equal(first.content, "4");
    assert.equal(first.upstreamBinding?.conversationId, "chat-zai-1");
    assert.ok(first.upstreamBinding?.parentId);
    const bootstrapCall = calls.find((call) => call.url === "https://chat.z.ai/api/v1/chats/new");
    assert.ok(bootstrapCall);
    const bootstrapBody = JSON.parse(String(bootstrapCall.init.body));
    assert.equal(bootstrapBody.chat.history.messages["bootstrap-user"].content, "2*2?");
    assert.equal(bootstrapBody.chat.models[0], "glm-4.7");
    const completionCall = calls.find((call) =>
      call.url.startsWith("https://chat.z.ai/api/v2/chat/completions?")
    );
    assert.ok(completionCall);
    const completionUrl = new URL(completionCall.url);
    assert.equal(completionUrl.searchParams.get("user_id"), "user-1");
    assert.equal(completionUrl.searchParams.get("pathname"), "/c/chat-zai-1");
    assert.equal(completionUrl.searchParams.get("current_url"), "https://chat.z.ai/c/chat-zai-1");
    assert.equal(
      completionUrl.searchParams.get("token"),
      "eyJhbGciOiJFUzI1NiJ9.eyJpZCI6InVzZXItMSIsImVtYWlsIjoiZ3Vlc3QtMUBndWVzdC5jb20ifQ.signature"
    );
    assert.equal(
      completionUrl.searchParams.get("signature_timestamp"),
      completionUrl.searchParams.get("timestamp")
    );
    assert.match(
      String((completionCall.init.headers as Record<string, string>)["X-Signature"] ?? ""),
      /^[a-f0-9]{64}$/
    );
    assert.equal(
      (completionCall.init.headers as Record<string, string>)["X-FE-Version"],
      "prod-fe-1.1.2"
    );
    const firstCompletionBody = JSON.parse(String(completionCall.init.body));
    assert.equal(firstCompletionBody.signature_prompt, "2*2?");
    assert.equal(firstCompletionBody.messages[0].content, "2*2?");
    assert.equal(firstCompletionBody.chat_id, "chat-zai-1");
    assert.equal(firstCompletionBody.current_user_message_parent_id, null);
    assert.equal(firstCompletionBody.id, first.upstreamBinding?.parentId);
    const second = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "glm-4.7",
      sessionId: "bridge-session",
      requestId: "request-zai-2",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: first.upstreamBinding,
      messages: [
        {
          role: "user",
          content: "2*2?"
        },
        {
          role: "assistant",
          content: "4"
        },
        {
          role: "user",
          content: "3*3?"
        }
      ]
    });
    assert.equal(second.content, "4");
    assert.ok(second.upstreamBinding?.parentId);
    assert.notEqual(second.upstreamBinding?.parentId, first.upstreamBinding?.parentId);
    const secondCompletionCall = calls.filter((call) =>
      call.url.startsWith("https://chat.z.ai/api/v2/chat/completions?")
    )[1];
    assert.ok(secondCompletionCall);
    const secondCompletionBody = JSON.parse(String(secondCompletionCall.init.body));
    assert.equal(secondCompletionBody.messages[0].content, "3*3?");
    assert.equal(secondCompletionBody.signature_prompt, "3*3?");
    assert.equal(
      secondCompletionBody.current_user_message_parent_id,
      first.upstreamBinding?.parentId
    );
    assert.equal(secondCompletionBody.id, second.upstreamBinding?.parentId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic latest_user transport preserves bridge tool-aware system prompts instead of collapsing to the last user message", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://chat.z.ai/api/v1/chats/new") {
      return jsonResponse({
        id: "chat-zai-tool-aware"
      });
    }
    if (url.startsWith("https://chat.z.ai/api/v2/chat/completions?")) {
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            'data: {"type":"chat:completion","data":{"delta_content":"<final>ok</final>","phase":"answer"}}\n',
            'data: {"type":"chat:completion","data":{"phase":"done","done":true}}\n'
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "token=session-cookie",
            bearerToken: "eyJhbGciOiJFUzI1NiJ9.eyJpZCI6InVzZXItMSJ9.signature",
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createZaiProviderRecord();
      }
    });
    await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "glm-4.7",
      sessionId: "bridge-session",
      requestId: "request-zai-tool-aware",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "system",
          content: [
            "You are an OpenAI-compatible tool-calling adapter for the standalone bridge server.",
            "Available functions:",
            "- bash: Run shell commands."
          ].join("\n")
        },
        {
          role: "user",
          content: [
            "Respond to the current user request below.",
            "Tool choice: auto.",
            "Current turn:",
            "USER:",
            "Hello?",
            "Mandatory response protocol for this turn:"
          ].join("\n\n")
        }
      ]
    });
    const bootstrapCall = calls.find((call) => call.url === "https://chat.z.ai/api/v1/chats/new");
    assert.ok(bootstrapCall);
    const bootstrapBody = JSON.parse(String(bootstrapCall.init.body));
    assert.match(
      String(bootstrapBody.chat.history.messages["bootstrap-user"].content),
      /OpenAI-compatible tool-calling adapter/
    );
    assert.match(
      String(bootstrapBody.chat.history.messages["bootstrap-user"].content),
      /Available functions:/
    );
    assert.match(
      String(bootstrapBody.chat.history.messages["bootstrap-user"].content),
      /- bash: Run shell commands\./
    );
    assert.match(
      String(bootstrapBody.chat.history.messages["bootstrap-user"].content),
      /USER:\s*Hello\?/
    );
    const completionCall = calls.find((call) =>
      call.url.startsWith("https://chat.z.ai/api/v2/chat/completions?")
    );
    assert.ok(completionCall);
    const completionBody = JSON.parse(String(completionCall.init.body));
    assert.match(
      String(completionBody.messages[0].content),
      /OpenAI-compatible tool-calling adapter/
    );
    assert.match(String(completionBody.messages[0].content), /Available functions:/);
    assert.match(String(completionBody.messages[0].content), /- bash: Run shell commands\./);
    assert.match(String(completionBody.messages[0].content), /USER:\s*Hello\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("generic http-sse transport can bootstrap fresh Qwen chats without reusing the captured parent id", async () => {
  const calls: Array<{
    url: string;
    init: RequestInit;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      init: init ?? {}
    });
    if (url === "https://chat.qwen.ai/api/v2/chats/new") {
      return jsonResponse({
        success: true,
        data: {
          id: "chat-qwen-1"
        }
      });
    }
    if (url === "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-qwen-1") {
      const responseId =
        calls.filter((call) => call.url === url).length === 1 ? "resp-qwen-1" : "resp-qwen-2";
      const answer = responseId === "resp-qwen-1" ? "10" : "9";
      return {
        ok: true,
        status: 200,
        body: createReadableStream(
          [
            `data: {"response.created":{"chat_id":"chat-qwen-1","parent_id":"user-msg-1","response_id":"${responseId}"}}\n`,
            `data: {"choices":[{"delta":{"role":"assistant","content":"${answer}","phase":"answer","status":"finished"}}],"response_id":"${responseId}"}\n`
          ].join("")
        ),
        headers: new Headers({ "content-type": "text/event-stream" }),
        async text() {
          return "";
        }
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const transport = new WebProviderTransport({
      providerSessionResolver: {
        rootDir: "/tmp",
        async loadProviderSession() {
          return {
            providerId: "provider-a",
            cookie: "session=secret",
            userAgent: "Mozilla/5.0",
            extraHeaders: {
              Referer: "https://chat.qwen.ai/c/captured-chat"
            },
            updatedAt: new Date(0).toISOString()
          };
        }
      },
      loadProvider() {
        return createQwenProviderRecord();
      }
    });
    const first = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "qwen3.6-plus",
      sessionId: "bridge-session",
      requestId: "request-qwen-1",
      attempt: 1,
      continuation: false,
      toolFollowUp: false,
      providerSessionReused: false,
      upstreamBinding: null,
      messages: [
        {
          role: "user",
          content: "2*5?"
        }
      ]
    });
    assert.equal(first.content, "10");
    assert.deepEqual(first.upstreamBinding, {
      conversationId: "chat-qwen-1",
      parentId: "resp-qwen-1"
    });
    const bootstrapCall = calls.find(
      (call) => call.url === "https://chat.qwen.ai/api/v2/chats/new"
    );
    assert.ok(bootstrapCall);
    const bootstrapBody = JSON.parse(String(bootstrapCall.init.body));
    assert.equal(bootstrapBody.title, "New Chat");
    assert.equal(bootstrapBody.models[0], "qwen3.6-plus");
    assert.equal(bootstrapBody.chat_mode, "normal");
    assert.equal(bootstrapBody.chat_type, "t2t");
    const completionCall = calls.find(
      (call) => call.url === "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-qwen-1"
    );
    assert.ok(completionCall);
    const firstCompletionBody = JSON.parse(String(completionCall.init.body));
    assert.equal(firstCompletionBody.chat_id, "chat-qwen-1");
    assert.equal(firstCompletionBody.parent_id, undefined);
    assert.equal(firstCompletionBody.model, "qwen3.6-plus");
    assert.equal(firstCompletionBody.messages[0].content, "2*5?");
    const second = await transport.completeChat({
      lane: "main",
      providerId: "provider-a",
      modelId: "qwen3.6-plus",
      sessionId: "bridge-session",
      requestId: "request-qwen-2",
      attempt: 1,
      continuation: true,
      toolFollowUp: false,
      providerSessionReused: true,
      upstreamBinding: first.upstreamBinding,
      messages: [
        {
          role: "user",
          content: "2*5?"
        },
        {
          role: "assistant",
          content: "10"
        },
        {
          role: "user",
          content: "3*3?"
        }
      ]
    });
    assert.equal(second.content, "9");
    assert.deepEqual(second.upstreamBinding, {
      conversationId: "chat-qwen-1",
      parentId: "resp-qwen-2"
    });
    const secondCompletionCall = calls.filter(
      (call) => call.url === "https://chat.qwen.ai/api/v2/chat/completions?chat_id=chat-qwen-1"
    )[1];
    assert.ok(secondCompletionCall);
    const secondCompletionBody = JSON.parse(String(secondCompletionCall.init.body));
    assert.equal(secondCompletionBody.parent_id, "resp-qwen-1");
    assert.match(String(secondCompletionBody.messages[0].content), /USER:\s*3\*3\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
function createSseProviderRecord() {
  return {
    id: "provider-a",
    kind: "http-sse",
    label: "Provider A",
    enabled: true,
    config: {
      transport: {
        prompt: {
          mode: "auto_join"
        },
        session: {
          requireCookie: true,
          requireUserAgent: true
        },
        bootstrap: {
          request: {
            method: "POST",
            url: "https://example.test/conversations",
            headers: {},
            body: {
              trace_id: "{{requestId}}"
            }
          },
          conversationIdPath: "data.id"
        },
        request: {
          method: "POST",
          url: "https://example.test/messages?conversation_id={{conversationId}}",
          headers: {},
          body: {
            parent_id: "{{parentId}}",
            model: "{{modelId}}",
            message: "{{prompt}}"
          }
        },
        response: {
          contentPaths: ["choices.0.delta.content"],
          responseIdPaths: ["response.id"],
          trimLeadingAssistantBlock: true
        }
      }
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
function createOpenAiChatProviderRecord() {
  return {
    id: "provider-a",
    kind: "http-sse",
    label: "OpenAI Chat",
    enabled: true,
    config: {
      transport: {
        prompt: {
          mode: "auto_join"
        },
        binding: {
          firstTurn: "empty"
        },
        session: {
          requireCookie: true,
          requireBearerToken: true,
          requireUserAgent: true,
          includeExtraHeaders: true
        },
        request: {
          method: "POST",
          url: "https://chatgpt.com/backend-api/f/conversation",
          headers: {},
          body: {
            action: "next",
            messages: [
              {
                id: "{{messageId}}",
                author: {
                  role: "user"
                },
                create_time: "{{unixTimestampSec}}",
                content: {
                  content_type: "text",
                  parts: ["{{prompt}}"]
                },
                metadata: {
                  selected_github_repos: [],
                  selected_all_github_repos: false,
                  serialization_metadata: {
                    custom_symbol_offsets: []
                  }
                }
              }
            ],
            parent_message_id: "{{parentIdOrClientCreatedRoot}}",
            model: "{{modelId}}",
            timezone: "Europe/Madrid",
            supports_buffering: true,
            supported_encodings: ["v1"]
          }
        },
        response: {
          contentPaths: ["v.message.content.parts.*", "message.content.parts.*"],
          responseIdPaths: ["v.message.id", "message.id"],
          conversationIdPaths: ["conversation_id", "v.conversation_id"],
          allowVisibleTextFinal: true
        }
      }
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
function createConnectProviderRecord() {
  return {
    id: "provider-a",
    kind: "http-connect",
    label: "Provider A",
    enabled: true,
    config: {
      transport: {
        prompt: {
          mode: "auto_join"
        },
        session: {
          requireCookie: true,
          requireBearerToken: true,
          requireUserAgent: true
        },
        request: {
          method: "POST",
          url: "https://example.test/connect/chat",
          headers: {
            "Content-Type": "application/connect+json",
            "connect-protocol-version": "1"
          },
          body: {
            chat_id: "{{conversationId}}",
            message: {
              parent_id: "{{parentId}}",
              role: "user",
              blocks: [
                {
                  text: {
                    content: "{{prompt}}"
                  }
                }
              ]
            },
            options: {
              thinking: false
            }
          }
        },
        response: {
          contentPaths: ["message.blocks.0.text.content"],
          responseIdPaths: ["message.id"],
          trimLeadingAssistantBlock: true
        }
      }
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
function createZaiProviderRecord() {
  return {
    id: "provider-a",
    kind: "http-sse",
    label: "Z.ai",
    enabled: true,
    config: {
      transport: {
        prompt: {
          mode: "latest_user"
        },
        binding: {
          firstTurn: "seed"
        },
        session: {
          requireCookie: true,
          requireBearerToken: true,
          requireUserAgent: true,
          includeExtraHeaders: true
        },
        bootstrap: {
          request: {
            method: "POST",
            url: "https://chat.z.ai/api/v1/chats/new",
            headers: {},
            body: {
              chat: {
                id: "",
                title: "New Chat",
                models: ["{{modelId}}"],
                history: {
                  messages: {
                    "bootstrap-user": {
                      id: "bootstrap-user",
                      parentId: null,
                      childrenIds: [],
                      role: "user",
                      content: "{{prompt}}",
                      timestamp: "{{unixTimestampSec}}",
                      models: ["{{modelId}}"]
                    }
                  },
                  currentId: "bootstrap-user"
                }
              }
            }
          },
          conversationIdPath: "id"
        },
        request: {
          method: "POST",
          url: "https://chat.z.ai/api/v2/chat/completions",
          headers: {},
          signing: {
            kind: "z-ai-v1"
          },
          body: {
            stream: true,
            model: "{{modelId}}",
            messages: [
              {
                role: "user",
                content: "{{prompt}}"
              }
            ],
            signature_prompt: "{{prompt}}",
            chat_id: "{{conversationId}}",
            id: "{{assistantMessageId}}",
            current_user_message_id: "{{userMessageId}}",
            current_user_message_parent_id: "{{parentIdOrNull}}"
          }
        },
        response: {
          contentPaths: ["data.delta_content"],
          eventFilters: [
            {
              path: "data.phase",
              equals: "answer"
            }
          ],
          fallbackResponseId: "assistantMessageId"
        }
      }
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
function createQwenProviderRecord() {
  return {
    id: "provider-a",
    kind: "http-sse",
    label: "Qwen",
    enabled: true,
    config: {
      transport: {
        prompt: {
          mode: "flatten"
        },
        binding: {
          firstTurn: "seed"
        },
        session: {
          requireCookie: true,
          requireBearerToken: false,
          requireUserAgent: true,
          includeExtraHeaders: true
        },
        bootstrap: {
          request: {
            method: "POST",
            url: "https://chat.qwen.ai/api/v2/chats/new",
            headers: {},
            body: {
              title: "New Chat",
              models: ["{{modelId}}"],
              chat_mode: "normal",
              chat_type: "t2t",
              timestamp: "{{unixTimestampMs}}",
              project_id: ""
            }
          },
          conversationIdPath: "data.id"
        },
        request: {
          method: "POST",
          url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id={{conversationId}}",
          headers: {},
          body: {
            stream: true,
            version: "2.1",
            incremental_output: true,
            chat_id: "{{conversationIdOrOmit}}",
            chat_mode: "normal",
            model: "{{modelId}}",
            parent_id: "{{parentIdOrOmit}}",
            messages: [
              {
                fid: "{{messageId}}",
                role: "user",
                content: "{{prompt}}",
                user_action: "chat",
                files: [],
                timestamp: "{{unixTimestampSec}}",
                models: ["{{modelId}}"],
                chat_type: "t2t",
                sub_chat_type: "t2t"
              }
            ],
            timestamp: "{{unixTimestampSec}}"
          }
        },
        response: {
          contentPaths: ["choices.0.delta.content"],
          responseIdPaths: ["response_id", "response.created.response_id"],
          conversationIdPaths: ["response.created.chat_id"],
          eventFilters: [
            {
              path: "choices.0.delta.phase",
              equals: "answer"
            }
          ],
          trimLeadingAssistantBlock: true
        }
      }
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
function createReadableStream(content: string) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(content));
      controller.close();
    }
  });
}
function createConnectReadableStream(
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
function decodeConnectRequestBody(value: RequestInit["body"]) {
  assert.ok(value instanceof Uint8Array);
  const length =
    ((value[1] ?? 0) << 24) | ((value[2] ?? 0) << 16) | ((value[3] ?? 0) << 8) | (value[4] ?? 0);
  const payload = new TextDecoder().decode(value.slice(5, 5 + length));
  return JSON.parse(payload) as Record<string, any>;
}
