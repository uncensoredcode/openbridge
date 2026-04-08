import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { httpModule } from "../src/http/index.ts";

const { startBridgeApiServer } = httpModule;
describe("standalone model discovery API", () => {
  it("returns an empty models list successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/models`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        object: "list",
        data: []
      });
    } finally {
      await close();
    }
  });
  it("lists enabled provider models in a stable OpenAI-style shape", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const providerA = await createProvider(baseUrl, {
        id: "provider-a",
        kind: "scripted-chat",
        label: "Provider A",
        config: {
          models: ["alpha-model"]
        }
      });
      const providerB = await createProvider(baseUrl, {
        id: "provider-b",
        kind: "mock",
        label: "Provider B",
        config: {
          models: ["beta", " alpha ", "beta", ""]
        }
      });
      await createProvider(baseUrl, {
        id: "provider-c",
        kind: "mock",
        label: "Provider C"
      });
      await createProvider(baseUrl, {
        id: "provider-d",
        kind: "session-sse",
        label: "Provider D",
        enabled: false
      });
      const response = await requestJson(`${baseUrl}/v1/models`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        object: "list",
        data: [
          {
            id: "provider-a/alpha-model",
            object: "model",
            created: toUnixTimestamp(providerA.body.provider.createdAt),
            owned_by: "provider-a"
          },
          {
            id: "provider-b/alpha",
            object: "model",
            created: toUnixTimestamp(providerB.body.provider.createdAt),
            owned_by: "provider-b"
          },
          {
            id: "provider-b/beta",
            object: "model",
            created: toUnixTimestamp(providerB.body.provider.createdAt),
            owned_by: "provider-b"
          }
        ]
      });
    } finally {
      await close();
    }
  });
  it("returns the same model listing across repeated reads", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "session-sse",
        label: "Provider A"
      });
      const first = await requestJson(`${baseUrl}/v1/models`);
      const second = await requestJson(`${baseUrl}/v1/models`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
    } finally {
      await close();
    }
  });
  it("returns no models when no explicit model config is set", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const provider = await createProvider(baseUrl, {
        id: "provider-a",
        kind: "session-sse",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/models`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        object: "list",
        data: []
      });
    } finally {
      await close();
    }
  });
  it("adds a model to an existing provider without clobbering other config", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "http-sse",
        label: "Provider A",
        config: {
          transport: {
            prompt: {
              mode: "auto_join"
            },
            session: {
              requireCookie: true,
              requireBearerToken: false,
              requireUserAgent: false,
              includeExtraHeaders: true
            },
            request: {
              method: "POST",
              url: "https://api.example.test/chat"
            },
            response: {
              contentPaths: ["content"],
              responseIdPaths: ["id"],
              trimLeadingAssistantBlock: true
            }
          }
        }
      });
      const added = await requestJson(`${baseUrl}/v1/models`, {
        method: "POST",
        body: {
          provider: "provider-a",
          model: "model-alpha"
        }
      });
      const provider = await requestJson(`${baseUrl}/v1/providers/provider-a`);
      const models = await requestJson(`${baseUrl}/v1/models`);
      expect(added.status).toBe(201);
      expect(added.body).toEqual({
        ok: true,
        providerId: "provider-a",
        modelId: "model-alpha"
      });
      expect(provider.status).toBe(200);
      expect(provider.body.provider.config).toEqual({
        transport: {
          prompt: {
            mode: "auto_join"
          },
          session: {
            requireCookie: true,
            requireBearerToken: false,
            requireUserAgent: false,
            includeExtraHeaders: true
          },
          request: {
            method: "POST",
            url: "https://api.example.test/chat"
          },
          response: {
            contentPaths: ["content"],
            responseIdPaths: ["id"],
            trimLeadingAssistantBlock: true
          }
        },
        models: ["model-alpha"]
      });
      expect(models.status).toBe(200);
      expect(models.body.data).toEqual([
        {
          id: "provider-a/model-alpha",
          object: "model",
          created: expect.any(Number),
          owned_by: "provider-a"
        }
      ]);
    } finally {
      await close();
    }
  });
  it("returns 404 when adding a model to a missing provider", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/models`, {
        method: "POST",
        body: {
          provider: "missing-provider",
          model: "model-alpha"
        }
      });
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
});
async function startStandaloneServer() {
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
function toUnixTimestamp(value: string) {
  return Math.floor(Date.parse(value) / 1000);
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
