import { mkdtemp } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { httpModule } from "../src/http/index.ts";

const { startBridgeApiServer } = httpModule;
describe("standalone session admin API", () => {
  it("creates a session successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/sessions`, {
        method: "POST",
        body: {
          id: "session-a",
          providerId: "provider-a",
          label: "Session A",
          metadata: {
            locale: "en",
            tags: ["alpha"]
          }
        }
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        session: {
          id: "session-a",
          providerId: "provider-a",
          label: "Session A",
          metadata: {
            locale: "en",
            tags: ["alpha"]
          }
        }
      });
      expect(response.body.session.createdAt).toBe(response.body.session.updatedAt);
      expect(new Date(response.body.session.createdAt).toISOString()).toBe(
        response.body.session.createdAt
      );
    } finally {
      await close();
    }
  });
  it("lists sessions", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createSession(baseUrl, {
        id: "session-a",
        providerId: "provider-a",
        label: "Session A"
      });
      await createSession(baseUrl, {
        id: "session-b",
        label: "Session B",
        metadata: {
          region: "eu"
        }
      });
      const response = await requestJson(`${baseUrl}/v1/sessions`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        sessions: [
          expect.objectContaining({
            id: "session-a",
            providerId: "provider-a",
            label: "Session A",
            metadata: {}
          }),
          expect.objectContaining({
            id: "session-b",
            providerId: null,
            label: "Session B",
            metadata: {
              region: "eu"
            }
          })
        ]
      });
    } finally {
      await close();
    }
  });
  it("gets a session by id", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createSession(baseUrl, {
        id: "session-a",
        providerId: "provider-a",
        label: "Session A",
        metadata: {
          region: "eu"
        }
      });
      const response = await requestJson(`${baseUrl}/v1/sessions/session-a`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        session: created.body.session
      });
    } finally {
      await close();
    }
  });
  it("patches a session successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createSession(baseUrl, {
        id: "session-a",
        providerId: "provider-a",
        label: "Session A",
        metadata: {
          region: "eu"
        }
      });
      const response = await requestJson(`${baseUrl}/v1/sessions/session-a`, {
        method: "PATCH",
        body: {
          providerId: null,
          label: "Session A Prime",
          metadata: {
            region: "us",
            flags: {
              pinned: true
            }
          }
        }
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        session: {
          ...created.body.session,
          providerId: null,
          label: "Session A Prime",
          metadata: {
            region: "us",
            flags: {
              pinned: true
            }
          },
          updatedAt: expect.any(String)
        }
      });
      expect(response.body.session.updatedAt).not.toBe(created.body.session.updatedAt);
    } finally {
      await close();
    }
  });
  it("deletes a session successfully", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createSession(baseUrl, {
        id: "session-a",
        label: "Session A"
      });
      const deleted = await requestJson(`${baseUrl}/v1/sessions/session-a`, {
        method: "DELETE"
      });
      const missing = await requestJson(`${baseUrl}/v1/sessions/session-a`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({
        ok: true,
        id: "session-a"
      });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        error: {
          code: "session_not_found",
          message: "Session 'session-a' was not found."
        }
      });
    } finally {
      await close();
    }
  });
  it("rejects duplicate session ids", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createSession(baseUrl, {
        id: "session-a",
        label: "Session A"
      });
      const duplicate = await requestJson(`${baseUrl}/v1/sessions`, {
        method: "POST",
        body: {
          id: "session-a",
          label: "Session A duplicate"
        }
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toEqual({
        error: {
          code: "session_exists",
          message: "Session 'session-a' already exists."
        }
      });
    } finally {
      await close();
    }
  });
  it("returns 404 for a missing session", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/sessions/missing-session`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: "session_not_found",
          message: "Session 'missing-session' was not found."
        }
      });
    } finally {
      await close();
    }
  });
  it("returns 400 for an invalid session payload", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/sessions`, {
        method: "POST",
        body: {
          id: "session-a",
          providerId: "",
          metadata: []
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
                path: "providerId",
                message: "providerId is required."
              },
              {
                path: "metadata",
                message: "Invalid input: expected object, received array"
              }
            ]
          }
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
async function createSession(
  baseUrl: string,
  session: {
    id: string;
    providerId?: string | null;
    label?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  return requestJson(`${baseUrl}/v1/sessions`, {
    method: "POST",
    body: session
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
