import { bridgeRuntime } from "@uncensoredcode/openbridge/runtime";

import { outputModule } from "../../shared/output.ts";

const { extractPacketMessage, ProviderFailure } = bridgeRuntime;
const { sanitizeBridgeApiOutput } = outputModule;
type CollectedProviderCompletion = {
  content: string;
  responseId: string;
  conversationId: string;
  eventCount: number;
  fragmentCount: number;
};
type ProviderStreamFragment = {
  content: string;
  responseId: string;
  conversationId: string;
  eventCountDelta: number;
  fragmentCountDelta: number;
};
type ProviderStreamEventParser = (
  parts: string[],
  rawLine: string,
  currentResponseId: string,
  currentConversationId: string
) => {
  responseId: string;
  conversationId: string;
  eventCountDelta: number;
  fragmentCountDelta: number;
};
async function collectSseCompletion(
  stream: ReadableStream<Uint8Array> | null,
  pushEvent: ProviderStreamEventParser,
  finalizeContent?: (content: string) => string
) {
  const completion = await collectProviderCompletion(stream, pushEvent);
  return {
    ...completion,
    content: finalizeContent ? finalizeContent(completion.content) : completion.content
  };
}
async function* streamSseFragments(
  stream: ReadableStream<Uint8Array> | null,
  pushEvent: ProviderStreamEventParser,
  onComplete?: (completion: CollectedProviderCompletion) => void
) {
  yield* streamProviderFragments(stream, pushEvent, onComplete);
}
async function* streamVisibleProviderCompletion(
  stream: ReadableStream<Uint8Array> | null,
  pushEvent: ProviderStreamEventParser,
  onComplete?: (completion: CollectedProviderCompletion) => void
) {
  const rawFragments: string[] = [];
  let emittedContent = "";
  for await (const fragment of streamProviderFragments(stream, pushEvent, onComplete)) {
    rawFragments.push(fragment.content);
    const visibleContent = extractIncrementalPacketMessage(rawFragments.join(""));
    if (
      visibleContent.startsWith(emittedContent) &&
      visibleContent.length > emittedContent.length
    ) {
      const delta = visibleContent.slice(emittedContent.length);
      emittedContent = visibleContent;
      yield delta;
    }
  }
  const finalContent = sanitizeBridgeApiOutput(rawFragments.join("")).content;
  if (finalContent.startsWith(emittedContent) && finalContent.length > emittedContent.length) {
    yield finalContent.slice(emittedContent.length);
  } else if (!emittedContent && finalContent) {
    yield finalContent;
  }
}
function createSseJsonEventParser(input: {
  contentPaths: string[];
  responseIdPaths?: string[];
  conversationIdPaths?: string[];
  eventFilters?: Array<{
    path: string;
    equals: string | number | boolean;
  }>;
}) {
  const contentPaths = input.contentPaths.map((path) => splitPath(path));
  const responseIdPaths = (input.responseIdPaths ?? []).map((path) => splitPath(path));
  const conversationIdPaths = (input.conversationIdPaths ?? []).map((path) => splitPath(path));
  const eventFilters = (input.eventFilters ?? []).map((filter) => ({
    path: splitPath(filter.path),
    equals: filter.equals
  }));
  const patchState = createPatchContentState();
  return (
    parts: string[],
    rawLine: string,
    currentResponseId: string,
    currentConversationId: string
  ) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("event:")) {
      return {
        responseId: currentResponseId,
        conversationId: currentConversationId,
        eventCountDelta: 0,
        fragmentCountDelta: 0
      };
    }
    const normalized = line.startsWith("data:") ? line.slice("data:".length).trim() : line;
    if (!normalized || normalized === "[DONE]") {
      return {
        responseId: currentResponseId,
        conversationId: currentConversationId,
        eventCountDelta: 0,
        fragmentCountDelta: 0
      };
    }
    try {
      const payload = JSON.parse(normalized) as Record<string, unknown>;
      const responseId = extractConfiguredString(payload, responseIdPaths) || currentResponseId;
      const conversationId =
        extractConfiguredString(payload, conversationIdPaths) || currentConversationId;
      if (!matchesEventFilters(payload, eventFilters)) {
        return {
          responseId,
          conversationId,
          eventCountDelta: 0,
          fragmentCountDelta: 0
        };
      }
      const fragments = extractConfiguredFragments(payload, contentPaths);
      const patchedFragments =
        fragments.length === 0 ? extractPatchedContentFragments(payload, patchState) : [];
      if (patchedFragments.length > 0) {
        fragments.push(...patchedFragments);
      }
      parts.push(...fragments);
      return {
        responseId,
        conversationId,
        eventCountDelta: 1,
        fragmentCountDelta: fragments.length
      };
    } catch {
      return {
        responseId: currentResponseId,
        conversationId: currentConversationId,
        eventCountDelta: 0,
        fragmentCountDelta: 0
      };
    }
  };
}
async function collectConnectJsonCompletion(
  stream: ReadableStream<Uint8Array> | null,
  input: {
    contentPaths: string[];
    responseIdPaths?: string[];
    conversationIdPaths?: string[];
    eventFilters?: Array<{
      path: string;
      equals: string | number | boolean;
    }>;
  },
  finalizeContent?: (content: string) => string
) {
  const completion = await collectConnectProviderCompletion(stream, input);
  return {
    ...completion,
    content: finalizeContent ? finalizeContent(completion.content) : completion.content
  };
}
async function* streamConnectJsonFragments(
  stream: ReadableStream<Uint8Array> | null,
  input: {
    contentPaths: string[];
    responseIdPaths?: string[];
    conversationIdPaths?: string[];
    eventFilters?: Array<{
      path: string;
      equals: string | number | boolean;
    }>;
  },
  onComplete?: (completion: CollectedProviderCompletion) => void
) {
  yield* streamConnectProviderFragments(stream, input, onComplete);
}
function extractIncrementalPacketMessage(content: string) {
  const finalStart = content.search(/<final>/i);
  if (finalStart >= 0) {
    const finalContent = content.slice(finalStart + "<final>".length);
    const finalEnd = finalContent.search(/<\/final>/i);
    return finalEnd >= 0 ? finalContent.slice(0, finalEnd) : finalContent;
  }
  const packetStart = content.search(/<(?:zc_packet|packet)\b/i);
  if (packetStart < 0) {
    return "";
  }
  const packetContent = content.slice(packetStart);
  const messageStartMatch = packetContent.match(/<message>/i);
  if (!messageStartMatch) {
    return "";
  }
  const messageStartIndex = (messageStartMatch.index ?? 0) + messageStartMatch[0].length;
  const messageBody = packetContent.slice(messageStartIndex);
  if (/^<!\[CDATA\[/i.test(messageBody)) {
    const cdataBody = messageBody.slice("<![CDATA[".length);
    const cdataEnd = cdataBody.indexOf("]]>");
    return cdataEnd >= 0 ? (extractPacketMessage(packetContent) ?? "") : cdataBody;
  }
  const messageEnd = messageBody.search(/<\/message>/i);
  if (messageEnd >= 0) {
    const messageContent = messageBody.slice(0, messageEnd);
    return /</.test(messageContent) ? "" : messageContent;
  }
  return /</.test(messageBody) ? "" : messageBody;
}
function normalizeLeadingAssistantBlock(content: string) {
  const trimmed = content.trim();
  return (
    extractLeadingSimpleAssistantBlock(trimmed, "final") ??
    extractLeadingSimpleAssistantBlock(trimmed, "tool") ??
    extractLatestSimpleAssistantBlock(trimmed) ??
    trimmed
  );
}
async function collectProviderCompletion(
  stream: ReadableStream<Uint8Array> | null,
  pushEvent: ProviderStreamEventParser
): Promise<CollectedProviderCompletion> {
  if (!stream) {
    return {
      content: "",
      responseId: "",
      conversationId: "",
      eventCount: 0,
      fragmentCount: 0
    };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parts: string[] = [];
  let responseId = "";
  let conversationId = "";
  let eventCount = 0;
  let fragmentCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const result = pushEvent(parts, rawLine, responseId, conversationId);
      responseId = result.responseId;
      conversationId = result.conversationId;
      eventCount += result.eventCountDelta;
      fragmentCount += result.fragmentCountDelta;
    }
  }
  const finalResult = pushEvent(parts, buffer, responseId, conversationId);
  return {
    content: parts.join("").trim(),
    responseId: finalResult.responseId,
    conversationId: finalResult.conversationId,
    eventCount: eventCount + finalResult.eventCountDelta,
    fragmentCount: fragmentCount + finalResult.fragmentCountDelta
  };
}
async function* streamProviderFragments(
  stream: ReadableStream<Uint8Array> | null,
  pushEvent: ProviderStreamEventParser,
  onComplete?: (completion: CollectedProviderCompletion) => void
) {
  const rawFragments: string[] = [];
  let responseId = "";
  let conversationId = "";
  let eventCount = 0;
  let fragmentCount = 0;
  for await (const fragment of iterateProviderFragments(stream, pushEvent)) {
    rawFragments.push(fragment.content);
    responseId = fragment.responseId;
    conversationId = fragment.conversationId;
    eventCount += fragment.eventCountDelta;
    fragmentCount += fragment.fragmentCountDelta;
    yield fragment;
  }
  onComplete?.({
    content: rawFragments.join("").trim(),
    responseId,
    conversationId,
    eventCount,
    fragmentCount
  });
}
async function* iterateProviderFragments(
  stream: ReadableStream<Uint8Array> | null,
  pushEvent: ProviderStreamEventParser
): AsyncGenerator<ProviderStreamFragment> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseId = "";
  let conversationId = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const parts: string[] = [];
      const result = pushEvent(parts, rawLine, responseId, conversationId);
      responseId = result.responseId;
      conversationId = result.conversationId;
      for (const fragment of parts) {
        if (fragment) {
          yield {
            content: fragment,
            responseId,
            conversationId,
            eventCountDelta: result.eventCountDelta,
            fragmentCountDelta: result.fragmentCountDelta
          };
        }
      }
    }
  }
  const parts: string[] = [];
  const result = pushEvent(parts, buffer, responseId, conversationId);
  responseId = result.responseId;
  conversationId = result.conversationId;
  for (const fragment of parts) {
    if (fragment) {
      yield {
        content: fragment,
        responseId,
        conversationId,
        eventCountDelta: result.eventCountDelta,
        fragmentCountDelta: result.fragmentCountDelta
      };
    }
  }
}
async function collectConnectProviderCompletion(
  stream: ReadableStream<Uint8Array> | null,
  input: {
    contentPaths: string[];
    responseIdPaths?: string[];
    conversationIdPaths?: string[];
    eventFilters?: Array<{
      path: string;
      equals: string | number | boolean;
    }>;
  }
): Promise<CollectedProviderCompletion> {
  const fragments: string[] = [];
  let responseId = "";
  let conversationId = "";
  let eventCount = 0;
  let fragmentCount = 0;
  for await (const fragment of iterateConnectProviderFragments(stream, input)) {
    fragments.push(fragment.content);
    responseId = fragment.responseId;
    conversationId = fragment.conversationId;
    eventCount += fragment.eventCountDelta;
    fragmentCount += fragment.fragmentCountDelta;
  }
  return {
    content: fragments.join("").trim(),
    responseId,
    conversationId,
    eventCount,
    fragmentCount
  };
}
async function* streamConnectProviderFragments(
  stream: ReadableStream<Uint8Array> | null,
  input: {
    contentPaths: string[];
    responseIdPaths?: string[];
    conversationIdPaths?: string[];
    eventFilters?: Array<{
      path: string;
      equals: string | number | boolean;
    }>;
  },
  onComplete?: (completion: CollectedProviderCompletion) => void
) {
  const rawFragments: string[] = [];
  let responseId = "";
  let conversationId = "";
  let eventCount = 0;
  let fragmentCount = 0;
  for await (const fragment of iterateConnectProviderFragments(stream, input)) {
    rawFragments.push(fragment.content);
    responseId = fragment.responseId;
    conversationId = fragment.conversationId;
    eventCount += fragment.eventCountDelta;
    fragmentCount += fragment.fragmentCountDelta;
    yield fragment;
  }
  onComplete?.({
    content: rawFragments.join("").trim(),
    responseId,
    conversationId,
    eventCount,
    fragmentCount
  });
}
async function* iterateConnectProviderFragments(
  stream: ReadableStream<Uint8Array> | null,
  input: {
    contentPaths: string[];
    responseIdPaths?: string[];
    conversationIdPaths?: string[];
    eventFilters?: Array<{
      path: string;
      equals: string | number | boolean;
    }>;
  }
): AsyncGenerator<ProviderStreamFragment> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const contentPaths = input.contentPaths.map((path) => splitPath(path));
  const responseIdPaths = (input.responseIdPaths ?? []).map((path) => splitPath(path));
  const conversationIdPaths = (input.conversationIdPaths ?? []).map((path) => splitPath(path));
  const eventFilters = (input.eventFilters ?? []).map((filter) => ({
    path: splitPath(filter.path),
    equals: filter.equals
  }));
  let responseId = "";
  let conversationId = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer = concatUint8Arrays(buffer, value);
    while (buffer.length >= 5) {
      const messageLength = readConnectEnvelopeLength(buffer);
      const totalLength = 5 + messageLength;
      if (buffer.length < totalLength) {
        break;
      }
      const envelope = buffer.slice(0, totalLength);
      buffer = buffer.slice(totalLength);
      const fragment = parseConnectEnvelope(
        envelope,
        contentPaths,
        responseIdPaths,
        conversationIdPaths,
        eventFilters,
        responseId,
        conversationId
      );
      if (!fragment) {
        continue;
      }
      responseId = fragment.responseId;
      conversationId = fragment.conversationId;
      yield fragment;
    }
  }
  if (buffer.length > 0) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: "Provider returned a truncated Connect stream.",
      displayMessage: "Provider response format is invalid.",
      retryable: false,
      sessionResetEligible: false
    });
  }
}
function extractLeadingSimpleAssistantBlock(content: string, tag: "final" | "tool") {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  if (!content.startsWith(openTag)) {
    return null;
  }
  const closeIndex = content.indexOf(closeTag);
  if (closeIndex < 0) {
    return null;
  }
  const inner = content.slice(openTag.length, closeIndex);
  if (containsNestedAssistantBlockMarker(inner)) {
    return null;
  }
  const block = content.slice(0, closeIndex + closeTag.length);
  const trailing = content.slice(closeIndex + closeTag.length).trim();
  if (!trailing) {
    return block;
  }
  return trailing.includes("<") ? null : block;
}
function containsNestedAssistantBlockMarker(content: string) {
  return /<(?:final|tool)>/i.test(content) || /(?:^|[^<])(?:final|tool)>/i.test(content);
}
function extractLatestSimpleAssistantBlock(content: string) {
  const finalBlock = extractLastSimpleAssistantBlock(content, "final");
  const toolBlock = extractLastSimpleAssistantBlock(content, "tool");
  if (!finalBlock) {
    return toolBlock?.block ?? null;
  }
  if (!toolBlock) {
    return finalBlock.block;
  }
  return finalBlock.index >= toolBlock.index ? finalBlock.block : toolBlock.block;
}
function extractLastSimpleAssistantBlock(content: string, tag: "final" | "tool") {
  const closeTag = `</${tag}>`;
  const closeIndex = content.lastIndexOf(closeTag);
  if (closeIndex < 0) {
    return null;
  }
  const marker = new RegExp(`(?:<)?${tag}>`, "gi");
  let latestMatch: {
    index: number;
    markerLength: number;
  } | null = null;
  for (const match of content.matchAll(marker)) {
    const index = match.index ?? -1;
    if (index < 0 || index >= closeIndex) {
      continue;
    }
    latestMatch = {
      index,
      markerLength: match[0].length
    };
  }
  if (!latestMatch) {
    return null;
  }
  return {
    index: latestMatch.index,
    block: `<${tag}>${content.slice(latestMatch.index + latestMatch.markerLength, closeIndex)}${closeTag}`
  };
}
function splitPath(path: string) {
  return path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}
