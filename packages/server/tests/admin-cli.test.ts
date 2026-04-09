import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cliModule } from "../src/cli/index.ts";
import { httpModule } from "../src/http/index.ts";

const { parseBridgeServerCliArgs, runBridgeServerCli } = cliModule;
const { startBridgeApiServer } = httpModule;

test("argument parser supports grouped provider admin commands", () => {
  const parsed = parseBridgeServerCliArgs({
    argv: ["providers", "session-status", "provider-a", "--base-url", "http://127.0.0.1:4318"]
  });
  assert.deepEqual(parsed, {
    kind: "providers-session-status",
    baseUrl: "http://127.0.0.1:4318",
    id: "provider-a"
  });
});

test("provider admin CLI can add a provider and import a session package", async () => {
  const { baseUrl, close } = await startStandaloneServer();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-admin-"));
  const sessionFile = path.join(tempRoot, "session-package.json");
  await writeFile(
    sessionFile,
    JSON.stringify(
      {
        source: "manual",
        capturedAt: "2026-04-02T12:00:00.000Z",
        origin: "https://api.example.test",
        cookies: [],
        localStorage: {},
        sessionStorage: {},
        headers: {},
        metadata: {}
      },
      null,
      2
    ),
    "utf8"
  );
  try {
    const addStdout = captureStream();
    const addExitCode = await runBridgeServerCli({
      argv: [
        "providers",
        "add",
        "--base-url",
        baseUrl,
        "--id",
        "provider-a",
        "--kind",
        "mock",
        "--label",
        "Provider A"
      ],
      stdout: addStdout,
      stderr: captureStream()
    });
    assert.equal(addExitCode, 0);
    assert.equal(JSON.parse(addStdout.text).provider.id, "provider-a");

    const importStdout = captureStream();
    const importExitCode = await runBridgeServerCli({
      argv: [
        "providers",
        "import-session",
        "provider-a",
        "--base-url",
        baseUrl,
        "--file",
        sessionFile
      ],
      stdout: importStdout,
      stderr: captureStream()
    });
    assert.equal(importExitCode, 0);
    assert.equal(JSON.parse(importStdout.text).hasSessionPackage, true);

    const statusStdout = captureStream();
    const statusExitCode = await runBridgeServerCli({
      argv: ["providers", "session-status", "provider-a", "--base-url", baseUrl],
      stdout: statusStdout,
      stderr: captureStream()
    });
    assert.equal(statusExitCode, 0);
    assert.deepEqual(JSON.parse(statusStdout.text), {
      ok: true,
      providerId: "provider-a",
      hasSessionPackage: true,
      source: "manual",
      capturedAt: "2026-04-02T12:00:00.000Z",
      origin: "https://api.example.test"
    });
  } finally {
    await close();
  }
});

test("model and session admin CLI print JSON responses", async () => {
  const { baseUrl, close } = await startStandaloneServer();
  try {
    const providerStdout = captureStream();
    const providerExitCode = await runBridgeServerCli({
      argv: [
        "providers",
        "add",
        "--base-url",
        baseUrl,
        "--id",
        "provider-a",
        "--kind",
        "mock",
        "--label",
        "Provider A"
      ],
      stdout: providerStdout,
      stderr: captureStream()
    });
    assert.equal(providerExitCode, 0);

    const addModelStdout = captureStream();
    const addModelExitCode = await runBridgeServerCli({
      argv: [
        "models",
        "add",
        "--base-url",
        baseUrl,
        "--provider",
        "provider-a",
        "--model",
        "model-alpha"
      ],
      stdout: addModelStdout,
      stderr: captureStream()
    });
    assert.equal(addModelExitCode, 0);
    assert.deepEqual(JSON.parse(addModelStdout.text), {
      ok: true,
      providerId: "provider-a",
      modelId: "model-alpha"
    });

    const modelsStdout = captureStream();
    const modelsExitCode = await runBridgeServerCli({
      argv: ["models", "list", "--base-url", baseUrl],
      stdout: modelsStdout,
      stderr: captureStream()
    });
    assert.equal(modelsExitCode, 0);
    const models = JSON.parse(modelsStdout.text) as {
      object: string;
      data: Array<{
        id: string;
        object: string;
        created: number;
        owned_by: string;
      }>;
    };
    assert.equal(models.object, "list");
    assert.equal(models.data.length, 1);
    assert.equal(models.data[0]?.id, "provider-a/model-alpha");
    assert.equal(models.data[0]?.object, "model");
    assert.equal(typeof models.data[0]?.created, "number");
    assert.equal(models.data[0]?.owned_by, "provider-a");

    const sessionsStdout = captureStream();
    const sessionsExitCode = await runBridgeServerCli({
      argv: ["sessions", "list", "--base-url", baseUrl],
      stdout: sessionsStdout,
      stderr: captureStream()
    });
    assert.equal(sessionsExitCode, 0);
    assert.deepEqual(JSON.parse(sessionsStdout.text), {
      sessions: []
    });
  } finally {
    await close();
  }
});

function captureStream() {
  let text = "";
  return {
    get text() {
      return text;
    },
    write(value: string) {
      text += value;
    }
  };
}

async function startStandaloneServer() {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-runtime-"));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-state-"));
  const server = await startBridgeApiServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      runtimeRoot,
      stateRoot,
      defaultProvider: "session-sse",
      defaultModel: "model-alpha",
      maxSteps: 8
    }
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind bridge server.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    close: () => closeServer(server)
  };
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
