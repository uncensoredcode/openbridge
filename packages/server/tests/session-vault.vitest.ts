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