function extractConfiguredString(payload: Record<string, unknown>, paths: string[][]) {
  for (const path of paths) {
    for (const value of extractPathValues(payload, path)) {
      const normalized = normalizeProviderResponseId(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}
function extractConfiguredFragments(payload: Record<string, unknown>, paths: string[][]) {
  const fragments: string[] = [];
  const filteredPaths = filterNonAssistantMessageContentPaths(payload, paths);
  for (const path of filteredPaths) {
    for (const value of extractPathValues(payload, path)) {
      if (typeof value === "string" && value) {
        const normalized = normalizeProviderContentFragment(value);
        if (normalized) {
          fragments.push(normalized);
        }
      }
    }
  }
  return fragments;
}
type PatchContentState = {
  fragmentTypes: Map<string, string>;
  pendingContent: Map<string, string[]>;
  currentPath: string;
  currentOp: string;
  collectionLastIndex: Map<string, number>;
};
type FlattenedPatchOperation = {
  path: string;
  op: string;
  value: unknown;
};
function createPatchContentState(): PatchContentState {
  return {
    fragmentTypes: new Map(),
    pendingContent: new Map(),
    currentPath: "",
    currentOp: "SET",
    collectionLastIndex: new Map()
  };
}
function extractPatchedContentFragments(
  payload: Record<string, unknown>,
  state: PatchContentState
) {
  const fragments: string[] = [];
  for (const operation of flattenPatchOperations(payload, state)) {
    collectPatchContentFromStructuredValue(operation.value, state, fragments);
    const fragmentPath = parseResponseFragmentPath(operation.path, state);
    if (!fragmentPath) {
      continue;
    }
    if (fragmentPath.kind === "collection") {
      collectFragmentArray(fragmentPath.basePath, operation.value, state, fragments, operation.op);
      continue;
    }
    if (fragmentPath.kind === "fragment") {
      collectFragmentRecord(fragmentPath.basePath, operation.value, state, fragments);
      continue;
    }
    if (
      fragmentPath.kind === "field" &&
      fragmentPath.field === "type" &&
      typeof operation.value === "string"
    ) {
      setFragmentType(fragmentPath.basePath, operation.value, state, fragments);
      continue;
    }
    if (
      fragmentPath.kind === "field" &&
      fragmentPath.field === "content" &&
      typeof operation.value === "string"
    ) {
      pushFragmentContent(fragmentPath.basePath, operation.value, state, fragments);
    }
  }
  return fragments;
}
function flattenPatchOperations(
  payload: Record<string, unknown>,
  state: PatchContentState
): FlattenedPatchOperation[] {
  const parserState = {
    path: state.currentPath,
    op: state.currentOp
  };
  const operations = flattenPatchOperation(
    {
      p: typeof payload.p === "string" ? payload.p : "",
      o: typeof payload.o === "string" ? payload.o : "",
      v: "v" in payload ? payload.v : payload
    },
    parserState
  );
  state.currentPath = parserState.path;
  state.currentOp = parserState.op;
  return operations;
}
function flattenPatchOperation(
  input: {
    p: string;
    o: string;
    v: unknown;
  },
  parserState: {
    path: string;
    op: string;
  }
): FlattenedPatchOperation[] {
  const operation = input.o.trim().toUpperCase() || parserState.op || "SET";
  const path = input.p.trim() || parserState.path || "";
  parserState.op = operation;
  parserState.path = path;
  if (operation !== "BATCH") {
    return [
      {
        path,
        op: operation,
        value: input.v
      }
    ];
  }
  if (!Array.isArray(input.v)) {
    return [];
  }
  const batchState = {
    path: "",
    op: "SET"
  };
  return input.v.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    return flattenPatchOperation(
      {
        p: typeof record.p === "string" ? record.p : "",
        o: typeof record.o === "string" ? record.o : "",
        v: "v" in record ? record.v : record
      },
      batchState
    ).map((nestedOperation) => ({
      ...nestedOperation,
      path: joinPatchPaths(path, nestedOperation.path)
    }));
  });
}
function joinPatchPaths(basePath: string, nextPath: string) {
  if (!basePath) {
    return nextPath;
  }
  if (!nextPath) {
    return basePath;
  }
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const normalizedNext = nextPath.startsWith("/") ? nextPath.slice(1) : nextPath;
  return `${normalizedBase}/${normalizedNext}`;
}
function collectPatchContentFromStructuredValue(
  value: unknown,
  state: PatchContentState,
  fragments: string[]
) {
  for (const [path, basePath] of [
    ["response.fragments", "/response/fragments"],
    ["v.response.fragments", "/response/fragments"],
    ["fragments", "/response/fragments"]
  ] as const) {
    const fragmentArrays = extractPathValues(value, splitPath(path));
    for (const fragmentArray of fragmentArrays) {
      collectFragmentArray(basePath, fragmentArray, state, fragments, "SET");
    }
  }
}
function collectFragmentArray(
  basePath: string,
  value: unknown,
  state: PatchContentState,
  fragments: string[],
  operation: string
) {
  if (!Array.isArray(value)) {
    return;
  }
  const startIndex =
    operation === "APPEND" ? (state.collectionLastIndex.get(basePath) ?? -1) + 1 : 0;
  value.forEach((entry, index) => {
    collectFragmentRecord(`${basePath}/${startIndex + index}`, entry, state, fragments);
  });
  state.collectionLastIndex.set(basePath, startIndex + value.length - 1);
}
function collectFragmentRecord(
  basePath: string,
  value: unknown,
  state: PatchContentState,
  fragments: string[]
) {
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type) {
    setFragmentType(basePath, type, state, fragments);
  }
  if (typeof record.content === "string") {
    pushFragmentContent(basePath, record.content, state, fragments);
  }
}
function setFragmentType(
  basePath: string,
  type: string,
  state: PatchContentState,
  fragments: string[]
) {
  const normalizedType = type.trim().toUpperCase();
  if (!normalizedType) {
    return;
  }
  state.fragmentTypes.set(basePath, normalizedType);
  const pending = state.pendingContent.get(basePath) ?? [];
  state.pendingContent.delete(basePath);
  if (!isVisibleResponseFragmentType(normalizedType)) {
    return;
  }
  for (const content of pending) {
    if (content) {
      fragments.push(content);
    }
  }
}
function pushFragmentContent(
  basePath: string,
  content: string,
  state: PatchContentState,
  fragments: string[]
) {
  if (!content) {
    return;
  }
  const type = state.fragmentTypes.get(basePath);
  if (!type) {
    fragments.push(content);
    return;
  }
  if (isVisibleResponseFragmentType(type)) {
    fragments.push(content);
  }
}
function isVisibleResponseFragmentType(type: string) {
  return type === "RESPONSE" || type === "TEMPLATE_RESPONSE";
}
function parseResponseFragmentPath(path: string, state: PatchContentState) {
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  const normalized = segments.map((segment) => segment.toLowerCase());
  const rootOffset = normalized[0] === "response" ? 1 : 0;
  if (normalized[rootOffset] !== "fragments") {
    return null;
  }
  const basePathRoot = "/response/fragments";
  if (normalized.length === rootOffset + 1) {
    return {
      kind: "collection" as const,
      basePath: basePathRoot
    };
  }
  const fragmentIndexToken = normalized[rootOffset + 1] ?? "";
  const fragmentIndex =
    fragmentIndexToken === "-1"
      ? (state.collectionLastIndex.get(basePathRoot) ?? -1)
      : Number.parseInt(fragmentIndexToken, 10);
  if (!Number.isInteger(fragmentIndex)) {
    return null;
  }
  const basePath = `${basePathRoot}/${fragmentIndex}`;
  if (normalized.length === rootOffset + 2) {
    return {
      kind: "fragment" as const,
      basePath
    };
  }
  return {
    kind: "field" as const,
    basePath,
    field: normalized[rootOffset + 2] ?? ""
  };
}
function filterNonAssistantMessageContentPaths(
  payload: Record<string, unknown>,
  paths: string[][]
) {
  const message = readProviderMessageRecord(payload);
  if (!message || typeof message !== "object") {
    return paths;
  }
  const role = readProviderMessageRole(message);
  if (!role || role === "assistant") {
    return paths;
  }
  return paths.filter((path) => path[0] !== "message");
}
function readProviderMessageRecord(payload: Record<string, unknown>) {
  const direct = payload.message;
  if (direct && typeof direct === "object") {
    return direct as Record<string, unknown>;
  }
  const nestedValue = payload.v;
  if (!nestedValue || typeof nestedValue !== "object") {
    return null;
  }
  const nestedMessage = (nestedValue as Record<string, unknown>).message;
  return nestedMessage && typeof nestedMessage === "object"
    ? (nestedMessage as Record<string, unknown>)
    : null;
}
function readProviderMessageRole(message: Record<string, unknown>) {
  const directRole = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
  if (directRole) {
    return directRole;
  }
  const author = message.author;
  if (!author || typeof author !== "object") {
    return "";
  }
  return typeof (author as Record<string, unknown>).role === "string"
    ? String((author as Record<string, unknown>).role)
        .trim()
        .toLowerCase()
    : "";
}
function normalizeProviderContentFragment(value: string) {
  if (isHiddenInlineReferenceToken(value)) {
    return "";
  }
  return value;
}
function isHiddenInlineReferenceToken(value: string) {
  return /^\uE200[A-Za-z0-9_-]+\uE202[\s\S]*\uE201$/u.test(value.trim());
}
function extractPathValues(value: unknown, segments: string[]): unknown[] {
  if (segments.length === 0) {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  const [segment, ...rest] = segments;
  if (segment === "*") {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => extractPathValues(entry, rest));
    }
    if (typeof value === "object") {
      return Object.values(value as Record<string, unknown>).flatMap((entry) =>
        extractPathValues(entry, rest)
      );
    }
    return [];
  }
  if (Array.isArray(value)) {
    const index = Number.parseInt(segment, 10);
    if (!Number.isInteger(index)) {
      return [];
    }
    return extractPathValues(value[index], rest);
  }
  if (typeof value === "object") {
    return extractPathValues((value as Record<string, unknown>)[segment], rest);
  }
  return [];
}
function normalizeProviderResponseId(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}
function parseConnectEnvelope(
  envelope: Uint8Array,
  contentPaths: string[][],
  responseIdPaths: string[][],
  conversationIdPaths: string[][],
  eventFilters: Array<{
    path: string[];
    equals: string | number | boolean;
  }>,
  currentResponseId: string,
  currentConversationId: string
) {
  const flags = envelope[0] ?? 0;
  if ((flags & 0x01) !== 0) {
    throw new ProviderFailure({
      kind: "permanent",
      code: "request_invalid",
      message: "Provider returned a compressed Connect message, which is not supported yet.",
      displayMessage: "Provider response format is unsupported.",
      retryable: false,
      sessionResetEligible: false
    });
  }
  const payloadBytes = envelope.slice(5);
  const payloadText = new TextDecoder().decode(payloadBytes).trim();
  if (!payloadText) {
    return null;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    return null;
  }
  if ((flags & 0x02) !== 0) {
    const error = readConnectEndStreamError(payload);
    if (error) {
      throw new ProviderFailure({
        kind: error.retryable ? "transient" : "permanent",
        code: error.retryable ? "transport_error" : "request_invalid",
        message: `Provider Connect stream ended with error code "${error.code}"${error.message ? `: ${error.message}` : "."}`,
        displayMessage: error.message || "Provider request failed.",
        retryable: error.retryable,
        sessionResetEligible: false,
        details: {
          upstreamCode: error.code
        }
      });
    }
    return null;
  }
  const nextResponseId = extractConfiguredString(payload, responseIdPaths) || currentResponseId;
  const nextConversationId =
    extractConfiguredString(payload, conversationIdPaths) || currentConversationId;
  if (!matchesEventFilters(payload, eventFilters)) {
    return {
      content: "",
      responseId: nextResponseId,
      conversationId: nextConversationId,
      eventCountDelta: 0,
      fragmentCountDelta: 0
    } satisfies ProviderStreamFragment;
  }
  const fragments = extractConfiguredFragments(payload, contentPaths);
  return {
    content: fragments.join(""),
    responseId: nextResponseId,
    conversationId: nextConversationId,
    eventCountDelta: fragments.length > 0 ? 1 : 0,
    fragmentCountDelta: fragments.length
  } satisfies ProviderStreamFragment;
}
function matchesEventFilters(
  payload: Record<string, unknown>,
  filters: Array<{
    path: string[];
    equals: string | number | boolean;
  }>
) {
  if (filters.length === 0) {
    return true;
  }
  return filters.every((filter) =>
    extractPathValues(payload, filter.path).some((value) => value === filter.equals)
  );
}
function readConnectEnvelopeLength(buffer: Uint8Array) {
  return (
    ((buffer[1] ?? 0) << 24) | ((buffer[2] ?? 0) << 16) | ((buffer[3] ?? 0) << 8) | (buffer[4] ?? 0)
  );
}
function concatUint8Arrays(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}
function readConnectEndStreamError(payload: Record<string, unknown>) {
  const error = payload.error;
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.trim() : "";
  if (!code) {
    return null;
  }
  const message = typeof record.message === "string" ? record.message.trim() : "";
  return {
    code,
    message,
    retryable: /^(aborted|deadline_exceeded|resource_exhausted|unavailable)$/i.test(code)
  };
}

export const providerStreamsModule = {
  collectSseCompletion,
  streamSseFragments,
  streamVisibleProviderCompletion,
  createSseJsonEventParser,
  collectConnectJsonCompletion,
  streamConnectJsonFragments,
  extractIncrementalPacketMessage,
  normalizeLeadingAssistantBlock
};

export type { CollectedProviderCompletion, ProviderStreamEventParser, ProviderStreamFragment };
