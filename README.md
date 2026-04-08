# uncensoredcode // openbridge

Turn a glossy web-chat LLM into an agent-ready, tool-calling model.

`openbridge` reuses authenticated browser chat sessions and exposes them through an OpenAI-compatible API so agents like `opencode`, `pi`, `OpenClaw`, `Hermes`, and anything else that can speak OpenAI-style chat completions can drive them like real tool-call models.

This is not another chatbot wrapper. The point is to take the classic consumer web-chat experience, keep the auth session you already have, and bridge it into something agents can actually use.

## What It Does

- Reuses authenticated web sessions instead of forcing a separate API key flow.
- Preserves provider conversation bindings so follow-up turns keep working.
- Exposes an OpenAI-compatible `/v1/chat/completions` surface.
- Supports generic transport profiles for `http-sse`, `http-json`, and `http-connect`.
- Lets you run the same bridge against different upstream chat products without rewriting your agent stack every time.

Most of the currently tested targets are the usual big chat LLM products. The actual goal is broader: make this bridge generic enough to sit in front of any OpenAI-compatible API or browser-backed chat transport we can model cleanly.

## Critical Path: Session Extraction

The critical path is session extraction. That is why the extension exists.

Maintainer note: I personally believe users should be extremely careful with any extension that extracts auth sessions. That is powerful, invasive, and easy to misuse. If you do not want to trust an extension with that job, manually extract the session material yourself and install it through the session-package flow, or have an agent vibe-code a dedicated installer on top of this repo's formats and server endpoints.

In other words: the extension is a convenience path, not a trust requirement.

## Tested Targets

Confirmed in the repo's transport/session-package test suite:

- `chat.deepseek.com` with `deepseek-chat`
- `chat.qwen.ai` with `qwen3.6-plus`
- `chat.z.ai` with `glm-4.7`
- `www.kimi.com` as a Kimi-style `http-connect` target

Observed in checked-in bridge continuation state in this repo:

- `chat.qwen.ai` with `qwen3-max` and `qwen3.6-plus`
- `chat.deepseek.com` with `deepseek-chat`
- `chat.z.ai` with `GLM-5-Turbo` and `glm-4.7`
- `www.kimi.com` with `kimi-k2@instant`, `kimi-k2@no-thinking`, and `kimi-k2@thinking`

That list should be read as "known working surfaces we have evidence for", not as a product boundary. The bridge is intended to be generic.

## Package Surface

- `@uncensoredcode/openbridge`: default server export.
- `@uncensoredcode/openbridge/server`: Fastify HTTP API, provider/session-package storage, session vault, and standalone bridge server.
- `@uncensoredcode/openbridge/runtime`: provider turn compilation, packet handling, tool execution, and runtime helpers.
- `@uncensoredcode/openbridge/cli`: unified `openbridge` CLI for server control, health checks, and sending prompts to a running bridge server.

## Quick Start

```bash
bun install
bun run build
bun run format:check
bun run lint
bun run test
```

Use the local CLI during development:

```bash
bun run ./bin/openbridge.js --help
```

Start the server in watch mode:

```bash
bun run dev:server
```

Or start the standalone server directly:

```bash
openbridge start
```

Check health:

```bash
openbridge health
```

Send a prompt through a bridge session:

```bash
openbridge --session demo "Read README.md"
```

Use the OpenAI-compatible endpoint directly:

```bash
curl http://127.0.0.1:4318/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "chat-qwen-ai/qwen3-max",
    "messages": [
      { "role": "user", "content": "Reply with exactly OK." }
    ]
  }'
```

## Session Package Install Flow

Captured session material is installed per provider through:

```text
PUT /v1/providers/:id/session-package
```

The server can infer provider transport details from captured browser requests and headers, then store the session package for later reuse.

## Why This Exists

The frontier labs keep shipping powerful models behind polished web apps. Agents want stable tool-calling APIs. `openbridge` is the splice point between those two worlds.
