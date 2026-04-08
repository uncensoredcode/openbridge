import assert from "node:assert/strict";
import test from "node:test";

import { providerStreamsModule } from "../src/bridge/providers/provider-streams.ts";

const { collectSseCompletion, createSseJsonEventParser, normalizeLeadingAssistantBlock } =
  providerStreamsModule;
test("generic SSE collector extracts configured fragments and response ids", async () => {
  const stream = createStream([
    'data: {"meta":{"responseId":"resp-1"}}\n',
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
    "data: [DONE]\n"
  ]);
  const completion = await collectSseCompletion(
    stream,
    createSseJsonEventParser({
      contentPaths: ["choices.0.delta.content"],
      responseIdPaths: ["meta.responseId"]
    })
  );
  assert.equal(completion.content, "Hello");
  assert.equal(completion.responseId, "resp-1");
  assert.equal(completion.eventCount, 3);
  assert.equal(completion.fragmentCount, 2);
});
test("generic SSE collector ignores payloads that do not match configured content paths", async () => {
  const stream = createStream([
    'data: {"meta":{"responseId":"resp-2"},"contents":[{"type":"control"}]}\n',
    "data: [DONE]\n"
  ]);
  const completion = await collectSseCompletion(
    stream,
    createSseJsonEventParser({
      contentPaths: ["choices.0.delta.content"],
      responseIdPaths: ["meta.responseId"]
    })
  );
  assert.equal(completion.content, "");
  assert.equal(completion.responseId, "resp-2");
  assert.equal(completion.eventCount, 1);
  assert.equal(completion.fragmentCount, 0);
});
test("generic SSE collector stringifies numeric response ids", async () => {
  const stream = createStream([
    'data: {"message":{"id":2},"choices":[{"delta":{"content":"OK"}}]}\n',
    "data: [DONE]\n"
  ]);
  const completion = await collectSseCompletion(
    stream,
    createSseJsonEventParser({
      contentPaths: ["choices.0.delta.content"],
      responseIdPaths: ["message.id"]
    })
  );
  assert.equal(completion.content, "OK");
  assert.equal(completion.responseId, "2");
  assert.equal(completion.eventCount, 1);
  assert.equal(completion.fragmentCount, 1);
});
test("generic SSE collector extracts patch-style content deltas and nested response ids", async () => {
  const stream = createStream([
    'data: {"response_message_id":2}\n',
    'data: {"v":{"response":{"message_id":2,"fragments":[{"content":"Hel"}]}}}\n',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"lo"}\n',
    "data: [DONE]\n"
  ]);
  const completion = await collectSseCompletion(
    stream,
    createSseJsonEventParser({
      contentPaths: ["v.response.fragments.*.content"],
      responseIdPaths: ["response_message_id", "v.response.message_id"]
    })
  );
  assert.equal(completion.content, "Hello");
  assert.equal(completion.responseId, "2");
  assert.equal(completion.eventCount, 3);
  assert.equal(completion.fragmentCount, 2);
});
test("generic collected content can trim trailing plain-text metadata after a valid assistant block", () => {
  const content =
    '<tool>{"name":"bash","arguments":{"command":"ping -c 4 localhost"}}</tool>Command title';
  assert.equal(
    normalizeLeadingAssistantBlock(content),
    '<tool>{"name":"bash","arguments":{"command":"ping -c 4 localhost"}}</tool>'
  );
});
function createStream(lines: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    }
  });
}
