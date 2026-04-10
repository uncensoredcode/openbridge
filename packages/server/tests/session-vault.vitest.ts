import crypto from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bridgeModule } from "../src/bridge/index.ts";
import { configModule } from "../src/config/index.ts";

const { clearLocalSessionVault, createLocalSessionPackageStore, SessionPackageVaultError } =
  bridgeModule;
const { loadBridgeServerConfig } = configModule;
describe("local session vault", () => {
  it("defaults the vault to a stable app-state path outside disposable build output", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "bridge-server-home-"));
    const config = loadBridgeServerConfig(
      {
        HOME: homeDir
      },
      {
        stateRoot: path.join(homeDir, "workspace", ".bridge-server"),
        runtimeRoot: path.join(homeDir, "workspace")
      }
    );
    expect(config.sessionVaultPath).toBe(path.join(homeDir, ".bridge", "server", "session-vault"));
    expect(config.sessionVaultKeyPath).toBe(
      path.join(homeDir, ".bridge", "server", "keys", "session-vault.key")
    );
    expect(config.sessionVaultPath.startsWith(config.stateRoot)).toBe(false);
    expect(config.sessionVaultPath.includes(`${path.sep}dist${path.sep}`)).toBe(false);
  });
  it("survives store reinitialization and reads through an opaque handle-backed entry", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const firstStore = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    const stored = firstStore.put("provider-a", createSessionPackagePayload());
    const secondStore = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(secondStore.get("provider-a")).toEqual(createSessionPackagePayload());
    expect(secondStore.getStatus("provider-a")).toMatchObject({
      handle: stored.handle,
      providerId: "provider-a",
      status: "active"
    });
    const entryFiles = await readdir(path.join(vaultPath, "entries"));
    expect(entryFiles).toEqual([`${stored.handle}.json`]);
    expect(entryFiles[0]).not.toContain("provider-a");
  });
  it("rejects corrupted ciphertext and does not expose raw session material in the error", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    const metadata = store.put("provider-a", createSessionPackagePayload());
    const entryPath = path.join(vaultPath, "entries", `${metadata.handle}.json`);
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as Record<string, string>;
    entry.ciphertext = `${entry.ciphertext.slice(0, -4)}AAAA`;
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(() => reopened.get("provider-a")).toThrow(SessionPackageVaultError);
    expect(() => reopened.get("provider-a")).toThrow(/ciphertext is unreadable/i);
    expect(() => reopened.get("provider-a")).not.toThrow(/secret-cookie|secret-token/);
  });
  it("fails closed for expired lifecycle metadata", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    store.put(
      "provider-a",
      createSessionPackagePayload({
        metadata: {
          absoluteExpiresAt: "2026-04-01T00:00:00.000Z"
        }
      })
    );
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath,
      now: () => "2026-04-05T00:00:00.000Z"
    });
    expect(reopened.get("provider-a")).toBeNull();
    expect(reopened.getStatus("provider-a")).toMatchObject({
      status: "active",
      absoluteExpiresAt: "2026-04-01T00:00:00.000Z"
    });
  });
  it("keeps the previously committed secret when an update fails before rename", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const original = createSessionPackagePayload();
    const updated = createSessionPackagePayload({
      cookies: [
        {
          name: "session",
          value: "new-secret-cookie"
        }
      ],
      localStorage: {
        token: "new-secret-token"
      },
      headers: {
        Authorization: "Bearer new-secret-token"
      }
    });
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    const metadata = store.put("provider-a", original);
    const failingStore = createLocalSessionPackageStore({
      vaultPath,
      keyPath,
      testHooks: {
        afterTempWrite(targetPath) {
          if (targetPath.endsWith(`${metadata.handle}.json`)) {
            throw new Error("simulated commit interruption");
          }
        }
      }
    });
    expect(() => failingStore.put("provider-a", updated)).toThrow(SessionPackageVaultError);
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(reopened.get("provider-a")).toEqual(original);
    const entryFiles = await readdir(path.join(vaultPath, "entries"));
    expect(entryFiles.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    const persisted = await readFile(
      path.join(vaultPath, "entries", `${metadata.handle}.json`),
      "utf8"
    );
    expect(persisted).not.toContain("new-secret-cookie");
    expect(persisted).not.toContain("new-secret-token");
  });
  it("normalizes stale installed Qwen request templates when reopening the vault", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    const payload = createQwenSessionPackagePayload();
    const metadata = store.put("chat-qwen-ai", payload);
    const key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    const entryPath = path.join(vaultPath, "entries", `${metadata.handle}.json`);
    const entry = JSON.parse(await readFile(entryPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      entryPath,
      `${JSON.stringify(
        encryptVaultPayload(key, {
          ...entry,
          ciphertextPayload: {
            provider: {
              id: "chat-qwen-ai",
              kind: "http-sse",
              label: "Qwen Studio",
              enabled: true,
              config: {
                models: ["qwen3.6-plus"],
                transport: {
                  request: {
                    method: "POST",
                    url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id={{conversationId}}",
                    body: {
                      chat_id: "{{conversationIdOrOmit}}",
                      model: "{{modelId}}",
                      parent_id: null,
                      messages: [
                        {
                          fid: "{{messageId}}",
                          parentId: null,
                          childrenIds: ["captured-child"],
                          role: "user",
                          content: "{{prompt}}",
                          timestamp: "{{unixTimestampSec}}",
                          models: ["{{modelId}}"],
                          parent_id: null
                        }
                      ],
                      timestamp: "{{unixTimestampSec}}"
                    }
                  }
                }
              },
              createdAt: "2026-04-10T10:32:29.574Z",
              updatedAt: "2026-04-10T10:32:29.574Z"
            },
            session: payload
          }
        }),
        null,
        2
      )}\n`,
      "utf8"
    );
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(reopened.getProvider("chat-qwen-ai")).toMatchObject({
      config: {
        transport: {
          request: {
            body: {
              chat_id: "{{conversationId}}",
              parent_id: "{{parentIdOrNull}}",
              messages: [
                {
                  parentId: "{{parentIdOrNull}}",
                  parent_id: "{{parentIdOrNull}}",
                  childrenIds: []
                }
              ]
            }
          }
        }
      }
    });
  });
  it("rejects invalid vault contents safely", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    const metadata = store.put("provider-a", createSessionPackagePayload());
    await writeFile(
      path.join(vaultPath, "entries", `${metadata.handle}.json`),
      "{not-json}\n",
      "utf8"
    );
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(() => reopened.get("provider-a")).toThrow(SessionPackageVaultError);
    expect(() => reopened.get("provider-a")).toThrow(/entry is invalid/i);
  });
  it("empties stored sessions while keeping the vault key material intact", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    store.put("provider-a", createSessionPackagePayload());
    store.put(
      "provider-b",
      createSessionPackagePayload({
        headers: {
          Authorization: "Bearer another-secret-token"
        }
      })
    );
    const originalKey = await readFile(keyPath, "utf8");
    clearLocalSessionVault({
      vaultPath
    });
    const entryFiles = await readdir(path.join(vaultPath, "entries"));
    const index = JSON.parse(await readFile(path.join(vaultPath, "index.json"), "utf8")) as {
      version: number;
      sessions: Record<string, unknown>;
    };
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(entryFiles).toEqual([]);
    expect(index).toEqual({
      version: 1,
      sessions: {}
    });
    expect(await readFile(keyPath, "utf8")).toBe(originalKey);
    expect(reopened.listProviders()).toEqual([]);
    expect(reopened.listPackages()).toEqual([]);
    expect(reopened.get("provider-a")).toBeNull();
    expect(reopened.getStatus("provider-a")).toBeNull();
  });
});
function encryptVaultPayload(
  key: Buffer,
  input: Record<string, unknown> & {
    ciphertextPayload: unknown;
  }
) {
  const iv = Buffer.from(String(input.iv), "base64");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(input.ciphertextPayload), "utf8")),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  const { ciphertextPayload: _ciphertextPayload, ...rest } = input;
  return {
    ...rest,
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}
function createSessionPackagePayload(
  overrides: Partial<{
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, unknown>;
    headers: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }> = {}
) {
  return {
    source: "manual",
    capturedAt: "2026-04-02T12:00:00.000Z",
    origin: "https://api.example.test",
    cookies: overrides.cookies ?? [
      {
        name: "session",
        value: "secret-cookie"
      }
    ],
    localStorage: overrides.localStorage ?? {
      token: "secret-token"
    },
    sessionStorage: {},
    headers: overrides.headers ?? {
      Authorization: "Bearer secret-token"
    },
    metadata: overrides.metadata ?? {
      browser: "Chrome"
    }
  };
}
function createQwenSessionPackagePayload() {
  return {
    source: "browser-extension",
    capturedAt: "2026-04-10T10:31:34.333Z",
    origin: "https://chat.qwen.ai",
    cookies: [
      {
        name: "session",
        value: "secret-cookie"
      }
    ],
    localStorage: {},
    sessionStorage: {},
    headers: {
      "User-Agent": "Captured UA"
    },
    metadata: {
      browser: "Chrome",
      requestCapture: {
        requests: [
          {
            url: "https://chat.qwen.ai/api/v2/chats/new",
            method: "POST",
            requestHeaders: {
              Accept: "application/json, text/plain, */*",
              "Content-Type": "application/json",
              Origin: "https://chat.qwen.ai",
              Referer: "https://chat.qwen.ai/c/new-chat"
            }
          }
        ],
        selectedRequest: {
          url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id=ba6ae33a-0011-4a13-bded-082bd1bc0e5f",
          method: "POST",
          modelHints: ["qwen3.6-plus"],
          requestBodyJson: {
            stream: true,
            version: "2.1",
            incremental_output: true,
            chat_id: "ba6ae33a-0011-4a13-bded-082bd1bc0e5f",
            chat_mode: "normal",
            model: "qwen3.6-plus",
            parent_id: null,
            messages: [
              {
                fid: "80e81cff-64cf-4bc7-8699-bd2ba37d2a73",
                parentId: null,
                childrenIds: ["aa22e91e-da32-4abd-bd27-6a165da87440"],
                role: "user",
                content: "Hello?",
                user_action: "chat",
                files: [],
                timestamp: 1775817091,
                models: ["qwen3.6-plus"],
                chat_type: "t2t",
                sub_chat_type: "t2t",
                parent_id: null
              }
            ],
            timestamp: 1775817094
          }
        }
      }
    },
    integration: {
      label: "Qwen Studio",
      models: ["qwen3.6-plus"]
    }
  };
}
