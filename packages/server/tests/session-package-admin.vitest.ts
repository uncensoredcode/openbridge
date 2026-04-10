import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { httpModule } from "../src/http/index.ts";

const { startBridgeApiServer } = httpModule;
describe("standalone provider session-package API", () => {
  it("stores a provider-owned session package and returns safe status on PUT", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: createSessionPackagePayload()
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
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
  it("returns safe session-package status on GET without leaking secrets", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: createSessionPackagePayload()
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        providerId: "provider-a",
        hasSessionPackage: true,
        source: "manual",
        capturedAt: "2026-04-02T12:00:00.000Z",
        origin: "https://api.example.test"
      });
      expect(response.body.cookies).toBeUndefined();
      expect(response.body.headers).toBeUndefined();
      expect(response.body.localStorage).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain("session=secret-cookie");
      expect(JSON.stringify(response.body)).not.toContain("secret-token");
    } finally {
      await close();
    }
  });
  it("deletes a provider-owned session package cleanly", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: createSessionPackagePayload()
      });
      const deleted = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "DELETE"
      });
      const missing = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({
        ok: true,
        providerId: "provider-a"
      });
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        error: {
          code: "session_package_not_found",
          message: "Provider 'provider-a' does not have a session package."
        }
      });
    } finally {
      await close();
    }
  });
  it("returns 404 when a provider session package is missing", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: "session_package_not_found",
          message: "Provider 'provider-a' does not have a session package."
        }
      });
    } finally {
      await close();
    }
  });
  it("returns 404 when PUT targets a missing provider", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: createSessionPackagePayload()
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
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
  it("returns 400 for an invalid session-package payload", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: {
          source: "manual",
          capturedAt: "not-a-timestamp",
          origin: "not-a-url",
          cookies: {},
          localStorage: [],
          headers: "x",
          metadata: {}
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
                path: "capturedAt",
                message: "Invalid ISO datetime"
              },
              {
                path: "origin",
                message: "Invalid URL"
              },
              {
                path: "cookies",
                message: "Invalid input: expected array, received object"
              },
              {
                path: "localStorage",
                message: "Invalid input: expected object, received array"
              },
              {
                path: "headers",
                message: "Invalid input: expected object, received string"
              }
            ]
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("accepts larger session-package uploads for browser captures", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          localStorage: {
            giantSnapshot: "x".repeat(2 * 1024 * 1024)
          }
        }
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
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
  it("infers models from an extension-style request capture on install", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/chat-example/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.example.test",
          metadata: {
            browser: "Chrome",
            selectedRequest: {
              url: "https://chat.example.test/api/chat/completions",
              method: "POST",
              modelHints: ["model-alpha"]
            },
            requestCapture: {
              selectedRequest: {
                url: "https://chat.example.test/api/chat/completions",
                method: "POST",
                inferred: {
                  modelHints: ["model-alpha"],
                  usesSse: true
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const providers = await requestJson(`${baseUrl}/v1/providers`);
      expect(providers.status).toBe(200);
      expect(providers.body).toEqual({
        providers: [
          expect.objectContaining({
            id: "chat-example",
            kind: "http-sse",
            config: expect.objectContaining({
              models: ["model-alpha"]
            })
          })
        ]
      });
      const models = await requestJson(`${baseUrl}/v1/models`);
      expect(models.status).toBe(200);
      expect(models.body).toEqual({
        object: "list",
        data: [
          {
            id: "chat-example/model-alpha",
            object: "model",
            created: expect.any(Number),
            owned_by: "chat-example"
          }
        ]
      });
    } finally {
      await close();
    }
  });
  it("infers ChatGPT conversation transport from an OpenAI web capture", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/openai-chat/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chatgpt.com",
          headers: {
            Authorization: "Bearer secret-token",
            "User-Agent": "Captured UA",
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            "oai-session-id": "session-1",
            "openai-sentinel-chat-requirements-token": "sentinel-1"
          },
          metadata: {
            browser: "Chrome",
            requestCapture: {
              selectedRequest: {
                url: "https://chatgpt.com/backend-api/f/conversation",
                method: "POST",
                modelHints: ["auto"],
                inferred: {
                  usesSse: true,
                  modelHints: ["auto"]
                },
                requestBodyJson: {
                  action: "next",
                  messages: [
                    {
                      id: "captured-message-id",
                      author: {
                        role: "user"
                      },
                      create_time: 1775555294,
                      content: {
                        content_type: "text",
                        parts: ["2*2?"]
                      },
                      metadata: {
                        selected_github_repos: [],
                        selected_all_github_repos: false,
                        serialization_metadata: {
                          custom_symbol_offsets: []
                        }
                      }
                    }
                  ],
                  parent_message_id: "client-created-root",
                  model: "auto",
                  timezone: "Europe/Madrid",
                  supports_buffering: true,
                  supported_encodings: ["v1"]
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/openai-chat`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "openai-chat",
        kind: "http-sse",
        config: {
          models: ["auto"],
          transport: {
            binding: {
              firstTurn: "empty"
            },
            request: {
              method: "POST",
              url: "https://chatgpt.com/backend-api/f/conversation",
              body: {
                action: "next",
                messages: [
                  {
                    id: "{{messageId}}",
                    author: {
                      role: "user"
                    },
                    create_time: "{{unixTimestampSec}}",
                    content: {
                      content_type: "text",
                      parts: ["{{prompt}}"]
                    }
                  }
                ],
                parent_message_id: "{{parentIdOrClientCreatedRoot}}",
                model: "{{modelId}}",
                timezone: "Europe/Madrid",
                supports_buffering: true,
                supported_encodings: ["v1"]
              }
            },
            response: {
              contentPaths: ["v.message.content.parts.*", "message.content.parts.*"],
              responseIdPaths: ["v.message.id", "message.id"],
              conversationIdPaths: ["conversation_id", "v.conversation_id"],
              allowVisibleTextFinal: true,
              trimLeadingAssistantBlock: false
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("does not narrow an existing provider model catalog to one captured model", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createProvider(baseUrl, {
        id: "chat-example",
        kind: "http-sse",
        label: "Chat Example",
        config: {
          models: ["model-alpha", "model-beta", "model-gamma"]
        }
      });
      expect(created.status).toBe(201);
      const response = await requestJson(`${baseUrl}/v1/providers/chat-example/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.example.test",
          metadata: {
            browser: "Chrome",
            selectedRequest: {
              url: "https://chat.example.test/api/chat/completions",
              method: "POST",
              modelHints: ["model-alpha"]
            },
            requestCapture: {
              selectedRequest: {
                url: "https://chat.example.test/api/chat/completions",
                method: "POST",
                inferred: {
                  modelHints: ["model-alpha"],
                  usesSse: true
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-example",
        config: {
          models: ["model-alpha", "model-beta", "model-gamma"]
        }
      });
    } finally {
      await close();
    }
  });
  it("infers numeric parent id request fields as numeric replay tokens", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/chat-example/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.example.test",
          metadata: {
            browser: "Chrome",
            requestCapture: {
              selectedRequest: {
                url: "https://chat.example.test/api/chat/completions",
                method: "POST",
                inferred: {
                  modelHints: ["model-alpha"],
                  usesSse: true
                },
                requestBodyJson: {
                  parent_message_id: 2,
                  prompt: "Hello?"
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-example",
        kind: "http-sse",
        config: {
          transport: {
            request: {
              body: {
                parent_message_id: "{{parentIdNumberOrOmit}}",
                prompt: "{{prompt}}"
              }
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("preserves an existing transport when a session recapture has only inferred request metadata", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createProvider(baseUrl, {
        id: "chat-example",
        kind: "http-sse",
        label: "Chat Example",
        config: {
          models: ["model-alpha"],
          transport: {
            prompt: {
              mode: "auto_join"
            },
            request: {
              method: "POST",
              url: "https://chat.example.test/api/chats/new"
            },
            response: {
              contentPaths: ["choices.*.delta.content"]
            },
            seedBinding: {
              conversationId: "fresh-chat"
            }
          }
        }
      });
      expect(created.status).toBe(201);
      const response = await requestJson(`${baseUrl}/v1/providers/chat-example/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.example.test",
          metadata: {
            browser: "Chrome",
            selectedRequest: {
              url: "https://chat.example.test/api/chat/completions?chat_id=old-chat",
              method: "POST",
              modelHints: ["model-beta"],
              inferred: {
                usesSse: true,
                modelHints: ["model-beta"]
              },
              requestBodyJson: {
                parent_id: "old-parent",
                messages: [
                  {
                    role: "user",
                    content: "Hello?"
                  }
                ]
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-example",
        kind: "http-sse",
        config: {
          models: ["model-alpha", "model-beta"],
          transport: {
            request: {
              method: "POST",
              url: "https://chat.example.test/api/chats/new"
            },
            seedBinding: {
              conversationId: "fresh-chat"
            }
          }
        }
      });
      expect(provider.body.provider.config.transport.seedBinding.parentId).toBeUndefined();
    } finally {
      await close();
    }
  });
  it("refreshes an existing inferred transport when a recapture upgrades the transport family", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const created = await createProvider(baseUrl, {
        id: "chat-example",
        kind: "http-json",
        label: "Chat Example",
        config: {
          transport: {
            prompt: {
              mode: "auto_join"
            },
            request: {
              method: "POST",
              url: "https://chat.example.test/api/chat/completions"
            },
            response: {
              contentPaths: ["content"]
            }
          }
        }
      });
      expect(created.status).toBe(201);
      const response = await requestJson(`${baseUrl}/v1/providers/chat-example/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.example.test",
          cookies: [],
          headers: {
            Authorization: "Bearer secret-token",
            "User-Agent": "Captured UA",
            "connect-protocol-version": "1"
          },
          metadata: {
            browser: "Chrome",
            requestCapture: {
              selectedRequest: {
                url: "https://chat.example.test/api/chat/completions",
                method: "POST",
                headers: {
                  "Content-Type": "application/connect+json"
                },
                requestBodyJson: {
                  chat_id: "c1",
                  message: {
                    parent_id: "p1",
                    role: "user",
                    blocks: [
                      {
                        message_id: "",
                        text: {
                          content: "hi"
                        }
                      }
                    ]
                  },
                  options: {
                    thinking: true
                  }
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-example",
        kind: "http-connect",
        config: {
          transport: {
            request: {
              method: "POST",
              url: "https://chat.example.test/api/chat/completions",
              body: {
                chat_id: "{{conversationIdOrOmit}}",
                message: {
                  parent_id: "{{parentIdOrOmit}}",
                  role: "user",
                  blocks: [
                    {
                      message_id: "",
                      text: {
                        content: "{{prompt}}"
                      }
                    }
                  ]
                },
                options: {
                  thinking: "{{thinkingEnabledOrTrue}}"
                }
              }
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("accepts an explicit full model catalog from session-package metadata", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/chat-example/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.example.test",
          metadata: {
            browser: "Chrome",
            availableModels: [
              "model-alpha",
              { id: "model-beta" },
              { model: "model-gamma" },
              { name: "model-delta" }
            ],
            selectedRequest: {
              url: "https://chat.example.test/api/chat/completions",
              method: "POST",
              modelHints: ["model-alpha"]
            },
            requestCapture: {
              selectedRequest: {
                url: "https://chat.example.test/api/chat/completions",
                method: "POST",
                inferred: {
                  modelHints: ["model-alpha"],
                  usesSse: true
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-example",
        config: {
          models: ["model-alpha", "model-beta", "model-delta", "model-gamma"]
        }
      });
    } finally {
      await close();
    }
  });
  it("infers a reusable http-connect transport from a framed request capture", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(
        `${baseUrl}/v1/providers/connect-example/session-package`,
        {
          method: "PUT",
          body: {
            ...createSessionPackagePayload(),
            source: "browser-extension",
            origin: "https://connect.example.test",
            headers: {
              Authorization: "Bearer secret-token",
              "User-Agent": "Captured UA"
            },
            metadata: {
              browser: "Chrome",
              requestCapture: {
                selectedRequest: {
                  url: "https://connect.example.test/rpc/chat",
                  method: "POST",
                  headers: {
                    "Content-Type": "application/connect+json"
                  },
                  modelHints: ["model-connect"],
                  requestBodyText: encodeConnectJsonBody({
                    chat_id: "c1",
                    message: {
                      parent_id: "p1",
                      role: "user",
                      blocks: [
                        {
                          text: {
                            content: "hi"
                          }
                        }
                      ]
                    }
                  })
                }
              }
            }
          }
        }
      );
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/connect-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "connect-example",
        kind: "http-connect",
        config: {
          models: ["model-connect"],
          transport: {
            binding: {
              firstTurn: "empty"
            },
            request: {
              method: "POST",
              url: "https://connect.example.test/rpc/chat",
              body: {
                chat_id: "{{conversationIdOrOmit}}",
                message: {
                  parent_id: "{{parentIdOrOmit}}",
                  role: "user",
                  blocks: [
                    {
                      text: {
                        content: "{{prompt}}"
                      }
                    }
                  ]
                }
              }
            },
            response: {
              contentPaths: expect.arrayContaining(["message.blocks.*.text.content", "content"]),
              responseIdPaths: expect.arrayContaining([
                "response_id",
                "response_message_id",
                "id",
                "message.id",
                "message_id",
                "block.messageId",
                "data.id",
                "response.id",
                "response.message_id",
                "v.response.message_id"
              ]),
              conversationIdPaths: expect.arrayContaining(["conversation_id", "chat.id"]),
              trimLeadingAssistantBlock: true
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("infers a z.ai conversation transport from a chat completion capture", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/zai/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.z.ai",
          headers: {
            Authorization: "Bearer token-zai",
            "User-Agent": "Captured UA",
            "Accept-Language": "en-US"
          },
          metadata: {
            browser: "Chrome",
            requestCapture: {
              requests: [
                {
                  url: "https://chat.z.ai/api/v1/chats/new",
                  method: "POST",
                  requestHeaders: {
                    "x-subsquid-token": "subsquid-1",
                    Authorization: "Bearer bootstrap-token"
                  },
                  inferred: {
                    looksLikeBootstrapRequest: true
                  }
                }
              ],
              selectedRequest: {
                url: "https://chat.z.ai/api/v2/chat/completions?timestamp=1775633136625",
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                usesSse: true,
                modelHints: ["glm-4.7"],
                requestBodyJson: {
                  stream: true,
                  model: "glm-4.7",
                  messages: [
                    {
                      role: "user",
                      content: "2*2?"
                    }
                  ],
                  signature_prompt: "2*2?",
                  chat_id: "chat-zai-1",
                  id: "assistant-1",
                  current_user_message_id: "user-1",
                  current_user_message_parent_id: "assistant-0"
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/zai`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "zai",
        kind: "http-sse",
        config: {
          models: ["glm-4.7"],
          transport: {
            prompt: {
              mode: "latest_user"
            },
            binding: {
              firstTurn: "seed"
            },
            request: {
              method: "POST",
              url: "https://chat.z.ai/api/v2/chat/completions",
              signing: {
                kind: "z-ai-v1"
              },
              body: {
                model: "{{modelId}}",
                signature_prompt: "{{prompt}}",
                chat_id: "{{conversationId}}",
                id: "{{assistantMessageId}}",
                current_user_message_id: "{{userMessageId}}",
                current_user_message_parent_id: "{{parentIdOrNull}}"
              }
            },
            response: {
              contentPaths: ["data.delta_content"],
              eventFilters: [
                {
                  path: "data.phase",
                  equals: "answer"
                }
              ],
              fallbackResponseId: "assistantMessageId"
            },
            bootstrap: {
              request: {
                method: "POST",
                url: "https://chat.z.ai/api/v1/chats/new",
                headers: expect.objectContaining({
                  "x-subsquid-token": "subsquid-1"
                })
              },
              conversationIdPath: "id"
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("infers a Qwen conversation transport from a streaming chat capture", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/chat-qwen-ai/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.qwen.ai",
          headers: {
            "User-Agent": "Captured UA",
            Accept: "application/json"
          },
          metadata: {
            browser: "Chrome",
            requestCapture: {
              selectedRequest: {
                url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id=d0538a8e-1112-4b11-9a33-fd0700463279",
                method: "POST",
                modelHints: ["qwen3.6-plus"],
                requestBodyJson: {
                  stream: true,
                  version: "2.1",
                  incremental_output: true,
                  chat_id: "d0538a8e-1112-4b11-9a33-fd0700463279",
                  chat_mode: "normal",
                  model: "qwen3.6-plus",
                  parent_id: "feb95b78-2932-40d0-aa1d-528727748827",
                  messages: [
                    {
                      fid: "0112d6b7-a9b0-49aa-828d-c40353cf3f64",
                      parentId: "feb95b78-2932-40d0-aa1d-528727748827",
                      childrenIds: ["150aab65-c2cf-434e-a8d0-047aac8f2d07"],
                      role: "user",
                      content: "plus 2?",
                      user_action: "chat",
                      files: [],
                      timestamp: 1775639956,
                      models: ["qwen3.6-plus"],
                      chat_type: "t2t",
                      feature_config: {
                        thinking_enabled: true,
                        output_schema: "phase",
                        research_mode: "normal",
                        auto_thinking: true,
                        thinking_mode: "Auto",
                        thinking_format: "summary",
                        auto_search: true
                      },
                      extra: {
                        meta: {
                          subChatType: "t2t"
                        }
                      },
                      sub_chat_type: "t2t",
                      parent_id: "feb95b78-2932-40d0-aa1d-528727748827"
                    }
                  ],
                  timestamp: 1775639956
                }
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-qwen-ai`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-qwen-ai",
        kind: "http-sse",
        config: {
          models: ["qwen3.6-plus"],
          transport: {
            prompt: {
              mode: "flatten"
            },
            binding: {
              firstTurn: "seed"
            },
            session: {
              requireCookie: true,
              requireBearerToken: false,
              requireUserAgent: true,
              includeExtraHeaders: true
            },
            request: {
              method: "POST",
              url: "https://chat.qwen.ai/api/v2/chat/completions?chat_id={{conversationId}}",
              body: {
                chat_id: "{{conversationId}}",
                parent_id: "{{parentIdOrNull}}",
                model: "{{modelId}}",
                messages: [
                  expect.objectContaining({
                    fid: "{{messageId}}",
                    content: "{{prompt}}"
                  })
                ]
              }
            },
            response: {
              contentPaths: expect.arrayContaining(["choices.0.delta.content"]),
              eventFilters: [
                {
                  path: "choices.0.delta.phase",
                  equals: "answer"
                }
              ],
              trimLeadingAssistantBlock: true
            },
            bootstrap: {
              request: {
                method: "POST",
                url: "https://chat.qwen.ai/api/v2/chats/new",
                body: {
                  title: "New Chat",
                  models: ["{{modelId}}"],
                  chat_mode: "normal",
                  chat_type: "t2t",
                  timestamp: "{{unixTimestampMs}}",
                  project_id: ""
                }
              },
              conversationIdPath: "data.id"
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("normalizes first-turn Qwen captures with null parent ids into reusable follow-up templates", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/chat-qwen-ai/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://chat.qwen.ai",
          headers: {
            "User-Agent": "Captured UA",
            Accept: "application/json"
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
                      extra: {
                        meta: {
                          subChatType: "t2t"
                        }
                      },
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
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-qwen-ai`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider.config.transport.request.body).toMatchObject({
        chat_id: "{{conversationId}}",
        model: "{{modelId}}",
        parent_id: "{{parentIdOrNull}}",
        timestamp: "{{unixTimestampSec}}",
        messages: [
          {
            fid: "{{messageId}}",
            parentId: "{{parentIdOrNull}}",
            parent_id: "{{parentIdOrNull}}",
            childrenIds: [],
            role: "user",
            content: "{{prompt}}",
            timestamp: "{{unixTimestampSec}}",
            models: ["{{modelId}}"]
          }
        ]
      });
    } finally {
      await close();
    }
  });
  it("infers a DeepSeek conversation transport from a completion capture", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(
        `${baseUrl}/v1/providers/chat-deepseek-com/session-package`,
        {
          method: "PUT",
          body: {
            ...createSessionPackagePayload(),
            source: "browser-extension",
            origin: "https://chat.deepseek.com",
            integration: {
              models: ["deepseek-chat"]
            },
            headers: {
              Authorization: "Bearer token-deepseek",
              "User-Agent": "Captured UA",
              "x-hif-leim": "leim-1"
            },
            metadata: {
              browser: "Chrome",
              requestCapture: {
                requests: [
                  {
                    url: "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
                    method: "POST",
                    requestHeaders: {
                      "x-hif-leim": "leim-1",
                      "x-ds-pow-response": "stale-proof"
                    },
                    requestBodyJson: {
                      target_path: "/api/v0/chat/completion"
                    }
                  },
                  {
                    url: "https://chat.deepseek.com/api/v0/chat_session/create",
                    method: "POST",
                    requestHeaders: {
                      "x-hif-leim": "leim-1",
                      Referer: "https://chat.deepseek.com/"
                    },
                    requestBodyJson: {}
                  }
                ],
                selectedRequest: {
                  url: "https://chat.deepseek.com/api/v0/chat/completion",
                  method: "POST",
                  requestHeaders: {
                    accept: "*/*",
                    "content-type": "application/json",
                    "x-hif-leim": "leim-1",
                    "x-ds-pow-response": "stale-proof"
                  },
                  requestBodyJson: {
                    chat_session_id: "chat-deepseek-1",
                    parent_message_id: 12,
                    model_type: null,
                    prompt: "2*2?",
                    ref_file_ids: [],
                    thinking_enabled: true,
                    search_enabled: true,
                    preempt: false
                  }
                }
              }
            }
          }
        }
      );
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/chat-deepseek-com`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "chat-deepseek-com",
        kind: "http-sse",
        config: {
          models: ["deepseek-chat"],
          transport: {
            prompt: {
              mode: "flatten"
            },
            binding: {
              firstTurn: "empty"
            },
            session: {
              requireCookie: true,
              requireBearerToken: true,
              requireUserAgent: true,
              includeExtraHeaders: false
            },
            request: {
              method: "POST",
              url: "https://chat.deepseek.com/api/v0/chat/completion",
              headers: expect.objectContaining({
                accept: "*/*",
                "content-type": "application/json",
                "x-hif-leim": "leim-1"
              }),
              body: {
                chat_session_id: "{{conversationIdOrOmit}}",
                parent_message_id: "{{parentIdNumberOrOmit}}",
                prompt: "{{prompt}}"
              }
            },
            response: {
              contentPaths: ["__bridge__.deepseek.response"],
              responseIdPaths: expect.arrayContaining([
                "response_message_id",
                "chat_message.message_id"
              ]),
              conversationIdPaths: expect.arrayContaining(["data.biz_data.chat_session.id"])
            },
            bootstrap: {
              request: {
                method: "POST",
                url: "https://chat.deepseek.com/api/v0/chat_session/create"
              },
              conversationIdPath: "data.biz_data.id"
            },
            preflight: {
              request: {
                method: "POST",
                url: "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
                body: {
                  target_path: "/api/v0/chat/completion"
                }
              },
              proofOfWork: {
                kind: "sha3-wasm-salt-expiry",
                headerName: "x-ds-pow-response",
                wasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm",
                targetPathPath: "data.biz_data.challenge.target_path"
              }
            }
          }
        }
      });
      expect(
        provider.body.provider.config.transport.request.headers["x-ds-pow-response"]
      ).toBeUndefined();
      expect(
        provider.body.provider.config.transport.preflight.request.headers["x-ds-pow-response"]
      ).toBeUndefined();
    } finally {
      await close();
    }
  });
  it("infers a Kimi-style http-connect transport without rewriting blank block message ids", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(`${baseUrl}/v1/providers/kimi/session-package`, {
        method: "PUT",
        body: {
          ...createSessionPackagePayload(),
          source: "browser-extension",
          origin: "https://www.kimi.com",
          cookies: [],
          headers: {
            Authorization: "Bearer secret-token",
            "User-Agent": "Captured UA",
            "connect-protocol-version": "1",
            "x-msh-device-id": "device-1",
            "x-msh-platform": "web",
            "x-msh-session-id": "session-1",
            "x-msh-version": "1.0.0",
            "x-traffic-id": "traffic-1"
          },
          metadata: {
            browser: "Chrome",
            requestCapture: {
              selectedRequest: {
                url: "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
                method: "POST",
                headers: {
                  "Content-Type": "application/connect+json"
                },
                requestBodyText: encodeConnectJsonBody({
                  chat_id: "chat-kimi",
                  scenario: "SCENARIO_K2D5",
                  tools: [
                    {
                      type: "TOOL_TYPE_SEARCH",
                      search: {}
                    }
                  ],
                  message: {
                    parent_id: "parent-kimi",
                    role: "user",
                    blocks: [
                      {
                        message_id: "",
                        text: {
                          content: "plus 2?"
                        }
                      }
                    ],
                    scenario: "SCENARIO_K2D5"
                  },
                  options: {
                    thinking: false
                  }
                })
              }
            }
          }
        }
      });
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/kimi`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "kimi",
        kind: "http-connect",
        config: {
          transport: {
            binding: {
              firstTurn: "empty"
            },
            session: {
              requireCookie: false,
              requireBearerToken: true,
              requireUserAgent: true,
              includeExtraHeaders: true
            },
            request: {
              method: "POST",
              url: "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
              body: {
                chat_id: "{{conversationIdOrOmit}}",
                scenario: "SCENARIO_K2D5",
                tools: [
                  {
                    type: "TOOL_TYPE_SEARCH",
                    search: {}
                  }
                ],
                message: {
                  parent_id: "{{parentIdOrOmit}}",
                  role: "user",
                  blocks: [
                    {
                      message_id: "",
                      text: {
                        content: "{{prompt}}"
                      }
                    }
                  ],
                  scenario: "SCENARIO_K2D5"
                },
                options: {
                  thinking: "{{thinkingEnabledOrFalse}}"
                }
              }
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("infers http-connect from extension-style requestHeaders captures", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(
        `${baseUrl}/v1/providers/kimi-extension-shape/session-package`,
        {
          method: "PUT",
          body: {
            ...createSessionPackagePayload(),
            source: "browser-extension",
            origin: "https://www.kimi.com",
            cookies: [],
            headers: {
              Authorization: "Bearer secret-token",
              "User-Agent": "Captured UA",
              "connect-protocol-version": "1",
              "x-msh-device-id": "device-1",
              "x-msh-platform": "web",
              "x-msh-session-id": "session-1",
              "x-msh-version": "1.0.0",
              "x-traffic-id": "traffic-1"
            },
            metadata: {
              browser: "Chrome",
              requestCapture: {
                selectedRequest: {
                  url: "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
                  method: "POST",
                  requestHeaders: {
                    "Content-Type": "application/connect+json"
                  },
                  requestBodyText: encodeConnectJsonBody({
                    chat_id: "chat-kimi",
                    scenario: "SCENARIO_K2D5",
                    message: {
                      parent_id: "parent-kimi",
                      role: "user",
                      blocks: [
                        {
                          message_id: "",
                          text: {
                            content: "plus 10?"
                          }
                        }
                      ]
                    },
                    options: {
                      thinking: true
                    }
                  })
                }
              }
            }
          }
        }
      );
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/kimi-extension-shape`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "kimi-extension-shape",
        kind: "http-connect",
        config: {
          transport: {
            binding: {
              firstTurn: "empty"
            },
            request: {
              url: "https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat",
              body: {
                options: {
                  thinking: "{{thinkingEnabledOrTrue}}"
                }
              }
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("preserves embedded http-connect transport config on install", async () => {
    const { baseUrl, close } = await startStandaloneServer();
    try {
      const response = await requestJson(
        `${baseUrl}/v1/providers/connect-example/session-package`,
        {
          method: "PUT",
          body: {
            ...createSessionPackagePayload(),
            origin: "https://connect.example.test",
            integration: {
              label: "Connect Example",
              models: ["model-connect"]
            },
            transport: {
              family: "http-connect",
              prompt: {
                mode: "auto_join"
              },
              session: {
                requireCookie: true,
                requireBearerToken: true,
                requireUserAgent: true,
                includeExtraHeaders: true
              },
              seedBinding: {
                conversationId: "chat-seed",
                parentId: "parent-seed"
              },
              request: {
                method: "POST",
                url: "https://connect.example.test/rpc/chat",
                headers: {
                  "Content-Type": "application/connect+json",
                  "connect-protocol-version": "1"
                },
                body: {
                  chat_id: "{{conversationId}}",
                  message: {
                    parent_id: "{{parentId}}",
                    role: "user",
                    blocks: [
                      {
                        text: {
                          content: "{{prompt}}"
                        }
                      }
                    ]
                  }
                }
              },
              response: {
                contentPaths: ["message.blocks.*.text.content"],
                responseIdPaths: ["message.id"],
                trimLeadingAssistantBlock: true
              }
            }
          }
        }
      );
      expect(response.status).toBe(200);
      const provider = await requestJson(`${baseUrl}/v1/providers/connect-example`);
      expect(provider.status).toBe(200);
      expect(provider.body.provider).toMatchObject({
        id: "connect-example",
        kind: "http-connect",
        label: "Connect Example",
        config: {
          models: ["model-connect"],
          transport: {
            seedBinding: {
              conversationId: "chat-seed",
              parentId: "parent-seed"
            },
            request: {
              url: "https://connect.example.test/rpc/chat"
            }
          }
        }
      });
    } finally {
      await close();
    }
  });
  it("persists an uploaded session package across server restarts with the same vault path", async () => {
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
      await createProvider(firstServer.baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const stored = await requestJson(
        `${firstServer.baseUrl}/v1/providers/provider-a/session-package`,
        {
          method: "PUT",
          body: createSessionPackagePayload()
        }
      );
      expect(stored.status).toBe(200);
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
      const response = await requestJson(
        `${secondServer.baseUrl}/v1/providers/provider-a/session-package`
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        providerId: "provider-a",
        hasSessionPackage: true,
        source: "manual",
        capturedAt: "2026-04-02T12:00:00.000Z",
        origin: "https://api.example.test"
      });
    } finally {
      await secondServer.close();
    }
  });
  it("writes encrypted vault entries without plaintext session material", async () => {
    const sessionVaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const sessionVaultKeyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const { baseUrl, close } = await startStandaloneServer({
      sessionVaultPath,
      sessionVaultKeyPath
    });
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: createSessionPackagePayload()
      });
      expect(response.status).toBe(200);
    } finally {
      await close();
    }
    const entriesPath = path.join(sessionVaultPath, "entries");
    const files = await readdir(entriesPath);
    expect(files.length).toBe(1);
    const persisted = await readFile(path.join(entriesPath, files[0]!), "utf8");
    expect(persisted).toContain('"ciphertext":');
    expect(persisted).not.toContain("secret-cookie");
    expect(persisted).not.toContain("secret-token");
    expect(path.dirname(sessionVaultPath)).not.toContain(`${path.sep}dist`);
  });
  it("fails safely when vault metadata is corrupted", async () => {
    const sessionVaultPath = await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-"));
    const sessionVaultKeyPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "bridge-server-vault-key-")),
      "vault.key"
    );
    const { baseUrl, close } = await startStandaloneServer({
      sessionVaultPath,
      sessionVaultKeyPath
    });
    try {
      await createProvider(baseUrl, {
        id: "provider-a",
        kind: "mock",
        label: "Provider A"
      });
      await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`, {
        method: "PUT",
        body: createSessionPackagePayload()
      });
      await writeFile(path.join(sessionVaultPath, "index.json"), "{broken-json}\n", "utf8");
      const response = await requestJson(`${baseUrl}/v1/providers/provider-a/session-package`);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "internal_error",
          message: "Internal bridge server error."
        }
      });
      expect(JSON.stringify(response.body)).not.toContain("secret-cookie");
      expect(JSON.stringify(response.body)).not.toContain("secret-token");
    } finally {
      await close();
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
    headers: {
      Authorization: "Bearer secret-token"
    },
    metadata: {
      browser: "Chrome"
    }
  };
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
function encodeConnectJsonBody(value: unknown) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(value));
  const envelope = new Uint8Array(5 + payloadBytes.length);
  envelope[0] = 0;
  envelope[1] = (payloadBytes.length >>> 24) & 0xff;
  envelope[2] = (payloadBytes.length >>> 16) & 0xff;
  envelope[3] = (payloadBytes.length >>> 8) & 0xff;
  envelope[4] = payloadBytes.length & 0xff;
  envelope.set(payloadBytes, 5);
  return new TextDecoder().decode(envelope);
}
