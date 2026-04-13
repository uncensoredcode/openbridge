import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderAdapter, ProviderTurnInput, RuntimeEvent } from "../src/index.ts";
import { bridgeRuntime } from "../src/index.ts";

const { createFinalResponse, createToolResponse, runBridgeRuntime } = bridgeRuntime;

function createRepairAwareProvider(input: {
  main: (turn: ProviderTurnInput, callIndex: number) => Promise<string> | string;
  repair?: (
    input: {
      conversation: ProviderTurnInput["conversation"];
      invalidResponse: string;
      validationError: string;
    },
    callIndex: number
  ) => Promise<string> | string;
}) {
  const repairInputs: Array<{
    conversation: ProviderTurnInput["conversation"];
    invalidResponse: string;
    validationError: string;
  }> = [];
  let mainCalls = 0;
  let repairCalls = 0;
  const provider: ProviderAdapter = {
    id: "repair-aware-provider",
    async completeTurn(turn) {
      mainCalls += 1;
      return await input.main(turn, mainCalls);
    },
    async repairInvalidResponse(repairInput) {
      if (!input.repair) {
        throw new Error("repair should not be called");
      }
      repairCalls += 1;
      repairInputs.push(repairInput);
      return await input.repair(repairInput, repairCalls);
    }
  };
  return {
    provider,
    repairInputs,
    get mainCalls() {
      return mainCalls;
    },
    get repairCalls() {
      return repairCalls;
    }
  };
}

test("runtime fails closed on malformed assistant responses", async () => {
  const outcome = await runBridgeRuntime({
    userMessage: "bad response please",
    provider: {
      id: "bad-response-provider",
      async completeTurn() {
        return "not a valid block";
      }
    }
  });
  assert.equal(outcome.mode, "fail");
  assert.match(outcome.message, /Invalid assistant response/);
});

test("runtime accepts a repaired final response after one invalid provider output", async () => {
  const events: RuntimeEvent[] = [];
  const provider = createRepairAwareProvider({
    async main() {
      return "The answer is 42.";
    },
    async repair() {
      return createFinalResponse("The answer is 42.");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "What is the answer?",
    provider: provider.provider,
    config: {
      onEvent(event) {
        events.push(event);
      }
    }
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "The answer is 42.");
  assert.equal(provider.mainCalls, 1);
  assert.equal(provider.repairCalls, 1);
  assert.equal(provider.repairInputs[0]?.invalidResponse, "The answer is 42.");
  assert.match(provider.repairInputs[0]?.validationError ?? "", /exactly one <final>/);
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === "main_response_invalid" ||
          event.type === "repair_attempted" ||
          event.type === "repair_valid"
      )
      .map((event) => event.type),
    ["main_response_invalid", "repair_attempted", "repair_valid"]
  );
});

test("runtime accepts a valid leading final block when provider appends trailing metadata text", async () => {
  const provider = createRepairAwareProvider({
    async main() {
      return "<final>Hello</final>User Greeting Response";
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Say hello.",
    provider: provider.provider
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "Hello");
  assert.equal(provider.mainCalls, 1);
  assert.equal(provider.repairCalls, 0);
});

test("runtime recovers the last valid final block when provider echoes protocol text before it", async () => {
  const provider = createRepairAwareProvider({
    async main() {
      return [
        "<final> with no extra spaces or line breaks? Or the previous response had a period? Let me re-emit cleanly.",
        "final>Hello. How can I help?</final>"
      ].join("");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Hello?",
    provider: provider.provider
  });
  assert.equal(outcome.mode, "final");
  assert.equal(outcome.message, "Hello. How can I help?");
  assert.equal(provider.repairCalls, 0);
});

test("runtime rejects tool requests in the pure adapter flow", async () => {
  const outcome = await runBridgeRuntime({
    userMessage: "Inspect the repo",
    provider: {
      id: "tool-provider",
      async completeTurn() {
        return createToolResponse({
          name: "read",
          arguments: {
            path: "package.json"
          }
        });
      }
    }
  });
  assert.equal(outcome.mode, "fail");
  assert.equal(outcome.failure?.source, "protocol");
  assert.equal(outcome.failure?.code, "malformed_provider_packet");
  assert.match(outcome.message, /Tool "read" is not registered/);
});

test("runtime marks repair_failed with provider_failure when the repair attempt throws", async () => {
  const events: RuntimeEvent[] = [];
  const provider = createRepairAwareProvider({
    async main() {
      return "answer directly please";
    },
    async repair() {
      throw new Error("repair transport failed");
    }
  });
  const outcome = await runBridgeRuntime({
    userMessage: "Repair this.",
    provider: provider.provider,
    config: {
      onEvent(event) {
        events.push(event);
      }
    }
  });
  assert.equal(outcome.mode, "fail");
  const repairFailed = events.find((event) => event.type === "repair_failed");
  assert.equal(repairFailed?.reason, "provider_failure");
  assert.match(repairFailed?.providerFailure?.message ?? "", /repair transport failed/);
});
