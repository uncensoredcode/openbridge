import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderTransport,
  ProviderTransportRequest,
  SessionBindingStore,
  UpstreamConversationBinding
} from "../src/index.ts";
import { bridgeRuntime } from "../src/index.ts";

const { SessionBoundProviderAdapter, createFinalResponse } = bridgeRuntime;

function createConversation() {
  return {
    entries: [
      {
        type: "user_message" as const,
        content: "Tell me the package version."
      }
    ]
  };
}

function createStore(initialBinding?: UpstreamConversationBinding) {
  const bindings = new Map<string, UpstreamConversationBinding>();
  const cleared: string[] = [];
  if (initialBinding) {
    bindings.set("session-sse:session-1", initialBinding);
  }
  const store: SessionBindingStore = {
    async loadBinding(providerId, sessionId) {
      return bindings.get(`${providerId}:${sessionId}`) ?? null;
    },
    async saveBinding(providerId, sessionId, binding) {
      bindings.set(`${providerId}:${sessionId}`, binding);
    },
    async clearBinding(providerId, sessionId) {
      cleared.push(`${providerId}:${sessionId}`);
      bindings.delete(`${providerId}:${sessionId}`);
    }
  };
  return {
    store,
    bindings,
    cleared
  };
}

test("session-bound provider saves upstream bindings and reuses them on later turns", async () => {
  const requests: ProviderTransportRequest[] = [];
  const { store, bindings } = createStore();
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content: createFinalResponse("version 0.1.0"),
        upstreamBinding: {
          conversationId: "chat-1",
          parentId: `resp-${requests.length}`
        }
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    sessionId: "session-1",
    sessionBindingStore: store,
    transport
  });
  const first = await adapter.completeTurn({
    conversation: createConversation(),
    availableTools: []
  });
  const second = await adapter.completeTurn({
    conversation: createConversation(),
    availableTools: []
  });
  assert.equal(first, createFinalResponse("version 0.1.0"));
  assert.equal(second, createFinalResponse("version 0.1.0"));
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.upstreamBinding, null);
  assert.deepEqual(requests[1]?.upstreamBinding, {
    conversationId: "chat-1",
    parentId: "resp-1"
  });
  assert.match(requests[1]?.messages[0]?.content ?? "", /already-primed upstream provider session/);
  assert.deepEqual(bindings.get("session-sse:session-1"), {
    conversationId: "chat-1",
    parentId: "resp-2",
    runtimePlannerPrimed: true
  });
});

test("session-bound provider reuses conversation id but replays bridge history when upstream parent id is missing", async () => {
  const requests: ProviderTransportRequest[] = [];
  const { store, bindings } = createStore();
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content: createFinalResponse(requests.length === 1 ? "Hello" : "I remember"),
        upstreamBinding: {
          conversationId: "chat-scripted-1",
          parentId: ""
        }
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    sessionId: "session-1",
    sessionBindingStore: store,
    transport
  });
  await adapter.completeTurn({
    conversation: createConversation(),
    availableTools: []
  });
  const second = await adapter.completeTurn({
    conversation: {
      sessionHistory: [
        {
          userMessage: "Tell me the package version.",
          assistantMessage: "Hello",
          assistantMode: "final"
        }
      ],
      entries: [
        {
          type: "user_message",
          content: "What did you just answer?"
        }
      ]
    },
    availableTools: []
  });
  assert.equal(second, createFinalResponse("I remember"));
  assert.deepEqual(requests[1]?.upstreamBinding, {
    conversationId: "chat-scripted-1",
    parentId: ""
  });
  assert.match(requests[1]?.messages[0]?.content ?? "", /You are a bridge runtime assistant\./);
  assert.match(
    requests[1]?.messages[1]?.content ?? "",
    /Resume this bridge session from the durable bridge-owned conversation history below\./
  );
  assert.deepEqual(bindings.get("session-sse:session-1"), {
    conversationId: "chat-scripted-1",
    parentId: "",
    runtimePlannerPrimed: false
  });
});

test("repair lane uses a fresh isolated session and does not replay prior bridge turns", async () => {
  const requests: ProviderTransportRequest[] = [];
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      return {
        content: createFinalResponse("Repaired answer.")
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    sessionId: "session-1",
    transport
  });
  const repaired = await adapter.repairInvalidResponse({
    conversation: {
      sessionHistory: [
        {
          userMessage: "Earlier request that should not be replayed into repair.",
          assistantMessage: "Earlier answer that should not be replayed into repair.",
          assistantMode: "final"
        }
      ],
      entries: [
        {
          type: "user_message",
          content: "Read package.json."
        }
      ]
    },
    availableTools: [],
    invalidResponse: "answer directly please",
    validationError: "Invalid assistant response: expected exactly one <final> block."
  });
  assert.equal(repaired, createFinalResponse("Repaired answer."));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.lane, "repair");
  assert.equal(requests[0]?.upstreamBinding, null);
  assert.equal(requests[0]?.providerSessionReused, false);
  assert.notEqual(requests[0]?.sessionId, "session-1");
  const userPrompt = requests[0]?.messages[1]?.content ?? "";
  assert.match(userPrompt, /Latest user request:\nRead package\.json\./);
  assert.doesNotMatch(userPrompt, /Earlier request that should not be replayed into repair/);
});

test("session-bound provider retries once and then resets the upstream binding on empty follow-up output", async () => {
  const requests: ProviderTransportRequest[] = [];
  const { store, cleared } = createStore({
    conversationId: "chat-1",
    parentId: "resp-1",
    runtimePlannerPrimed: true
  });
  const transport: ProviderTransport = {
    async completeChat(request) {
      requests.push(request);
      if (requests.length < 3) {
        return {
          content: ""
        };
      }
      return {
        content: createFinalResponse("Recovered"),
        upstreamBinding: {
          conversationId: "chat-2",
          parentId: "resp-3"
        }
      };
    }
  };
  const adapter = new SessionBoundProviderAdapter({
    providerId: "session-sse",
    modelId: "model-alpha",
    sessionId: "session-1",
    sessionBindingStore: store,
    transport
  });
  const output = await adapter.completeTurn({
    conversation: {
      sessionHistory: [
        {
          userMessage: "Tell me the package version.",
          assistantMessage: "0.1.0",
          assistantMode: "final"
        }
      ],
      entries: [
        {
          type: "user_message",
          content: "What did I ask before?"
        }
      ]
    },
    availableTools: []
  });
  assert.equal(output, createFinalResponse("Recovered"));
  assert.equal(cleared.length, 1);
  assert.equal(requests[0]?.upstreamBinding?.conversationId, "chat-1");
  assert.equal(requests[2]?.upstreamBinding, null);
  assert.match(requests[2]?.messages[1]?.content ?? "", /Previous bridge turns:/);
});
