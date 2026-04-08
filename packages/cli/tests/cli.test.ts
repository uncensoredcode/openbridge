import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse
} from "@openbridge/runtime";
import { bridgeRuntime } from "@openbridge/runtime";
import { bridgeServer } from "@openbridge/server";

import { bridgeCli } from "../src/index.ts";

const { createBridgeApiServer, createBridgeRuntimeService } = bridgeServer;
const { createMessagePacket, createToolRequestPacket } = bridgeRuntime;
const { getBridgeCliHelpText, parseBridgeCliArgs, runBridgeCli } = bridgeCli;
type RunBridgeServerCliInput = Parameters<typeof bridgeServer.runBridgeServerCli>[0];
class ScriptedTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];
  readonly #callCounts = new Map<string, number>();
  readonly #handler: (
    request: ProviderTransportRequest,
    callIndex: number
  ) => Promise<ProviderTransportResponse> | ProviderTransportResponse;
  constructor(
    handler: (
      request: ProviderTransportRequest,
      callIndex: number
    ) => Promise<ProviderTransportResponse> | ProviderTransportResponse
  ) {
    this.#handler = handler;
  }
  async completeChat(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    this.calls.push(request);
    const callIndex = (this.#callCounts.get(request.sessionId) ?? 0) + 1;
    this.#callCounts.set(request.sessionId, callIndex);
    return this.#handler(request, callIndex);
  }
}
test("argument parser accepts session, positional input, and base URL", () => {
  const parsed = parseBridgeCliArgs({
    argv: ["--base-url", "http://127.0.0.1:4318", "--session", "demo", "Read package.json"]
  });
  assert.deepEqual(parsed, {
    kind: "send",
    baseUrl: "http://127.0.0.1:4318",
    sessionId: "demo",
    input: "Read package.json",
    provider: undefined,
    model: undefined,
    metadata: undefined,
    toolProfile: undefined
  });
});
test("argument parser forwards server subcommands to the server CLI", () => {
  const parsed = parseBridgeCliArgs({
    argv: ["start", "--host", "0.0.0.0", "--port", "4318"]
  });
  assert.deepEqual(parsed, {
    kind: "server",
    argv: ["start", "--host", "0.0.0.0", "--port", "4318"]
  });
});
test("argument parser supports the health command", () => {
  const parsed = parseBridgeCliArgs({
    argv: ["health", "--base-url", "http://127.0.0.1:4319"]
  });
  assert.deepEqual(parsed, {
    kind: "health",
    baseUrl: "http://127.0.0.1:4319"
  });
});
test("help text stays generic", () => {
  assert.doesNotMatch(getBridgeCliHelpText(), /telegram|openclaw|bridge-core/i);
  assert.match(getBridgeCliHelpText(), /^openbridge/m);
});
test("CLI routes server commands through the standalone server CLI", async () => {
  const calls: RunBridgeServerCliInput[] = [];
  const exitCode = await runBridgeCli({
    argv: ["start", "--host", "127.0.0.1", "--port", "4318"],
    stdout: captureStream(),
    stderr: captureStream(),
    runServerCli: async (input) => {
      calls.push(input);
      return 0;
    }
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.argv, ["start", "--host", "127.0.0.1", "--port", "4318"]);
});
test("CLI sends requests to the configured base URL and prints normalized output", async () => {
  const transport = new ScriptedTransport((request) => ({
    content: createMessagePacket("final", "CLI bridge output."),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: "resp-1"
    }
  }));
  const { baseUrl, close } = await startBridgeApiServer(transport);
  const output = captureStream();
  const errors = captureStream();
  try {
    const exitCode = await runBridgeCli({
      argv: [
        "--base-url",
        baseUrl,
        "--session",
        "cli-demo",
        "--provider",
        "session-sse",
        "Summarize the repo"
      ],
      stdout: output,
      stderr: errors
    });
    assert.equal(exitCode, 0);
    assert.equal(output.text, "CLI bridge output.\n");
    assert.equal(errors.text, "");
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0]?.sessionId, "cli-demo");
  } finally {
    await close();
  }
});
test("CLI passes metadata and session ids correctly", async () => {
  const transport = new ScriptedTransport((request) => ({
    content: createMessagePacket("final", `session=${request.sessionId}`),
    upstreamBinding: {
      conversationId: "conv-1",
      parentId: "resp-1"
    }
  }));
  const { baseUrl, close } = await startBridgeApiServer(transport);
  const output = captureStream();
  try {
    const exitCode = await runBridgeCli({
      argv: [
        "--base-url",
        baseUrl,
        "--session",
        "session-42",
        "--metadata",
        '{"client":"cli"}',
        "--input",
        "Read README.md"
      ],
      stdout: output,
      stderr: captureStream()
    });
    assert.equal(exitCode, 0);
    assert.equal(output.text, "session=session-42\n");
  } finally {
    await close();
  }
});
test("CLI handles API errors cleanly", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(
      JSON.stringify({
        error: {
          code: "provider_empty_response",
          message:
            "Provider returned an empty response after 1 soft retry and 1 provider-session reset."
        }
      })
    );
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind error server.");
  }
  const stderr = captureStream();
  try {
    const exitCode = await runBridgeCli({
      argv: [
        "--base-url",
        `http://${address.address}:${address.port}`,
        "--session",
        "s1",
        "Run git status"
      ],
      stdout: captureStream(),
      stderr
    });
    assert.equal(exitCode, 1);
    assert.equal(
      stderr.text,
      "provider_empty_response: Provider returned an empty response after 1 soft retry and 1 provider-session reset.\n"
    );
  } finally {
    await closeServer(server);
  }
});
test("CLI health command checks the standalone API", async () => {
  const { baseUrl, close } = await startBridgeApiServer(
    new ScriptedTransport(() => {
      throw new Error("should not be called");
    })
  );
  const output = captureStream();
  try {
    const exitCode = await runBridgeCli({
      argv: ["health", "--base-url", baseUrl],
      stdout: output,
      stderr: captureStream()
    });
    assert.equal(exitCode, 0);
    assert.equal(output.text, "ok\n");
  } finally {
    await close();
  }
});
test("CLI reuses the same server session for repeated session ids", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: createMessagePacket("final", `reply-${callIndex}`),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startBridgeApiServer(transport);
  try {
    await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "shared", "first"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "shared", "second"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.upstreamBinding, null);
    assert.deepEqual(transport.calls[1]?.upstreamBinding, {
      conversationId: "conv-shared",
      parentId: "resp-1"
    });
  } finally {
    await close();
  }
});
test("CLI isolates different session ids", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: createMessagePacket("final", `reply-${request.sessionId}-${callIndex}`),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startBridgeApiServer(transport);
  try {
    await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "one", "first"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "two", "second"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    assert.equal(transport.calls.length, 2);
    assert.equal(transport.calls[0]?.upstreamBinding, null);
    assert.equal(transport.calls[1]?.upstreamBinding, null);
  } finally {
    await close();
  }
});
test("CLI can drive the read flow end to end through the standalone API", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-read-"));
  await writeFile(path.join(runtimeRoot, "notes.txt"), "cli read note", "utf8");
  const transport = new ScriptedTransport((request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createToolRequestPacket({
          id: "call_read",
          name: "read",
          args: {
            path: "notes.txt"
          }
        }),
        upstreamBinding: {
          conversationId: "conv-read",
          parentId: "resp-1"
        }
      };
    }
    return {
      content: createMessagePacket("final", "Read complete."),
      upstreamBinding: {
        conversationId: "conv-read",
        parentId: "resp-2"
      }
    };
  });
  const { baseUrl, close } = await startBridgeApiServer(transport, runtimeRoot);
  const output = captureStream();
  try {
    const exitCode = await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "read-session", "Read the file"],
      stdout: output,
      stderr: captureStream()
    });
    assert.equal(exitCode, 0);
    assert.equal(output.text, "Read complete.\n");
  } finally {
    await close();
  }
});
test("CLI can drive the write flow end to end through the standalone API", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-write-"));
  const targetPath = path.join(runtimeRoot, "created.txt");
  const transport = new ScriptedTransport((_request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createToolRequestPacket({
          id: "call_write",
          name: "write",
          args: {
            path: "created.txt",
            content: "created by cli"
          }
        }),
        upstreamBinding: {
          conversationId: "conv-write",
          parentId: "resp-1"
        }
      };
    }
    return {
      content: createMessagePacket("final", "Write complete."),
      upstreamBinding: {
        conversationId: "conv-write",
        parentId: "resp-2"
      }
    };
  });
  const { baseUrl, close } = await startBridgeApiServer(transport, runtimeRoot);
  try {
    const exitCode = await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "write-session", "Create the file"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    assert.equal(exitCode, 0);
    assert.equal(await readFile(targetPath, "utf8"), "created by cli");
  } finally {
    await close();
  }
});
test("CLI can drive the edit flow end to end through the standalone API", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-edit-"));
  const targetPath = path.join(runtimeRoot, "edit.txt");
  await writeFile(targetPath, "before value", "utf8");
  const transport = new ScriptedTransport((_request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createToolRequestPacket({
          id: "call_edit",
          name: "edit",
          args: {
            path: "edit.txt",
            oldText: "before",
            newText: "after"
          }
        }),
        upstreamBinding: {
          conversationId: "conv-edit",
          parentId: "resp-1"
        }
      };
    }
    return {
      content: createMessagePacket("final", "Edit complete."),
      upstreamBinding: {
        conversationId: "conv-edit",
        parentId: "resp-2"
      }
    };
  });
  const { baseUrl, close } = await startBridgeApiServer(transport, runtimeRoot);
  try {
    const exitCode = await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "edit-session", "Edit the file"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    assert.equal(exitCode, 0);
    assert.equal(await readFile(targetPath, "utf8"), "after value");
  } finally {
    await close();
  }
});
test("CLI can drive the bash flow end to end through the standalone API", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-cli-bash-"));
  const targetPath = path.join(runtimeRoot, "bash.txt");
  const transport = new ScriptedTransport((_request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createToolRequestPacket({
          id: "call_bash",
          name: "bash",
          args: {
            command: `printf 'cli bash' > '${targetPath}'`
          }
        }),
        upstreamBinding: {
          conversationId: "conv-bash",
          parentId: "resp-1"
        }
      };
    }
    return {
      content: createMessagePacket("final", "Bash complete."),
      upstreamBinding: {
        conversationId: "conv-bash",
        parentId: "resp-2"
      }
    };
  });
  const { baseUrl, close } = await startBridgeApiServer(transport, runtimeRoot);
  try {
    const exitCode = await runBridgeCli({
      argv: ["--base-url", baseUrl, "--session", "bash-session", "Run bash"],
      stdout: captureStream(),
      stderr: captureStream()
    });
    assert.equal(exitCode, 0);
    assert.equal(await readFile(targetPath, "utf8"), "cli bash");
  } finally {
    await close();
  }
});
function captureStream() {
  let text = "";
  return {
    write(value: string) {
      text += value;
    },
    get text() {
      return text;
    }
  };
}
async function startBridgeApiServer(transport: ProviderTransport, runtimeRoot?: string) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-cli-state-")),
    runtimeRoot: runtimeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "bridge-cli-runtime-"))),
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
    throw new Error("Failed to bind bridge API server.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    close: () => closeServer(server)
  };
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
