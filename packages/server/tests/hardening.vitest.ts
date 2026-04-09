import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bridgeModule } from "../src/bridge/index.ts";
import { cliModule } from "../src/cli/index.ts";
import type { BridgeServerConfig } from "../src/config/index.ts";
import { configModule } from "../src/config/index.ts";
import type { BridgeApiServerLogger } from "../src/http/index.ts";
import { httpModule } from "../src/http/index.ts";
import { bridgeApiErrorModule } from "../src/shared/bridge-api-error.ts";

const { parseBridgeServerCliArgs, runBridgeServerCli } = cliModule;
const { createLocalSessionPackageStore, createBridgeRuntimeService } = bridgeModule;
const { loadBridgeServerConfig } = configModule;
const { BridgeApiError } = bridgeApiErrorModule;
const { createBridgeApiServer, startBridgeApiServer } = httpModule;
describe("standalone bridge hardening", () => {
  it("defaults the bind host to localhost", () => {
    const config = loadBridgeServerConfig({});
    expect(config.host).toBe("127.0.0.1");
  });
  it("accepts token-protected requests with a correct bearer token", async () => {
    const { baseUrl, close } = await startStandaloneServer({
      authToken: "bridge-secret"
    });
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: {
          Authorization: "Bearer bridge-secret"
        }
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        object: "list",
        data: []
      });
    } finally {
      await close();
    }
  });
  it("rejects token-protected requests without a token", async () => {
    const { baseUrl, close } = await startStandaloneServer({
      authToken: "bridge-secret"
    });
    try {
      const response = await fetch(`${baseUrl}/v1/models`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="bridge-server"');
      expect(await response.json()).toEqual({
        error: {
          code: "unauthorized",
          message: "Bridge authorization failed."
        }
      });
    } finally {
      await close();
    }
  });
  it("rejects token-protected requests with a wrong token", async () => {
    const { baseUrl, close } = await startStandaloneServer({
      authToken: "bridge-secret"
    });
    try {
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: {
          "X-Bridge-Token": "wrong-secret"
        }
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: "unauthorized",
          message: "Bridge authorization failed."
        }
      });
    } finally {
      await close();
    }
  });
  it("keeps health and readiness probes open when auth is enabled", async () => {
    const { baseUrl, close } = await startStandaloneServer({
      authToken: "bridge-secret"
    });
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
      await close();
    }
  });
  it("uses non-wildcard default CORS while preserving localhost and extension origins", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const [localhostResponse, extensionResponse, remoteResponse] = await Promise.all([
        fetch(`${baseUrl}/health`, {
          headers: {
            Origin: "http://127.0.0.1:3000"
          }
        }),
        fetch(`${baseUrl}/health`, {
          headers: {
            Origin: "chrome-extension://bridge-test"
          }
        }),
        fetch(`${baseUrl}/health`, {
          headers: {
            Origin: "https://evil.example"
          }
        })
      ]);
      expect(localhostResponse.headers.get("access-control-allow-origin")).toBe(
        "http://127.0.0.1:3000"
      );
      expect(localhostResponse.headers.get("vary")).toBe("Origin");
      expect(extensionResponse.headers.get("access-control-allow-origin")).toBe(
        "chrome-extension://bridge-test"
      );
      expect(remoteResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await close();
    }
  });
  it("only returns redacted secret-bearing error material", async () => {
    const { baseUrl, close } = await startStandaloneServer(
      {},
      {
        service: createStubService(() => {
          throw new BridgeApiError({
            statusCode: 502,
            code: "provider_failure",
            message: "Authorization: Bearer secret-token cookie=session=secret-cookie",
            details: {
              headers: {
                Authorization: "Bearer secret-token"
              },
              cookies: [
                {
                  name: "session",
                  value: "secret-cookie"
                }
              ],
              localStorage: {
                token: "secret-token"
              },
              bearerToken: "secret-token"
            }
          });
        })
      }
    );
    try {
      await createProvider(baseUrl);
      const response = await postChatCompletion(baseUrl);
      const serialized = JSON.stringify(response.body);
      expect(response.status).toBe(502);
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("secret-cookie");
      expect(response.body).toEqual({
        error: {
          code: "provider_failure",
          message: "Authorization: Bearer [REDACTED] cookie=[REDACTED]",
          details: {
            headers: "[REDACTED]",
            cookies: "[REDACTED]",
            localStorage: "[REDACTED]",
            bearerToken: "[REDACTED]"
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("redacts secrets from internal error logs", async () => {
    const logMessages: string[] = [];
    const logger: BridgeApiServerLogger = {
      warn() {},
      error(message) {
        logMessages.push(message);
      }
    };
    const { baseUrl, close } = await startStandaloneServer(
      {},
      {
        logger,
        service: createStubService(() => {
          throw new Error(
            'Bearer secret-token cookie=session=secret-cookie {"token":"secret-token"}'
          );
        })
      }
    );
    try {
      await createProvider(baseUrl);
      const response = await postChatCompletion(baseUrl);
      const joined = logMessages.join("\n");
      expect(response.status).toBe(500);
      expect(joined).toContain("Bearer [REDACTED]");
      expect(joined).toContain("cookie=[REDACTED]");
      expect(joined).not.toContain("secret-token");
      expect(joined).not.toContain("secret-cookie");
    } finally {
      await close();
    }
  });
  it("prints concise startup warnings for risky local modes", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const exitCode = await runBridgeServerCli({
      argv: ["start", "--foreground", "--host", "0.0.0.0", "--port", "4318"],
      env: {
        BRIDGE_CORS_ORIGINS: "*",
        BRIDGE_SESSION_VAULT_KEY: createTestVaultKey()
      },
      stdout,
      stderr,
      startServer: async () =>
        ({
          address() {
            return {
              address: "0.0.0.0",
              port: 4318
            };
          }
        }) as Awaited<ReturnType<typeof startBridgeApiServer>>
    });
    expect(exitCode).toBe(0);
    expect(stderr.text).toContain("Warning: Bridge auth token is not configured;");
    expect(stderr.text).toContain("Warning: Bridge is binding to non-local host '0.0.0.0'");
    expect(stderr.text).toContain("Warning: Bridge CORS is set to allow any origin;");
    expect(stdout.text).toContain("Bridge server listening on http://0.0.0.0:4318");
  });
  it("fails closed for CLI start when no vault key is configured in non-interactive mode", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-home-"));
    const exitCode = await runBridgeServerCli({
      argv: ["start", "--foreground", "--host", "127.0.0.1", "--port", "4318"],
      env: {
        HOME: homeDir
      },
      stdout,
      stderr,
      stdin: {
        isTTY: false
      } as NodeJS.ReadStream,
      startServer: async () => {
        throw new Error("startServer should not be called");
      }
    });
    expect(exitCode).toBe(1);
    expect(stderr.text).toContain("Session vault key is required.");
  });
  it("accepts an interactively supplied vault key for CLI start", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-home-"));
    const exitCode = await runBridgeServerCli({
      argv: ["start", "--foreground", "--host", "127.0.0.1", "--port", "4318"],
      env: {
        HOME: homeDir
      },
      stdout,
      stderr,
      stdin: {
        isTTY: true
      } as NodeJS.ReadStream,
      promptForVaultKey: async () => createTestVaultKey(),
      startServer: async () =>
        ({
          address() {
            return {
              address: "127.0.0.1",
              port: 4318
            };
          }
        }) as Awaited<ReturnType<typeof startBridgeApiServer>>
    });
    expect(exitCode).toBe(0);
    expect(stdout.text).toContain("Bridge server listening on http://127.0.0.1:4318");
  });
  it("starts detached by default and reports the log path", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-state-"));
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-runtime-"));
    const statePath = path.join(stateRoot, "run", "server-process.json");
    const logPath = path.join(stateRoot, "logs", "server.log");
    const exitCode = await runBridgeServerCli({
      argv: [
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        "4318",
        "--state-root",
        stateRoot,
        "--runtime-root",
        runtimeRoot
      ],
      env: {
        BRIDGE_SESSION_VAULT_KEY: createTestVaultKey()
      },
      stdout,
      stderr,
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        }),
      spawnDetachedServerProcess: async ({ argv, logPath: spawnedLogPath }) => {
        expect(argv).toContain("--foreground");
        expect(spawnedLogPath).toBe(logPath);
        await mkdir(path.dirname(statePath), {
          recursive: true
        });
        await writeFile(
          statePath,
          `${JSON.stringify({
            pid: process.pid,
            baseUrl: "http://127.0.0.1:4318",
            host: "127.0.0.1",
            port: 4318,
            logPath,
            startedAt: "2026-04-09T12:00:00.000Z",
            stateRoot
          })}\n`
        );
        await mkdir(path.dirname(logPath), {
          recursive: true
        });
        await writeFile(logPath, "booted\n", "utf8");
        return {
          pid: process.pid
        };
      }
    });
    expect(exitCode).toBe(0);
    expect(stderr.text).toContain("Warning: Bridge auth token is not configured;");
    expect(stdout.text).toContain("Bridge server started in background");
    expect(stdout.text).toContain("Base URL: http://127.0.0.1:4318");
    expect(stdout.text).toContain(`Logs: ${logPath}`);
  });
  it("prints the requested detached log tail", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-state-"));
    const logPath = path.join(stateRoot, "logs", "server.log");
    await mkdir(path.dirname(logPath), {
      recursive: true
    });
    await writeFile(logPath, "one\ntwo\nthree\n", "utf8");
    const stdout = captureStream();
    const stderr = captureStream();
    const exitCode = await runBridgeServerCli({
      argv: ["logs", "--state-root", stateRoot, "--lines", "2"],
      stdout,
      stderr
    });
    expect(exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toBe("two\nthree\n");
  });
  it("parses the standalone start token flag into bridge config", () => {
    const parsed = parseBridgeServerCliArgs({
      argv: ["start", "--host", "127.0.0.1", "--port", "4318", "--token", "bridge-secret"]
    });
    expect(parsed).toMatchObject({
      kind: "serve",
      config: {
        host: "127.0.0.1",
        port: 4318,
        authToken: "bridge-secret"
      }
    });
  });
  it("parses clear-session-vault into bridge config", () => {
    const parsed = parseBridgeServerCliArgs({
      argv: ["clear-session-vault", "--session-vault-path", "/tmp/bridge-vault"]
    });
    expect(parsed).toMatchObject({
      kind: "clear-session-vault",
      config: {
        sessionVaultPath: path.resolve("/tmp/bridge-vault")
      }
    });
  });
  it("empties the session vault through the CLI without starting the server", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-server-cli-home-"));
    const config = loadBridgeServerConfig({
      HOME: homeDir
    });
    const store = createLocalSessionPackageStore({
      vaultPath: config.sessionVaultPath,
      keyPath: config.sessionVaultKeyPath
    });
    store.put("provider-a", {
      source: "manual",
      capturedAt: "2026-04-02T12:00:00.000Z",
      origin: "https://api.example.test",
      cookies: [
        {
          name: "session",
          value: "secret-cookie"
        }
      ],
      localStorage: {},
      sessionStorage: {},
      headers: {
        Authorization: "Bearer secret-token"
      },
      metadata: {}
    });
    const exitCode = await runBridgeServerCli({
      argv: ["clear-session-vault"],
      env: {
        HOME: homeDir
      },
      stdout,
      stderr,
      startServer: async () => {
        throw new Error("startServer should not be called");
      }
    });
    const reopened = createLocalSessionPackageStore({
      vaultPath: config.sessionVaultPath,
      keyPath: config.sessionVaultKeyPath
    });
    expect(exitCode).toBe(0);
    expect(stderr.text).toBe("");
    expect(stdout.text).toContain(`Emptied session vault at ${config.sessionVaultPath}`);
    expect(reopened.listPackages()).toEqual([]);
    expect(reopened.get("provider-a")).toBeNull();
  });
});
async function startStandaloneServer(
  overrides: Partial<BridgeServerConfig> = {},
  options: {
    service?: ReturnType<typeof createBridgeRuntimeService>;
    logger?: BridgeApiServerLogger;
  } = {}
) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-hardening-state-")),
    runtimeRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-hardening-runtime-")),
    defaultProvider: "session-sse",
    defaultModel: "model-alpha",
    maxSteps: 8,
    ...overrides
  } satisfies BridgeServerConfig;
  if (options.service || options.logger) {
    const server = createBridgeApiServer({
      config,
      service: options.service,
      logger: options.logger
    });
    await listen(server);
    return resolveServerHandle(server);
  }
  const server = await startBridgeApiServer({
    config
  });
  return resolveServerHandle(server);
}
function createStubService(handler: () => never) {
  return {
    respond: handler,
    execute: handler,
    completeChatCompletionPacket: handler,
    streamChatCompletion: handler
  } as unknown as ReturnType<typeof createBridgeRuntimeService>;
}
async function createProvider(baseUrl: string) {
  const response = await fetch(`${baseUrl}/v1/providers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      id: "provider-a",
      kind: "scripted-chat",
      label: "Provider A"
    })
  });
  expect(response.status).toBe(201);
}
async function postChatCompletion(baseUrl: string) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "provider-a/model-beta",
      messages: [
        {
          role: "user",
          content: "hello"
        }
      ]
    })
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>
  };
}
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
function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening");
}
function resolveServerHandle(server: Server) {
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
function createTestVaultKey() {
  return Buffer.alloc(32, 9).toString("base64");
}
