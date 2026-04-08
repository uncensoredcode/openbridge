import crypto from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { bridgeModule } from "../src/bridge/index.ts";

const { createLocalSessionPackageStore } = bridgeModule;
describe("legacy session vault compatibility", () => {
  it("loads a legacy index and legacy session-only entry without aborting startup", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-legacy-vault-"));
    const keyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-legacy-key-")),
      "vault.key"
    );
    const store = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    const payload = createSessionPackagePayload();
    const stored = store.put("provider-a", payload);
    const key = Buffer.from((await readFile(keyPath, "utf8")).trim(), "base64");
    const entryPath = path.join(vaultPath, "entries", `${stored.handle}.json`);
    const indexPath = path.join(vaultPath, "index.json");
    const currentEntry = JSON.parse(await readFile(entryPath, "utf8")) as Record<string, unknown>;
    const currentIndex = JSON.parse(await readFile(indexPath, "utf8")) as {
      version: number;
      sessions: Record<string, Record<string, unknown>>;
    };
    const legacyMetadata = {
      ...currentIndex.sessions["provider-a"]
    };
    delete legacyMetadata.hasSessionPackage;
    await writeFile(
      indexPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: {
            "provider-a": legacyMetadata
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const legacyEntry = encryptLegacySessionEntry({
      key,
      providerId: "provider-a",
      handle: stored.handle,
      metadata: legacyMetadata,
      session: payload
    });
    await writeFile(entryPath, `${JSON.stringify(legacyEntry, null, 2)}\n`, "utf8");
    const reopened = createLocalSessionPackageStore({
      vaultPath,
      keyPath
    });
    expect(reopened.getStatus("provider-a")).toMatchObject({
      providerId: "provider-a",
      hasSessionPackage: true,
      source: "manual"
    });
    expect(reopened.get("provider-a")).toEqual(payload);
    expect(reopened.getProvider("provider-a")).toMatchObject({
      id: "provider-a",
      enabled: true
    });
  });
});
function encryptLegacySessionEntry(input: {
  key: Buffer;
  providerId: string;
  handle: string;
  metadata: Record<string, unknown>;
  session: ReturnType<typeof createSessionPackagePayload>;
}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", input.key, iv);
  const plaintext = Buffer.from(JSON.stringify(input.session), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    handle: input.handle,
    providerId: input.providerId,
    metadata: input.metadata,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}
function createSessionPackagePayload() {
  return {
    source: "manual",
    capturedAt: "2026-04-02T12:00:00.000Z",
    origin: "https://api.example.test",
    cookies: [
      {
        name: "session",
        value: "secret-cookie"
      }
    ],
    localStorage: {
      token: "secret-token"
    },
    sessionStorage: {},
    headers: {
      Authorization: "Bearer secret-token"
    },
    metadata: {
      browser: "Chrome"
    }
  };
}
