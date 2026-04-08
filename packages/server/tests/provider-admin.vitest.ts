import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { httpModule } from "../src/http/index.ts";

const { startBridgeApiServer } = httpModule;
describe("standalone provider admin API", () => {
  it("creates a provider successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers`, {
        method: "POST",
        body: {
          id: "provider-a",
          kind: "mock",
          label: "Provider A",
          enabled: true,
          config: {
            token: "secret"
          }
        }
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        provider: {
          id: "provider-a",
          kind: "mock",
          label: "Provider A",
          enabled: true,
          config: {
            token: "secret"
          }
        }
      });
      expect(response.body.provider.createdAt).toBe(response.body.provider.updatedAt);
      expect(new Date(response.body.provider.createdAt).toISOString()).toBe(
        response.body.provider.createdAt
      );
    } finally {
      await close();
    }
  });
  it("lists providers", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      await createProvider(baseUrl, {
        id: "provider-b",
        kind: "mock",
        label: "Provider B"
      });
      const response = await requestJson(`${baseUrl}/v1/providers`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        providers: [
          expect.objectContaining({
            id: "provider-a",
            kind: "mock",
            label: "Provider A",
            enabled: true,
            config: {}
          }),
          expect.objectContaining({
            id: "provider-b",
            kind: "mock",
            label: "Provider B",
            enabled: true,
            config: {}
          })
        ]
      });
    } finally {
      await close();
    }
  });
  it("gets a provider by id", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A",
        enabled: false,
        config: {
          region: "eu"
        }
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        provider: created.body.provider
      });
    } finally {
      await close();
    }
  });
  it("patches a provider successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a`, {
        method: "PATCH",
        body: {
          label: "Provider A Prime",
          enabled: false,
          config: {
            region: "us"
          }
        }
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        provider: {
          ...created.body.provider,
          label: "Provider A Prime",
          enabled: false,
          config: {
            region: "us"
          },
          updatedAt: expect.any(String)
        }
      });
      expect(response.body.provider.updatedAt).not.toBe(created.body.provider.updatedAt);
    } finally {
      await close();
    }
  });
  it("deletes a provider successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const deleted = await requestJson(`${baseUrl}/v1/providers/provider-a`, {
        method: "DELETE"
      });
      const missing = await requestJson(`${baseUrl}/v1/providers/provider-a`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({
        ok: true,
        id: "provider-a"
      });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        error: {
          code: "provider_not_found",
          message: "Provider 'provider-a' was not found."
        }
      });
    } finally {
      await close();
    }
  });
  it("rejects duplicate provider ids", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const duplicate = await requestJson(`${baseUrl}/v1/providers`, {
        method: "POST",
        body: {
          id: "provider-a",
          kind: "mock",
          label: "Provider A duplicate"
        }
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toEqual({
        error: {
          code: "provider_exists",
          message: "Provider 'provider-a' already exists."
        }
      });
    } finally {
      await close();
    }
  });
  it("returns 404 for a missing provider", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/missing-provider`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: "provider_not_found",
          message: "Provider 'missing-provider' was not found."
        }
      });
    } finally {
      await close();
    }
  });
  it("returns 400 for an invalid provider payload", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers`, {
        method: "POST",
        body: {
          id: "provider-a",
          kind: "mock",
          label: "   "
        }
      });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_request",
          message: "Request validation failed.",
          details: {
            issues: [
              {
                path: "label",
                message: "label is required."
              }
            ]
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("persists providers across server restarts with the same vault path", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-runtime-"));
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-state-"));
    const sessionVaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const sessionVaultKeyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const firstServer = await startStandaloneServer({
      runtimeRoot,
      stateRoot,
      sessionVaultPath,
      sessionVaultKeyPath
    });
    try {
      const created = await createProvider(firstServer.baseUrl, {
        id: "provider-a",
        kind: "session-sse",
        label: "Example"
      });
      expect(created.status).toBe(201);
    } finally {
      await firstServer.close();
    }
    const secondServer = await startStandaloneServer({
      runtimeRoot,
      stateRoot,
      sessionVaultPath,
      sessionVaultKeyPath
    });
    try {
      const listed = await requestJson(`${secondServer.baseUrl}/v1/providers`);
      const fetched = await requestJson(`${secondServer.baseUrl}/v1/providers/provider-a`);
      expect(listed.status).toBe(200);
      expect(listed.body.providers).toEqual([
        expect.objectContaining({
          id: "provider-a",
          kind: "session-sse",
          label: "Example",
          enabled: true
        })
      ]);
      expect(fetched.status).toBe(200);
      expect(fetched.body.provider).toMatchObject({
        id: "provider-a",
        kind: "session-sse",
        label: "Example"
      });
    } finally {
      await secondServer.close();
    }
  });
});
async function startStandaloneServer(
  overrides: Partial<{
    runtimeRoot: string;
    stateRoot: string;
    sessionVaultPath: string;
    sessionVaultKeyPath: string;
  }> = {}
) {
  const runtimeRoot =
    overrides.runtimeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "bridge-server-runtime-")));
  const stateRoot =
    overrides.stateRoot ?? (await mkdtemp(path.join(os.tmpdir(), "bridge-server-state-")));
  const sessionVaultPath =
    overrides.sessionVaultPath ?? (await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-")));
  const sessionVaultKeyPath =
    overrides.sessionVaultKeyPath ??
    path.join(await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")), "vault.key");
  const server = await startBridgeApiServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      runtimeRoot,
      stateRoot,
      sessionVaultPath,
      sessionVaultKeyPath,
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
  return requestJson(`${baseUrl}/v1/providers`, {
    method: "POST",
    body: provider
  });
}
async function requestJson(
  url: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {}
) {
  const headers = options.body
    ? {
        "Content-Type": "application/json"
      }
    : undefined;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>
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
