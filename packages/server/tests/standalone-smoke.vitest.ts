import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cliModule } from "../src/cli/index.ts";
import { httpModule } from "../src/http/index.ts";

const { runBridgeServerCli } = cliModule;
const { startBridgeApiServer } = httpModule;
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
describe("standalone bridge smoke", () => {
  it("boots a local server and serves health endpoints", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-runtime-"));
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-state-"));
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
    const baseUrl = `http://${address.address}:${address.port}`;
    try {
      const [healthResponse, readyResponse] = await Promise.all([
        fetch(`${baseUrl}/health`),
        fetch(`${baseUrl}/ready`)
      ]);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ ok: true });
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ ok: true });
    } finally {
      await closeServer(server);
    }
  });
  it("starts through the standalone bridge CLI path", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-home-"));
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-runtime-"));
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-state-"));
    const sessionVaultPath = path.join(homeDir, ".bridge", "server", "session-vault");
    const stdout = captureStream();
    const stderr = captureStream();
    const startedServerRef: {
      current: Server | null;
    } = { current: null };
    const exitCode = await runBridgeServerCli({
      argv: ["start", "--host", "127.0.0.1", "--port", "0"],
      env: {
        HOME: homeDir,
        BRIDGE_RUNTIME_ROOT: runtimeRoot,
        BRIDGE_STATE_ROOT: stateRoot,
        BRIDGE_SESSION_VAULT_PATH: sessionVaultPath,
        BRIDGE_SESSION_VAULT_KEY: createTestVaultKey(),
        BRIDGE_PROVIDER: "session-sse",
        BRIDGE_MODEL: "model-alpha"
      },
      stdout,
      stderr,
      onServerStarted(server) {
        startedServerRef.current = server;
      }
    });
    try {
      const address = startedServerRef.current?.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind bridge server through CLI.");
      }
      const baseUrl = `http://${address.address}:${address.port}`;
      expect(exitCode).toBe(0);
      expect(stderr.text).toContain("Warning: Bridge auth token is not configured;");
      expect(stdout.text).toContain(`Bridge server listening on ${baseUrl}`);
      const [healthResponse, readyResponse] = await Promise.all([
        fetch(`${baseUrl}/health`),
        fetch(`${baseUrl}/ready`)
      ]);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({ ok: true });
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ ok: true });
    } finally {
      if (startedServerRef.current) {
        await closeServer(startedServerRef.current);
      }
    }
  });
});
function createTestVaultKey() {
  return Buffer.alloc(32, 7).toString("base64");
}
