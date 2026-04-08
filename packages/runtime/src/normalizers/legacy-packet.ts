import type { PacketNormalizationResult } from "../packet-normalizer.ts";
import type { PacketMode, ToolCall } from "../protocol.ts";
import { protocolModule } from "../protocol.ts";

const { createMessagePacket, createToolRequestPacket } = protocolModule;
function normalizeLegacyPacket(candidate: string): PacketNormalizationResult {
  const rootMatch = candidate.trim().match(/^<packet\b([^>]*)>([\s\S]*)<\/packet>$/);
  if (!rootMatch) {
    return fail(
      "invalid_provider_packet",
      'Legacy packet normalization expects a single root <packet mode="..."> element.',
      []
    );
  }
  const attributes = rootMatch[1] ?? "";
  const body = rootMatch[2] ?? "";
  const modeMatch = attributes.match(/\bmode="([^"]+)"/);
  if (!modeMatch) {
    return fail(
      "invalid_provider_packet",
      'Legacy packet is missing required mode="..." attribute.',
      []
    );
  }
  const mode = parseMode(modeMatch[1] ?? "");
  if (!mode) {
    return fail(
      "invalid_provider_packet",
      `Legacy packet mode "${(modeMatch[1] ?? "").trim() || "(empty)"}" is not supported.`,
      []
    );
  }
  if (mode === "tool_request") {
    const toolNode = extractSingleTag(body, "tool_call");
    if (!toolNode.ok) {
      return toolNode;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolNode.inner.trim());
    } catch {
      return fail("invalid_provider_packet", "Legacy tool_call body must contain valid JSON.", [
        'Expected an object with string "name" and object "args" fields.'
      ]);
    }
    if (!isRecord(parsed)) {
      return fail("invalid_provider_packet", "Legacy tool_call JSON must decode to an object.", []);
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) {
      return fail(
        "invalid_provider_packet",
        'Legacy tool_call JSON requires a non-empty "name" field.',
        []
      );
    }
    if (!isRecord(parsed.args)) {
      return fail(
        "invalid_provider_packet",
        'Legacy tool_call JSON requires an object "args" field.',
        []
      );
    }
    const toolCall: ToolCall = {
      id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : "call_1",
      name,
      args: parsed.args
    };
    return {
      ok: true,
      strategy: "legacy_packet_v1",
      canonicalPacket: createToolRequestPacket(toolCall),
      notes: [
        `Normalized legacy tool_request for tool "${name}".`,
        `Synthesized tool call id "${toolCall.id}".`
      ]
    };
  }
  const messageNode = extractSingleTag(body, "message");
  if (!messageNode.ok) {
    return messageNode;
  }
  const message = parseMessage(messageNode.inner);
  if (!message.ok) {
    return message;
  }
  return {
    ok: true,
    strategy: "legacy_packet_v1",
    canonicalPacket: createMessagePacket(mode, message.value),
    notes: [`Normalized legacy ${mode} packet into canonical zc_packet form.`]
  };
}
function parseMode(input: string): PacketMode | null {
  switch (input.trim()) {
    case "final":
    case "tool_request":
    case "ask_user":
    case "fail":
      return input.trim() as PacketMode;
    default:
      return null;
  }
}
function extractSingleTag(
  source: string,
  tagName: string
):
  | {
      ok: true;
      inner: string;
    }
  | Extract<
      PacketNormalizationResult,
      {
        ok: false;
      }
    > {
  const expression = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) {
    return fail(
      "invalid_provider_packet",
      `Legacy ${tagName === "tool_call" ? "tool_request" : "message"} packet must contain exactly one <${tagName}> element.`,
      []
    );
  }
  const match = matches[0];
  const index = match.index ?? 0;
  const fullMatch = match[0];
  const remainder = `${source.slice(0, index)}${source.slice(index + fullMatch.length)}`;
  if (remainder.trim().length > 0) {
    return fail(
      "invalid_provider_packet",
      `Legacy <${tagName}> packet contained unexpected content outside <${tagName}>.`,
      []
    );
  }
  return {
    ok: true,
    inner: match[1] ?? ""
  };
}
function parseMessage(raw: string):
  | {
      ok: true;
      value: string;
    }
  | Extract<
      PacketNormalizationResult,
      {
        ok: false;
      }
    > {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    return {
      ok: true,
      value: trimmed.slice("<![CDATA[".length, -"]]>".length).trim()
    };
  }
  if (trimmed.includes("<")) {
    return fail(
      "invalid_provider_packet",
      "Legacy message packets must contain plain text or a single CDATA section.",
      []
    );
  }
  return {
    ok: true,
    value: trimmed
  };
}
function fail(
  code: Extract<
    PacketNormalizationResult,
    {
      ok: false;
    }
  >["code"],
  message: string,
  notes: string[]
): Extract<
  PacketNormalizationResult,
  {
    ok: false;
  }
> {
  return {
    ok: false,
    strategy: "legacy_packet_v1",
    code,
    message,
    notes
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const legacyPacketModule = {
  normalizeLegacyPacket
};
