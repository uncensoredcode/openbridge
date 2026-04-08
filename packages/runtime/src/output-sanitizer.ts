type VisibleModelOutputSanitizationResult =
  | {
      content: string;
      sanitized: false;
    }
  | {
      content: string;
      sanitized: true;
      reason: string;
    };
function sanitizeVisibleModelOutput(
  content: string,
  options: {
    packetMessageReason: string;
    documentReason: string;
    controlReason: string;
    fallbackMessage: string;
    documentFallbackMessage: string;
  }
): VisibleModelOutputSanitizationResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return {
      content,
      sanitized: false
    };
  }
  if (/^<(?:final|tool|zc_packet|packet)\b/i.test(trimmed)) {
    const extractedMessage = extractPacketMessage(trimmed);
    if (extractedMessage) {
      return {
        content: extractedMessage,
        sanitized: true,
        reason: options.packetMessageReason
      };
    }
    return {
      content: options.fallbackMessage,
      sanitized: true,
      reason: "packet_reply_suppressed"
    };
  }
  if (/\[DOCUMENT:[^\]]+\]/i.test(trimmed)) {
    return {
      content: options.documentFallbackMessage,
      sanitized: true,
      reason: options.documentReason
    };
  }
  if (looksLikeInternalControlText(trimmed)) {
    return {
      content: options.fallbackMessage,
      sanitized: true,
      reason: options.controlReason
    };
  }
  return {
    content,
    sanitized: false
  };
}
function extractPacketMessage(content: string) {
  const finalMatch = content.match(/<final>([\s\S]*?)<\/final>/i);
  if (finalMatch) {
    const finalMessage = (finalMatch[1] ?? "").trim();
    return finalMessage || null;
  }
  const messageMatch = content.match(/<message>([\s\S]*?)<\/message>/i);
  if (!messageMatch) {
    return null;
  }
  const rawMessage = (messageMatch[1] ?? "").trim();
  if (!rawMessage) {
    return null;
  }
  const cdataMatch = rawMessage.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  const value = (cdataMatch?.[1] ?? rawMessage).trim();
  return value || null;
}
function looksLikeInternalControlText(content: string) {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("use <final>...</final>") ||
    normalized.includes('use <tool>{"name":"tool_name","arguments":{...}}</tool>') ||
    normalized.includes("respond with exactly one block and nothing else") ||
    normalized.includes("protocol error.") ||
    normalized.includes("return exactly one zc_packet") ||
    normalized.includes("respond with exactly one xml packet") ||
    normalized.includes("continue the same task using the tool result below") ||
    normalized.includes("do not wrap xml in explanations") ||
    normalized.includes("your previous reply was invalid and was discarded") ||
    normalized.includes("available tools:")
  );
}

export const outputSanitizerModule = {
  sanitizeVisibleModelOutput,
  extractPacketMessage,
  looksLikeInternalControlText
};

export type { VisibleModelOutputSanitizationResult };
