import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { bridgeModule } from "../src/bridge/index.ts";
import { cliModule } from "../src/cli/index.ts";

const { formatLiveProviderExtractionCanaryResult, runLiveProviderExtractionCanary } = bridgeModule;
const { getBridgeServerCliHelpText, parseBridgeServerCliArgs, runBridgeServerCli } = cliModule;
const packageRoot = path.resolve(import.meta.dirname, "..");
const baseConfig = {
  host: "127.0.0.1",
  port: 4319,
  stateRoot: "/tmp/bridge-state",
  runtimeRoot: "/tmp/runtime-root",
  defaultProvider: null,
  defaultModel: null,
  maxSteps: 8
};
test("live extraction canary succeeds when assistant fragments are extracted", async () => {
  const result = await runLiveProviderExtractionCanary({
    config: baseConfig,
    providerId: "session-sse",
    modelId: "model-alpha",
    requestId: "req-success",
    now: createClock([100, 145]),
    collectCompletion: async (_stateStore, request) => ({
      providerId: request.providerId,
      modelId: request.modelId,
      prompt: "USER:\nReply with exactly OK.",
      conversationId: "chat-1",
      completion: {
        content: "OK",
        responseId: "resp-1",
        eventCount: 2,
        fragmentCount: 1
      },
      upstreamBinding: {
        conversationId: "chat-1",
        parentId: "resp-1"
      }
    })
  });
  assert.deepEqual(result, {
    ok: true,
    classification: "success",
    providerId: "session-sse",
    modelId: "model-alpha",
    requestId: "req-success",
    durationMs: 45,
    prompt: "Reply with exactly OK.",
    expectedSubstring: "OK",
    expectedSubstringMatched: true,
    conversationId: "chat-1",
    responseId: "resp-1",
    streamEventCount: 2,
    fragmentCount: 1,
    output: "OK"
  });
  assert.match(formatLiveProviderExtractionCanaryResult(result), /status=ok/);
  assert.match(formatLiveProviderExtractionCanaryResult(result), /fragment_count=1/);
});
test("live extraction canary classifies empty extraction as parser drift risk", async () => {
  const result = await runLiveProviderExtractionCanary({
    config: baseConfig,
    providerId: "session-sse",
    modelId: "model-alpha",
    requestId: "req-empty-extraction",
    now: createClock([200, 260]),
    collectCompletion: async (_stateStore, request) => ({
      providerId: request.providerId,
      modelId: request.modelId,
      prompt: "USER:\nReply with exactly OK.",
      conversationId: "chat-2",
      completion: {
        content: "",
        responseId: "resp-2",
        eventCount: 3,
        fragmentCount: 0
      },
      upstreamBinding: null
    })
  });
  assert.deepEqual(result, {
    ok: false,
    classification: "empty_extraction",
    providerId: "session-sse",
    modelId: "model-alpha",
    requestId: "req-empty-extraction",
    durationMs: 60,
    prompt: "Reply with exactly OK.",
    conversationId: "chat-2",
    responseId: "resp-2",
    streamEventCount: 3,
    fragmentCount: 0,
    output: "",
    message:
      "Live provider returned no extractable assistant fragments. Possible parser drift in session-sse stream extraction."
  });
});
test("live extraction canary separates empty final output from empty extraction", async () => {
  const result = await runLiveProviderExtractionCanary({
    config: baseConfig,
    providerId: "scripted-chat",
    modelId: "model-beta",
    requestId: "req-empty-output",
    now: createClock([300, 312]),
    collectCompletion: async (_stateStore, request) => ({
      providerId: request.providerId,
      modelId: request.modelId,
      prompt: "USER:\nReply with exactly OK.",
      conversationId: "chat-3",
      completion: {
        content: "   ",
        responseId: "resp-3",
        eventCount: 2,
        fragmentCount: 1
      },
      upstreamBinding: null
    })
  });
  assert.deepEqual(result, {
    ok: false,
    classification: "empty_output",
    providerId: "scripted-chat",
    modelId: "model-beta",
    requestId: "req-empty-output",
    durationMs: 12,
    prompt: "Reply with exactly OK.",
    conversationId: "chat-3",
    responseId: "resp-3",
    streamEventCount: 2,
    fragmentCount: 1,
    output: "",
    message: "SSE stream connected, but final extracted assistant output was empty."
  });
});
test("live extraction canary reports classified provider failures", async () => {
  const result = await runLiveProviderExtractionCanary({
    config: baseConfig,
    providerId: "session-sse",
    modelId: "model-alpha",
    requestId: "req-provider-failure",
    now: createClock([400, 451]),
    collectCompletion: async () => {
      throw new Error("Example request timed out after 30000ms.");
    }
  });
  assert.deepEqual(result, {
    ok: false,
    classification: "provider_failure",
    providerId: "session-sse",
    modelId: "model-alpha",
    requestId: "req-provider-failure",
    durationMs: 51,
    prompt: "Reply with exactly OK.",
    failureCode: "transport_timeout",
    failureKind: "transient",
    message: "Provider request timed out."
  });
});
test("argument parser supports the live extraction canary command", () => {
  const parsed = parseBridgeServerCliArgs({
    argv: [
      "live-canary",
      "--provider",
      "session-sse",
      "--model",
      "model-alpha",
      "--state-root",
      "./.bridge-state",
      "--prompt",
      "Reply with exactly OK.",
      "--expected-substring",
      "OK"
    ],
    env: {
      HOME: "/tmp/test-home",
      BRIDGE_RUNTIME_ROOT: "/tmp/runtime-root"
    }
  });
  assert.deepEqual(parsed, {
    kind: "live-canary",
    config: {
      host: "127.0.0.1",
      port: 4318,
      stateRoot: path.resolve(".bridge-state"),
      runtimeRoot: "/tmp/runtime-root",
      sessionVaultPath: path.resolve("/tmp/test-home", ".bridge", "server", "session-vault"),
      sessionVaultKeyPath: path.resolve(
        "/tmp/test-home",
        ".bridge",
        "server",
        "keys",
        "session-vault.key"
      ),
      defaultProvider: "session-sse",
      defaultModel: "model-alpha",
      maxSteps: 8,
      authToken: undefined,
      corsOrigins: undefined
    },
    stateRoot: path.resolve(".bridge-state"),
    providerId: "session-sse",
    modelId: "model-alpha",
    prompt: "Reply with exactly OK.",
    expectedSubstring: "OK"
  });
});
test("server CLI returns success output for live-canary", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runBridgeServerCli({
    argv: ["live-canary", "--provider", "session-sse", "--model", "model-alpha"],
    stdout,
    stderr,
    runLiveCanary: async () => ({
      ok: true,
      classification: "success",
      providerId: "session-sse",
      modelId: "model-alpha",
      requestId: "req-cli-success",
      durationMs: 19,
      prompt: "Reply with exactly OK.",
      expectedSubstring: "OK",
      expectedSubstringMatched: true,
      conversationId: "chat-cli",
      responseId: "resp-cli",
      streamEventCount: 2,
      fragmentCount: 1,
      output: "OK"
    })
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.text, "");
  assert.match(stdout.text, /status=ok/);
  assert.match(stdout.text, /fragment_count=1/);
});
test("server CLI returns failing exit code and parser drift details for live-canary failures", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runBridgeServerCli({
    argv: ["live-canary", "--provider", "session-sse", "--model", "model-alpha"],
    stdout,
    stderr,
    runLiveCanary: async () => ({
      ok: false,
      classification: "empty_extraction",
      providerId: "session-sse",
      modelId: "model-alpha",
      requestId: "req-cli-fail",
      durationMs: 29,
      prompt: "Reply with exactly OK.",
      conversationId: "chat-cli-fail",
      responseId: "resp-cli-fail",
      streamEventCount: 4,
      fragmentCount: 0,
      output: "",
      message:
        "Live provider returned no extractable assistant fragments. Possible parser drift in session-sse stream extraction."
    })
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.text, "");
  assert.match(stderr.text, /classification=empty_extraction/);
  assert.match(stderr.text, /Possible parser drift in session-sse stream extraction/);
});
test("help text stays transport-agnostic and product-agnostic", () => {
  assert.doesNotMatch(getBridgeServerCliHelpText(), /telegram|openclaw/i);
});
function createClock(values: number[]) {
  let index = 0;
  return () => {
    const value = values[index] ?? values[values.length - 1] ?? 0;
    index += 1;
    return value;
  };
}
function captureStream() {
  return {
    text: "",
    write(value: string) {
      this.text += value;
    }
  };
}
