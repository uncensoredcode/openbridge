import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse
} from "@uncensoredcode/openbridge/runtime";
import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";

import type { BridgeRuntimeServiceLogEvent } from "../src/bridge/index.ts";
import { bridgeModule } from "../src/bridge/index.ts";
import { httpModule } from "../src/http/index.ts";
import { outputModule } from "../src/shared/output.ts";

const { createFinalResponse, createMessagePacket, ProviderFailure, createToolRequestPacket } =
  bridgeRuntime;
const { sanitizeBridgeApiOutput } = outputModule;
const { createBridgeRuntimeService } = bridgeModule;
const { createBridgeApiServer } = httpModule;
class ScriptedTransport implements ProviderTransport {
  readonly calls: ProviderTransportRequest[] = [];
  readonly #callCounts = new Map<string, number>();
  readonly #handler: (
    request: ProviderTransportRequest,
    callIndex: number
  ) => Promise<ProviderTransportResponse> | ProviderTransportResponse;
  constructor(
    handler: (
      request: ProviderTransportRequest,
      callIndex: number
    ) => Promise<ProviderTransportResponse> | ProviderTransportResponse
  ) {
    this.#handler = handler;
  }
  async completeChat(request: ProviderTransportRequest): Promise<ProviderTransportResponse> {
    this.calls.push(request);
    const callIndex = (this.#callCounts.get(request.sessionId) ?? 0) + 1;
    this.#callCounts.set(request.sessionId, callIndex);
    return this.#handler(request, callIndex);
  }
}
function createExpectedRepairSummary(
  overrides: Partial<{
    attempted: boolean;
    attemptCount: number;
    outcome: "not_needed" | "valid" | "failed";
    failureReason: "provider_failure" | "protocol_invalid";
    invalidCount: number;
  }> = {}
) {
  return {
    attempted: false,
    attemptCount: 0,
    outcome: "not_needed" as const,
    invalidCount: 0,
    ...overrides
  };
}
function createExpectedRecoverySummary(
  overrides: Partial<{
    softRetryCount: number;
    providerSessionResetCount: number;
    repair: ReturnType<typeof createExpectedRepairSummary>;
  }> = {}
) {
  return {
    softRetryCount: 0,
    providerSessionResetCount: 0,
    repair: createExpectedRepairSummary(),
    ...overrides
  };
}
test("health endpoint reports ok", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => {
      throw new Error("should not be called");
    })
  );
  try {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await close();
  }
});
test("valid request returns a normalized generic response", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: createMessagePacket("final", "Normalized bridge response."),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/session-a/messages`, {
      input: "Say hello",
      metadata: {
        client: "test"
      }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      sessionId: "session-a",
      output: "Normalized bridge response.",
      outcome: {
        mode: "final",
        steps: 1
      },
      provider: {
        id: "session-sse",
        model: "model-alpha"
      },
      session: {
        providerBindingReused: false
      },
      meta: {
        outputSanitized: false,
        recovery: createExpectedRecoverySummary(),
        requestMetadata: {
          client: "test"
        }
      }
    });
  } finally {
    await close();
  }
});
test("valid leading assistant block is preserved when provider appends trailing metadata text", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: "<final>Hello</final>User Greeting Response",
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/session-a/messages`, {
      input: "Say hello"
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.output, "Hello");
    assert.deepEqual(response.body.meta.recovery, createExpectedRecoverySummary());
    assert.equal(transport.calls.length, 1);
  } finally {
    await close();
  }
});
test("body endpoint requires sessionId", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await postJson(`${baseUrl}/v1/respond`, {
      input: "missing session"
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: "invalid_request",
        message: "sessionId is required."
      }
    });
  } finally {
    await close();
  }
});
test("missing input fails with a deterministic structured error", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/session-a/messages`, {
      metadata: {
        client: "test"
      }
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: "invalid_request",
        message: "input is required."
      }
    });
  } finally {
    await close();
  }
});
test("empty input fails explicitly", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/session-a/messages`, {
      input: "   "
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: "invalid_request",
        message: "input must be a non-empty string."
      }
    });
  } finally {
    await close();
  }
});
test("invalid body shape fails cleanly", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await fetch(`${baseUrl}/v1/sessions/session-a/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["bad", "shape"])
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: "invalid_request",
        message: "Request body must be a JSON object."
      }
    });
  } finally {
    await close();
  }
});
test("invalid JSON fails cleanly", async () => {
  const { baseUrl, close } = await startTestServer(
    new ScriptedTransport(() => ({
      content: createMessagePacket("final", "unused")
    }))
  );
  try {
    const response = await fetch(`${baseUrl}/v1/sessions/session-a/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: "{not json"
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        code: "invalid_json",
        message: "Request body must contain valid JSON."
      }
    });
  } finally {
    await close();
  }
});
test("same sessionId reuses the same upstream provider binding", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: createMessagePacket("final", `reply-${callIndex}`),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const first = await postJson(`${baseUrl}/v1/sessions/shared/messages`, {
      input: "first"
    });
    const second = await postJson(`${baseUrl}/v1/sessions/shared/messages`, {
      input: "second"
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(transport.calls[0]?.upstreamBinding, null);
    assert.deepEqual(transport.calls[1]?.upstreamBinding, {
      conversationId: "conv-shared",
      parentId: "resp-1"
    });
    assert.equal(first.body.session.providerBindingReused, false);
    assert.equal(second.body.session.providerBindingReused, true);
  } finally {
    await close();
  }
});
test("different sessionIds stay isolated", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: createMessagePacket("final", `reply-${callIndex}`),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const first = await postJson(`${baseUrl}/v1/sessions/one/messages`, {
      input: "first"
    });
    const second = await postJson(`${baseUrl}/v1/sessions/two/messages`, {
      input: "second"
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(transport.calls[0]?.upstreamBinding, null);
    assert.equal(transport.calls[1]?.upstreamBinding, null);
    assert.equal(first.body.session.providerBindingReused, false);
    assert.equal(second.body.session.providerBindingReused, false);
  } finally {
    await close();
  }
});
test("client reset semantics are achieved by choosing a new sessionId", async () => {
  const transport = new ScriptedTransport((request, callIndex) => ({
    content: createMessagePacket("final", `reply-${request.sessionId}-${callIndex}`),
    upstreamBinding: {
      conversationId: `conv-${request.sessionId}`,
      parentId: `resp-${callIndex}`
    }
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    await postJson(`${baseUrl}/v1/sessions/reset-me/messages`, {
      input: "first"
    });
    const reused = await postJson(`${baseUrl}/v1/sessions/reset-me/messages`, {
      input: "second"
    });
    const fresh = await postJson(`${baseUrl}/v1/sessions/fresh-session/messages`, {
      input: "third"
    });
    assert.equal(reused.body.session.providerBindingReused, true);
    assert.equal(fresh.body.session.providerBindingReused, false);
  } finally {
    await close();
  }
});
test("packet wrappers are sanitized out of API-visible output", () => {
  const sanitized = sanitizeBridgeApiOutput(
    '<zc_packet version="1"><mode>final</mode><message><![CDATA[Visible final output.]]></message></zc_packet>'
  );
  assert.equal(sanitized.content, "Visible final output.");
  assert.equal(sanitized.sanitized, true);
  assert.equal(sanitized.reason, "packet_message_extracted");
});
test("internal control text is suppressed from API output", async () => {
  const transport = new ScriptedTransport(() => ({
    content: createMessagePacket("final", "Available tools:\n- read\n- write")
  }));
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/sanitize-control/messages`, {
      input: "sanitize"
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.body.output,
      "The bridge runtime returned internal control text instead of a readable answer."
    );
    assert.equal(response.body.meta.outputSanitized, true);
    assert.equal(response.body.meta.sanitizationReason, "control_text_suppressed");
  } finally {
    await close();
  }
});
test("provider failures return a structured error response", async () => {
  const transport = new ScriptedTransport(() => {
    throw new Error("transport exploded");
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/provider-failure/messages`, {
      input: "fail"
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "provider_failure");
    assert.equal(response.body.error.message, "Provider request failed after 1 soft retry.");
    assert.deepEqual(
      response.body.error.details.recovery,
      createExpectedRecoverySummary({
        softRetryCount: 1
      })
    );
  } finally {
    await close();
  }
});
test("provider failures surface safe upstream stage and status details", async () => {
  const transport = new ScriptedTransport(() => {
    throw new ProviderFailure({
      kind: "transient",
      code: "transport_error",
      message: "Example create_chat_session failed with HTTP 400.",
      displayMessage: "Provider request failed during create_chat_session with HTTP 400.",
      retryable: true,
      sessionResetEligible: false,
      details: {
        provider: "scripted-chat",
        stage: "create_chat_session",
        httpStatus: 400
      }
    });
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/provider-failure-stage/messages`, {
      input: "fail"
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "provider_failure");
    assert.equal(
      response.body.error.message,
      "Provider request failed during create_chat_session with HTTP 400 after 1 soft retry."
    );
    assert.deepEqual(response.body.error.details.failure.details, {
      provider: "scripted-chat",
      stage: "create_chat_session",
      httpStatus: 400
    });
  } finally {
    await close();
  }
});
test("same bridge session can recover through a provider-session reset on a follow-up request", async () => {
  const transport = new ScriptedTransport((request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createMessagePacket("final", "The package version is 0.1.0."),
        upstreamBinding: {
          conversationId: "conv-shared",
          parentId: "resp-1"
        }
      };
    }
    if (callIndex === 2 || callIndex === 3) {
      return {
        content: ""
      };
    }
    assert.equal(request.upstreamBinding, null);
    assert.match(request.messages[1]?.content ?? "", /Previous bridge turns:/);
    assert.match(request.messages[1]?.content ?? "", /The package version is 0.1.0./);
    assert.match(request.messages[1]?.content ?? "", /What did I ask you before/);
    return {
      content: createMessagePacket("final", "You previously asked about the package version."),
      upstreamBinding: {
        conversationId: "conv-shared-fresh",
        parentId: "resp-4"
      }
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const first = await postJson(`${baseUrl}/v1/sessions/shared/messages`, {
      input: "Tell me the package version."
    });
    const second = await postJson(`${baseUrl}/v1/sessions/shared/messages`, {
      input: "What did I ask you before?"
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.sessionId, "shared");
    assert.equal(second.body.session.providerBindingReused, true);
    assert.deepEqual(
      second.body.meta.recovery,
      createExpectedRecoverySummary({
        softRetryCount: 1,
        providerSessionResetCount: 1
      })
    );
    assert.equal(second.body.output, "You previously asked about the package version.");
  } finally {
    await close();
  }
});
test("empty provider responses are classified cleanly after retry and reset budgets are exhausted", async () => {
  const transport = new ScriptedTransport((_request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createMessagePacket("final", "Baseline answer."),
        upstreamBinding: {
          conversationId: "conv-empty",
          parentId: "resp-1"
        }
      };
    }
    return {
      content: ""
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const first = await postJson(`${baseUrl}/v1/sessions/empty-session/messages`, {
      input: "hello"
    });
    const second = await postJson(`${baseUrl}/v1/sessions/empty-session/messages`, {
      input: "follow up"
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 502);
    assert.equal(second.body.error.code, "provider_empty_response");
    assert.equal(
      second.body.error.message,
      "Provider returned an empty response after 1 soft retry and 1 provider-session reset."
    );
    assert.deepEqual(
      second.body.error.details.recovery,
      createExpectedRecoverySummary({
        softRetryCount: 1,
        providerSessionResetCount: 1
      })
    );
    assert.deepEqual(second.body.error.details.failure, {
      kind: "transient",
      code: "empty_response",
      message:
        "Provider returned an empty response after 1 soft retry and 1 provider-session reset.",
      retryable: true,
      sessionResetEligible: false,
      emptyOutput: true,
      recovery: {
        softRetryCount: 1,
        sessionResetCount: 1
      }
    });
  } finally {
    await close();
  }
});
test("service emits deterministic provider lifecycle logs for retries and resets", async () => {
  const logs: BridgeRuntimeServiceLogEvent[] = [];
  const transport = new ScriptedTransport((_request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createMessagePacket("final", "Baseline answer."),
        upstreamBinding: {
          conversationId: "conv-log",
          parentId: "resp-1"
        }
      };
    }
    if (callIndex === 2 || callIndex === 3) {
      return {
        content: ""
      };
    }
    return {
      content: createMessagePacket("final", "Recovered answer."),
      upstreamBinding: {
        conversationId: "conv-log-fresh",
        parentId: "resp-4"
      }
    };
  });
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-logs-state-"));
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-server-logs-runtime-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateRoot,
    runtimeRoot,
    defaultProvider: "session-sse",
    defaultModel: "model-alpha",
    maxSteps: 8
  };
  const service = createBridgeRuntimeService({
    config,
    transport,
    onLog(event) {
      logs.push(event);
    }
  });
  await service.respond({
    sessionId: "shared",
    input: "hello"
  });
  await service.respond({
    sessionId: "shared",
    input: "follow up"
  });
  const providerAttempt = logs.find(
    (entry) =>
      entry.scope === "provider" &&
      entry.event === "provider_attempt_finished" &&
      entry.detail.outcome === "soft_retry"
  );
  const providerReset = logs.find(
    (entry) => entry.scope === "provider" && entry.event === "provider_session_reset"
  );
  assert.ok(providerAttempt);
  assert.ok(providerReset);
  assert.equal(providerAttempt.detail.bridgeSessionId, "shared");
  assert.equal(providerAttempt.detail.failure.code, "empty_response");
  assert.equal(providerReset.detail.recovery.sessionResetCount, 1);
});
test("service emits repair lifecycle logs and request summary for a valid repair", async () => {
  const logs: BridgeRuntimeServiceLogEvent[] = [];
  const transport = new ScriptedTransport((request) => {
    if (request.lane === "main") {
      return {
        content: "answer directly please",
        upstreamBinding: {
          conversationId: "conv-repair",
          parentId: "resp-main"
        }
      };
    }
    return {
      content: createFinalResponse("Repaired answer."),
      upstreamBinding: {
        conversationId: "conv-repair-fresh",
        parentId: "resp-repair"
      }
    };
  });
  const { baseUrl, close } = await startTestServer(transport, {
    onLog(event) {
      logs.push(event);
    }
  });
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/repair-valid/messages`, {
      input: "repair this"
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.meta.recovery,
      createExpectedRecoverySummary({
        repair: createExpectedRepairSummary({
          attempted: true,
          attemptCount: 1,
          outcome: "valid",
          invalidCount: 1
        })
      })
    );
    const runtimeEvents = logs
      .filter((entry) => entry.scope === "runtime")
      .map((entry) => entry.event);
    assert.deepEqual(
      runtimeEvents.filter(
        (event) =>
          event === "main_response_invalid" ||
          event === "repair_attempted" ||
          event === "repair_valid"
      ),
      ["main_response_invalid", "repair_attempted", "repair_valid"]
    );
    const repairStarted = logs.find(
      (entry) => entry.scope === "provider" && entry.event === "provider_repair_started"
    );
    const repairFinished = logs.find(
      (entry) => entry.scope === "provider" && entry.event === "provider_repair_finished"
    );
    const requestFinished = logs.find(
      (entry) => entry.scope === "request" && entry.event === "bridge_request_finished"
    );
    assert.ok(repairStarted);
    assert.ok(repairFinished);
    assert.ok(requestFinished);
    assert.equal(repairStarted.detail.providerId, "session-sse");
    assert.equal(repairFinished.detail.providerId, "session-sse");
    assert.notEqual(repairStarted.detail.bridgeSessionId, repairStarted.detail.repairSessionId);
    assert.equal(repairFinished.detail.modelId, "model-alpha");
    assert.equal(repairFinished.detail.outcome, "success");
    assert.deepEqual(
      requestFinished.detail.recovery.repair,
      createExpectedRepairSummary({
        attempted: true,
        attemptCount: 1,
        outcome: "valid",
        invalidCount: 1
      })
    );
  } finally {
    await close();
  }
});
test("service emits repair_failed and request summary when repair output is still invalid", async () => {
  const logs: BridgeRuntimeServiceLogEvent[] = [];
  const transport = new ScriptedTransport((request) => ({
    content: request.lane === "main" ? "answer directly please" : "still invalid"
  }));
  const { baseUrl, close } = await startTestServer(transport, {
    onLog(event) {
      logs.push(event);
    }
  });
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/repair-fail-protocol/messages`, {
      input: "repair this"
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "provider_protocol_failure");
    assert.deepEqual(
      response.body.error.details.recovery,
      createExpectedRecoverySummary({
        repair: createExpectedRepairSummary({
          attempted: true,
          attemptCount: 1,
          outcome: "failed",
          invalidCount: 1,
          failureReason: "protocol_invalid"
        })
      })
    );
    const repairFailed = logs.find(
      (entry) => entry.scope === "runtime" && entry.event === "repair_failed"
    );
    const requestFinished = logs.find(
      (entry) => entry.scope === "request" && entry.event === "bridge_request_finished"
    );
    assert.ok(repairFailed);
    assert.equal(repairFailed.detail.reason, "protocol_invalid");
    assert.ok(requestFinished);
    assert.equal(requestFinished.detail.recovery.repair.outcome, "failed");
    assert.equal(requestFinished.detail.recovery.repair.failureReason, "protocol_invalid");
  } finally {
    await close();
  }
});
test("service emits provider_repair_failed and provider_failure repair summary when same-provider repair transport fails", async () => {
  const logs: BridgeRuntimeServiceLogEvent[] = [];
  const transport = new ScriptedTransport((request) => {
    if (request.lane === "main") {
      return {
        content: "answer directly please"
      };
    }
    throw new Error("repair transport failed");
  });
  const { baseUrl, close } = await startTestServer(transport, {
    onLog(event) {
      logs.push(event);
    }
  });
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/repair-fail-provider/messages`, {
      input: "repair this"
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, "provider_failure");
    assert.deepEqual(
      response.body.error.details.recovery,
      createExpectedRecoverySummary({
        repair: createExpectedRepairSummary({
          attempted: true,
          attemptCount: 1,
          outcome: "failed",
          invalidCount: 1,
          failureReason: "provider_failure"
        })
      })
    );
    const providerRepairFailed = logs.find(
      (entry) => entry.scope === "provider" && entry.event === "provider_repair_failed"
    );
    const runtimeRepairFailed = logs.find(
      (entry) => entry.scope === "runtime" && entry.event === "repair_failed"
    );
    assert.ok(providerRepairFailed);
    assert.equal(providerRepairFailed.detail.providerId, "session-sse");
    assert.equal(providerRepairFailed.detail.failure.code, "transport_error");
    assert.ok(runtimeRepairFailed);
    assert.equal(runtimeRepairFailed.detail.reason, "provider_failure");
  } finally {
    await close();
  }
});
test("default mode rejects bridge-owned tool execution requests", async () => {
  const transport = new ScriptedTransport((_request, callIndex) => {
    if (callIndex === 1) {
      return {
        content: createToolRequestPacket({
          id: "call_missing",
          name: "missing_tool",
          args: {}
        }),
        upstreamBinding: {
          conversationId: "conv-fail",
          parentId: "resp-1"
        }
      };
    }
    return {
      content: createMessagePacket("fail", "Unable to continue after the tool failure."),
      upstreamBinding: {
        conversationId: "conv-fail",
        parentId: "resp-2"
      }
    };
  });
  const { baseUrl, close } = await startTestServer(transport);
  try {
    const response = await postJson(`${baseUrl}/v1/sessions/tool-failure/messages`, {
      input: "fail after tool"
    });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, {
      error: {
        code: "provider_protocol_failure",
        message:
          'Provider requested tool "missing_tool" but this bridge flow does not execute tools.',
        details: {
          sessionId: "tool-failure",
          provider: {
            id: "session-sse",
            model: "model-alpha"
          },
          steps: 1,
          recovery: createExpectedRecoverySummary(),
          failure: {
            source: "protocol",
            code: "unsupported_tool_request"
          }
        }
      }
    });
  } finally {
    await close();
  }
});
async function startTestServer(
  transport: ProviderTransport,
  options?: {
    onLog?: (event: BridgeRuntimeServiceLogEvent) => void;
  }
) {
  const config = {
    host: "127.0.0.1",
    port: 0,
    stateRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-state-")),
    runtimeRoot: await mkdtemp(path.join(os.tmpdir(), "bridge-server-runtime-")),
    defaultProvider: "session-sse",
    defaultModel: "model-alpha",
    maxSteps: 8
  };
  const service = createBridgeRuntimeService({
    config,
    transport,
    onLog: options?.onLog
  });
  const server = createBridgeApiServer({
    config,
    service
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server.");
  }
  return {
    baseUrl: `http://${address.address}:${address.port}`,
    close: () => closeServer(server)
  };
}
async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>
  };
}
function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening");
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
