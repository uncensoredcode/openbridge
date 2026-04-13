# OpenBridge

[![npm version](https://img.shields.io/npm/v/%40uncensoredcode%2Fopenbridge)](https://www.npmjs.com/package/@uncensoredcode/openbridge)
![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)

Turn browser-authenticated AI chat products into an OpenAI-compatible API for agents, tools, and local automation.

`openbridge` reuses the web chat sessions you already have and exposes them through a stable `/v1/chat/completions` interface. That lets tools like `opencode`, `pi`, `OpenClaw`, `Hermes`, and any other OpenAI-style client talk to browser-backed models as if they were normal API providers.

This is not a chatbot wrapper. It is an adapter layer between polished consumer chat apps and agent-ready infrastructure.

Live site built using OpenBridge:

[uncensoredcode.vercel.app](https://uncensoredcode.vercel.app/)

## Why OpenBridge

- Reuse authenticated browser sessions instead of managing separate API keys.
- Expose web-chat models behind an OpenAI-compatible endpoint.
- Preserve provider conversation bindings so follow-up turns keep working.
- Normalize multiple upstream transport styles, including `http-sse`, `http-json`, and `http-connect`.
- Keep your agent stack stable while swapping or testing different chat surfaces underneath it.

## Demo

https://github.com/user-attachments/assets/4c511b28-02e5-4f82-815e-82994da9baee

## Quick Start

Install the package:

```bash
npm install -g @uncensoredcode/openbridge
```

Start the bridge:

```bash
openbridge start
```

By default, OpenBridge serves locally on `http://127.0.0.1:4318`.

The server starts detached by default, so you can keep using the same terminal.

Check that it is up:

```bash
openbridge health
```

Once you have a provider and session package installed, send a request through the OpenAI-compatible API:

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

Or send a prompt from the CLI:

```bash
openbridge --session demo "Summarize what this project does."
```

## Security Note

The critical path in this project is session extraction. That is why the extension exists, and it is also the part users should treat with the most caution.

If you do not want to trust an extension with authenticated session material, you do not have to. The extension is a convenience path, not a requirement. You can extract session data yourself and install it through the session-package flow instead.

Session extraction extension:

[uncensoredcode/session_extractor](https://github.com/uncensoredcode/session_extractor)

## How It Works

1. Capture or assemble a provider session package from an authenticated browser session.
2. Install that session package into OpenBridge for a configured provider.
3. Call OpenBridge through the CLI or `/v1/chat/completions`.
4. OpenBridge handles provider-specific request formats, transport quirks, and conversation continuity.

The result is a single local bridge that makes browser-native chat products usable from agent frameworks and OpenAI-compatible SDKs.

## Session Package Flow

Captured session material is installed per provider through:

```text
PUT /v1/providers/:id/session-package
```

OpenBridge can infer provider transport details from captured browser requests and headers, then store that session package for later reuse.

You can also import a session package from the CLI:

```bash
openbridge providers import-session provider-a --file ./session-package.json
```

Check whether a provider has session material installed:

```bash
openbridge providers session-status provider-a
```

## Tested Targets

Confirmed in the transport and session-package test suite:

- DeepSeek
- Qwen
- Z.ai
- Kimi

Use this responsibly. Reusing browser-authenticated sessions may violate the terms of service of some providers, so you should evaluate that risk yourself before using OpenBridge against any given service.

This list should be read as known working evidence, not a hard product boundary. The project is intended to stay generic.

## Package Surface

- `@uncensoredcode/openbridge`: default package export
- `@uncensoredcode/openbridge/server`: Fastify server, storage, session vault, and standalone bridge server
- `@uncensoredcode/openbridge/runtime`: turn compilation, packet handling, and runtime helpers
- `@uncensoredcode/openbridge/cli`: unified `openbridge` CLI for server control, health checks, provider/session management, and prompt execution

## Common Commands

```bash
openbridge start
openbridge status
openbridge logs --follow
openbridge providers list
openbridge models list
openbridge sessions list
```

## Why This Exists

The strongest AI models increasingly appear first inside polished web apps. Agents, SDKs, and local tools still want a predictable API boundary.

`openbridge` is the splice point between those two worlds: keep the authenticated browser session you already have, but expose it through an interface the rest of your stack can actually use.
