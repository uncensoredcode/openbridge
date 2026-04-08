import type { ToolDefinition } from "./execution/types.ts";

type AssistantToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
};
type AssistantFinalResponse = {
  type: "final";
  message: string;
};
type AssistantToolResponse = {
  type: "tool";
  toolCall: AssistantToolCall;
};
type AssistantResponse = AssistantFinalResponse | AssistantToolResponse;
class AssistantProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantProtocolError";
  }
}
function parseAssistantResponse(rawText: string): AssistantResponse {
  const trimmed = rawText.trim();
  const finalMatch = trimmed.match(/^<final>([\s\S]*?)<\/final>$/);
  if (finalMatch) {
    const message = finalMatch[1] ?? "";
    if (!message.trim()) {
      throw new AssistantProtocolError("<final> block must not be empty.");
    }
    return {
      type: "final",
      message
    };
  }
  const toolMatch = trimmed.match(/^<tool>([\s\S]*?)<\/tool>$/);
  if (toolMatch) {
    return {
      type: "tool",
      toolCall: parseToolPayload(toolMatch[1] ?? "")
    };
  }
  throw new AssistantProtocolError(
    'Assistant output must be exactly one <final>...</final> block or one <tool>{"name":"...","arguments":{...}}</tool> block.'
  );
}
function validateAssistantResponse(response: AssistantResponse, availableTools: ToolDefinition[]) {
  if (response.type !== "tool") {
    return response;
  }
  const tool = availableTools.find((candidate) => candidate.name === response.toolCall.name);
  if (!tool) {
    throw new AssistantProtocolError(`Tool "${response.toolCall.name}" is not registered.`);
  }
  const schema = tool.inputSchema;
  const argumentsRecord = response.toolCall.arguments;
  const propertyNames = Object.keys(schema.properties);
  const allowedProperties = new Set(propertyNames);
  for (const name of Object.keys(argumentsRecord)) {
    if (!allowedProperties.has(name)) {
      throw new AssistantProtocolError(`Tool "${tool.name}" received unknown argument "${name}".`);
    }
  }
  for (const requiredName of schema.required) {
    if (!(requiredName in argumentsRecord)) {
      throw new AssistantProtocolError(
        `Tool "${tool.name}" is missing required argument "${requiredName}".`
      );
    }
  }
  for (const propertyName of propertyNames) {
    if (!(propertyName in argumentsRecord)) {
      continue;
    }
    const property = schema.properties[propertyName];
    const value = argumentsRecord[propertyName];
    if (property.type === "string" && typeof value !== "string") {
      throw new AssistantProtocolError(
        `Tool "${tool.name}" argument "${propertyName}" must be a string.`
      );
    }
    if (property.type === "boolean" && typeof value !== "boolean") {
      throw new AssistantProtocolError(
        `Tool "${tool.name}" argument "${propertyName}" must be a boolean.`
      );
    }
  }
  return response;
}
function parseAndValidateAssistantResponse(rawText: string, availableTools: ToolDefinition[]) {
  return validateAssistantResponse(parseAssistantResponse(rawText), availableTools);
}
function createFinalResponse(message: string) {
  return `<final>${message}</final>`;
}
function createToolResponse(toolCall: AssistantToolCall) {
  return `<tool>${JSON.stringify({
    name: toolCall.name,
    arguments: toolCall.arguments
  })}</tool>`;
}
function serializeAssistantResponse(response: AssistantResponse) {
  return response.type === "final"
    ? createFinalResponse(response.message)
    : createToolResponse(response.toolCall);
}
function parseToolPayload(raw: string): AssistantToolCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new AssistantProtocolError("<tool> payload must contain valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new AssistantProtocolError("<tool> payload must decode to an object.");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "arguments" || keys[1] !== "name") {
    throw new AssistantProtocolError('<tool> JSON must contain only "name" and "arguments".');
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) {
    throw new AssistantProtocolError('<tool> JSON field "name" must be a non-empty string.');
  }
  if (!isRecord(parsed.arguments)) {
    throw new AssistantProtocolError('<tool> JSON field "arguments" must be an object.');
  }
  return {
    name,
    arguments: parsed.arguments
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const assistantProtocolModule = {
  AssistantProtocolError,
  parseAssistantResponse,
  validateAssistantResponse,
  parseAndValidateAssistantResponse,
  createFinalResponse,
  createToolResponse,
  serializeAssistantResponse
};

export type {
  AssistantFinalResponse,
  AssistantProtocolError,
  AssistantResponse,
  AssistantToolCall,
  AssistantToolResponse
};
