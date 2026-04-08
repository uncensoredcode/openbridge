type PacketMode = "final" | "tool_request" | "ask_user" | "fail";
type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};
type ToolResult = {
  id: string;
  name: string;
  ok: boolean;
  payload: unknown;
};
type FinalPacket = {
  mode: "final";
  message: string;
};
type AskUserPacket = {
  mode: "ask_user";
  message: string;
};
type FailPacket = {
  mode: "fail";
  message: string;
};
type ToolRequestPacket = {
  mode: "tool_request";
  toolCall: ToolCall;
};
type ZcPacket = FinalPacket | AskUserPacket | FailPacket | ToolRequestPacket;
class PacketProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PacketProtocolError";
  }
}
function parseZcPacket(rawText: string): ZcPacket {
  const trimmed = rawText.trim();
  const rootMatch = trimmed.match(/^<zc_packet version="1">([\s\S]*)<\/zc_packet>$/);
  if (!rootMatch) {
    throw new PacketProtocolError(
      'Provider output must be exactly one <zc_packet version="1"> document.'
    );
  }
  const rootBody = rootMatch[1] ?? "";
  const modeNode = extractSingleTag(rootBody, "mode");
  const mode = parseMode(modeNode.inner.trim());
  if (mode === "tool_request") {
    const toolNode = extractSingleToolCall(modeNode.remainder);
    return {
      mode,
      toolCall: {
        id: toolNode.id,
        name: toolNode.name,
        args: parseToolArguments(toolNode.inner)
      }
    };
  }
  const messageNode = extractSingleTag(modeNode.remainder, "message");
  return {
    mode,
    message: parseMessageContent(messageNode.inner)
  };
}
function serializeToolResult(result: ToolResult): string {
  return [
    `<tool_result version="1" id="${escapeAttribute(result.id)}" name="${escapeAttribute(result.name)}" ok="${result.ok ? "true" : "false"}">`,
    JSON.stringify(result.payload),
    "</tool_result>"
  ].join("");
}
function createToolRequestPacket(toolCall: ToolCall): string {
  return [
    '<zc_packet version="1">',
    "<mode>tool_request</mode>",
    `<tool_call id="${escapeAttribute(toolCall.id)}" name="${escapeAttribute(toolCall.name)}">`,
    JSON.stringify(toolCall.args),
    "</tool_call>",
    "</zc_packet>"
  ].join("");
}
function createMessagePacket(
  mode: Extract<PacketMode, "final" | "ask_user" | "fail">,
  message: string
): string {
  return [
    '<zc_packet version="1">',
    `<mode>${mode}</mode>`,
    `<message><![CDATA[${message}]]></message>`,
    "</zc_packet>"
  ].join("");
}
function parseMode(value: string): PacketMode {
  switch (value) {
    case "final":
    case "tool_request":
    case "ask_user":
    case "fail":
      return value;
    default:
      throw new PacketProtocolError(`Unsupported packet mode "${value || "(empty)"}".`);
  }
}
function parseToolArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new PacketProtocolError("tool_call body must contain valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new PacketProtocolError("tool_call JSON must decode to an object.");
  }
  return parsed;
}
function parseMessageContent(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    return trimmed.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  if (trimmed.includes("<")) {
    throw new PacketProtocolError("message body must be plain text or a single CDATA section.");
  }
  return trimmed;
}
function extractSingleTag(source: string, tagName: string) {
  const expression = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new PacketProtocolError(`Expected exactly one <${tagName}> element.`);
  }
  const match = matches[0];
  const index = match.index ?? 0;
  const fullMatch = match[0];
  const remainder = `${source.slice(0, index)}${source.slice(index + fullMatch.length)}`;
  if (remainder.trim().length > 0 && tagName !== "mode") {
    throw new PacketProtocolError(`Unexpected content alongside <${tagName}>.`);
  }
  return {
    inner: match[1] ?? "",
    remainder
  };
}
function extractSingleToolCall(source: string) {
  const expression = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/g;
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    throw new PacketProtocolError("Expected exactly one <tool_call> element.");
  }
  const match = matches[0];
  const index = match.index ?? 0;
  const fullMatch = match[0];
  const remainder = `${source.slice(0, index)}${source.slice(index + fullMatch.length)}`;
  if (remainder.trim().length > 0) {
    throw new PacketProtocolError("Unexpected content alongside <tool_call>.");
  }
  const attributes = parseXmlAttributes(match[1] ?? "");
  const id = (attributes.id ?? "").trim();
  const name = (attributes.name ?? "").trim();
  if (!id) {
    throw new PacketProtocolError("tool_call id is required.");
  }
  if (!name) {
    throw new PacketProtocolError("tool_call name is required.");
  }
  return {
    id,
    name,
    inner: match[2] ?? ""
  };
}
function parseXmlAttributes(source: string) {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/\b([A-Za-z_][\w:.-]*)="([^"]*)"/g)) {
    const key = match[1]?.trim();
    if (!key) {
      continue;
    }
    attributes[key] = match[2] ?? "";
  }
  return attributes;
}
function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const protocolModule = {
  PacketProtocolError,
  parseZcPacket,
  serializeToolResult,
  createToolRequestPacket,
  createMessagePacket
};

export type {
  AskUserPacket,
  FailPacket,
  FinalPacket,
  PacketMode,
  PacketProtocolError,
  ToolCall,
  ToolRequestPacket,
  ToolResult,
  ZcPacket
};
