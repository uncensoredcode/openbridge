import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import { cliModule } from "../src/cli/index.ts";

const { runBridgeServerCli, parseBridgeServerCliArgs } = cliModule;
test("argument parser supports the chat command", () => {
  const parsed = parseBridgeServerCliArgs({
    argv: [
      "chat",
      "--base-url",
      "http://127.0.0.1:4319",
      "--model",
      "provider-a/model-alpha",
      "--message",
      "Reply with exactly OK.",
      "--system",
      "Be brief.",
      "--stream"
    ]
  });
  assert.deepEqual(parsed, {
    kind: "chat",
    baseUrl: "http://127.0.0.1:4319",
    model: "provider-a/model-alpha",
    message: "Reply with exactly OK.",
    system: "Be brief.",
    stream: true
  });
});
test("chat CLI prints final assistant text for non-streaming completions", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const { baseUrl, close } = await startStubServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    requestBody = (await readJson(request)) as Record<string, unknown>;
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(
      JSON.stringify({
        id: "chatcmpl_test",
        object: "chat.completion",
        created: 1,
        model: "provider-a/model-alpha",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "OK"
            },
            finish_reason: "stop"
          }
        ]
      })
    );
  });
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runBridgeServerCli({
      argv: [
        "chat",
        "--base-url",
        baseUrl,
        "--model",
        "provider-a/model-alpha",
        "--message",
        "Reply with exactly OK."
      ],
      stdout,
      stderr
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout.text, "OK\n");
    assert.deepEqual(stdout.chunks, ["OK\n"]);
    assert.equal(stderr.text, "");
    assert.deepEqual(requestBody, {
      model: "provider-a/model-alpha",
      messages: [
        {
          role: "user",
          content: "Reply with exactly OK."
        }
      ]
    });
  } finally {
    await close();
  }
});
test("chat CLI streams assistant deltas to stdout incrementally", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const { baseUrl, close } = await startStubServer(async (request, response) => {
    requestBody = (await readJson(request)) as Record<string, unknown>;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    response.write(
      'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"provider-a/model-alpha","choices":[{"index":0,"delta":{"role":"assistant","content":"O"},"finish_reason":null}]}\n\n'
    );
    response.write(
      'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"provider-a/model-alpha","choices":[{"index":0,"delta":{"content":"K"},"finish_reason":null}]}\n\n'
    );
    response.write(
      'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"provider-a/model-alpha","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    );
    response.end("data: [DONE]\n\n");
  });
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runBridgeServerCli({
      argv: [
        "chat",
        "--base-url",
        baseUrl,
        "--model",
        "provider-a/model-alpha",
        "--message",
        "Reply with exactly OK.",
        "--stream"
      ],
      stdout,
      stderr
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout.text, "OK\n");
    assert.deepEqual(stdout.chunks, ["O", "K", "\n"]);
    assert.equal(stderr.text, "");
    assert.deepEqual(requestBody, {
      model: "provider-a/model-alpha",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Reply with exactly OK."
        }
      ]
    });
  } finally {
    await close();
  }
});
test("chat CLI handles streaming [DONE] cleanly", async () => {
  const { baseUrl, close } = await startStubServer(async (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    response.write(
      'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"provider-a/model-alpha","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
    );
    response.write(
      'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":1,"model":"provider-a/model-alpha","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    );
    response.end("data: [DONE]\n\n");
  });
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runBridgeServerCli({
      argv: [
        "chat",
        "--base-url",
        baseUrl,
        "--model",
        "provider-a/model-alpha",
        "--message",
        "Reply with exactly OK.",
        "--stream"
      ],
      stdout,
      stderr
    });
    assert.equal(exitCode, 0);
    assert.equal(stdout.text, "\n");
    assert.deepEqual(stdout.chunks, ["\n"]);
    assert.equal(stderr.text, "");
  } finally {
    await close();
  }
});
test("chat CLI prints normalized JSON errors to stderr", async () => {
  const { baseUrl, close } = await startStubServer(async (_request, response) => {
    response.writeHead(409, {
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(
      JSON.stringify({
        error: {
          code: "provider_unavailable",
          message: "Provider 'provider-a' is disabled for model 'provider-a/model-alpha'."
        }
      })
    );
  });
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runBridgeServerCli({
      argv: [
        "chat",
        "--base-url",
        baseUrl,
        "--model",
        "provider-a/model-alpha",
        "--message",
        "Reply with exactly OK."
      ],
      stdout,
      stderr
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout.text, "");
    assert.equal(
      stderr.text,
      "Provider 'provider-a' is disabled for model 'provider-a/model-alpha'.\n"
    );
  } finally {
    await close();
  }
});
test("chat CLI reports connection failures clearly", async () => {
  const port = await reserveUnusedPort();
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runBridgeServerCli({
    argv: [
      "chat",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--model",
      "provider-a/model-alpha",
      "--message",
      "Reply with exactly OK."
    ],
    stdout,
    stderr
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.text, "");
  assert.match(
    stderr.text,
    new RegExp(`^Failed to reach bridge server at http://127\\.0\\.0\\.1:${port}\\.`)
  );
});
test("chat CLI fails clearly on malformed streams", async () => {
  const { baseUrl, close } = await startStubServer(async (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    response.end('data: {"unexpected":true}\n\n');
  });
  const stdout = captureStream();
  const stderr = captureStream();
  try {
    const exitCode = await runBridgeServerCli({
      argv: [
        "chat",
        "--base-url",
        baseUrl,
        "--model",
        "provider-a/model-alpha",
        "--message",
        "Reply with exactly OK.",
        "--stream"
      ],
      stdout,
      stderr
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout.text, "");
    assert.equal(stderr.text, "Bridge chat stream contained a malformed chunk.\n");
  } finally {
    await close();
  }
});
function captureStream() {
  let text = "";
  const chunks: string[] = [];
  return {
    chunks,
    get text() {
      return text;
    },
    write(value: string) {
      chunks.push(value);
      text += value;
    }
  };
}
async function startStubServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>
  ) => Promise<void> | void
) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind stub server.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    async close() {
      await closeServer(server);
    }
  };
}
async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
async function reserveUnusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a test port.");
  }
  const port = address.port;
  await closeServer(server);
  return port;
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
