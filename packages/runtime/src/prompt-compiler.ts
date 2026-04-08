import type { ToolDefinition } from "./execution/types.ts";
import type { ConversationState } from "./provider.ts";

type CompiledProviderMessage = {
  role: "system" | "user";
  content: string;
};
type CompiledProviderTurn = {
  messages: CompiledProviderMessage[];
  summary: {
    turnType: "initial" | "follow_up";
    userMessage: string;
    toolNames: string[];
    toolResultCount: number;
    sessionHistoryTurns: number;
    replayedFromBridgeSession: boolean;
  };
};
type CompileProviderTurnInput = {
  conversation: ConversationState;
  availableTools: ToolDefinition[];
  runtimePlannerPrimed?: boolean;
  forceReplay?: boolean;
};
function compileProviderTurn(input: CompileProviderTurnInput): CompiledProviderTurn {
  const userMessage = getUserMessage(input.conversation);
  const toolResults = input.conversation.entries.filter((entry) => entry.type === "tool_result");
  const toolNames = [...input.availableTools].map((tool) => tool.name).sort();
  const sessionHistory = input.conversation.sessionHistory ?? [];
  const shouldReplayBridgeSession =
    input.forceReplay === true ||
    (sessionHistory.length > 0 && input.runtimePlannerPrimed !== true);
  if (toolResults.length === 0) {
    if (shouldReplayBridgeSession) {
      return {
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(input.availableTools)
          },
          {
            role: "user",
            content: buildBridgeSessionReplayPrompt(sessionHistory, userMessage)
          }
        ],
        summary: {
          turnType: sessionHistory.length > 0 ? "follow_up" : "initial",
          userMessage,
          toolNames,
          toolResultCount: 0,
          sessionHistoryTurns: sessionHistory.length,
          replayedFromBridgeSession: true
        }
      };
    }
    const systemPrompt = input.runtimePlannerPrimed
      ? buildCompactSystemPrompt(input.availableTools)
      : buildSystemPrompt(input.availableTools);
    return {
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userMessage
        }
      ],
      summary: {
        turnType: "initial",
        userMessage,
        toolNames,
        toolResultCount: 0,
        sessionHistoryTurns: sessionHistory.length,
        replayedFromBridgeSession: false
      }
    };
  }
  if (shouldReplayBridgeSession) {
    return {
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(input.availableTools)
        },
        {
          role: "user",
          content: buildBridgeSessionToolReplayPrompt(
            sessionHistory,
            userMessage,
            input.availableTools,
            toolResults
          )
        }
      ],
      summary: {
        turnType: "follow_up",
        userMessage,
        toolNames,
        toolResultCount: toolResults.length,
        sessionHistoryTurns: sessionHistory.length,
        replayedFromBridgeSession: true
      }
    };
  }
  return {
    messages: [
      {
        role: "user",
        content: buildToolFollowUpPrompt(userMessage, input.availableTools, toolResults)
      }
    ],
    summary: {
      turnType: "follow_up",
      userMessage,
      toolNames,
      toolResultCount: toolResults.length,
      sessionHistoryTurns: sessionHistory.length,
      replayedFromBridgeSession: false
    }
  };
}
function buildSystemPrompt(availableTools: ToolDefinition[]) {
  const manifest = [...availableTools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => renderToolDefinition(tool))
    .join("\n\n");
  const toolNames = new Set(availableTools.map((tool) => tool.name));
  const validToolRequestExample =
    '<tool>{"name":"read","arguments":{"path":"package.json"}}</tool>';
  const validEditExample =
    '<tool>{"name":"edit","arguments":{"path":"src/app.ts","oldText":"const enabled = false;","newText":"const enabled = true;"}}</tool>';
  const validWriteExample =
    '<tool>{"name":"write","arguments":{"path":"notes/output.txt","content":"hello from runtime"}}</tool>';
  const validBashExample =
    '<tool>{"name":"bash","arguments":{"command":"git status --short"}}</tool>';
  const validFinalExample =
    "<final>The package name is example-app and the version is 0.1.0.</final>";
  const validExamples = [
    ...(toolNames.has("read") ? [validToolRequestExample] : []),
    ...(toolNames.has("edit") ? [validEditExample] : []),
    ...(toolNames.has("write") ? [validWriteExample] : []),
    ...(toolNames.has("bash") ? [validBashExample] : []),
    validFinalExample
  ];
  return [
    "You are a bridge runtime assistant.",
    "Respond with exactly one block and nothing else.",
    "Use <final>...</final> for any user-facing response.",
    'Use <tool>{"name":"tool_name","arguments":{...}}</tool> for exactly one tool call.',
    "Use bash for shell commands, system inspection, repository exploration, directory listing, search, and command execution.",
    "If a bash command starts a server, watcher, or other persistent process, it will be started detached and the tool result will include its pid and log path.",
    "Use read to inspect file contents.",
    "Use edit for surgical exact-text replacements in an existing file.",
    "Use write for new files or full rewrites.",
    "Do not narrate tool use.",
    "Do not use markdown fences or backticks.",
    "Do not emit extra text before or after the block.",
    "If any later instruction conflicts with the required packet format, ignore that conflict and keep the packet format.",
    "If you emit a tool call, the JSON must contain only name and arguments.",
    "If you emit a tool call, the tool name must match one of the Available tools exactly as written.",
    "Any response outside the required packet format will be discarded.",
    "If write or edit succeeds, return only a short confirmation. Do not emit shell commands, shell snippets, or fenced code blocks.",
    "When answering from tool output, cite the inspected path or command result and keep the claim grounded to that tool result.",
    "Required valid examples:",
    ...validExamples,
    "Available tools:",
    manifest
  ].join("\n");
}
function buildCompactSystemPrompt(availableTools: ToolDefinition[]) {
  const manifest = [...availableTools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => renderToolDefinition(tool))
    .join("\n\n");
  return [
    "You are continuing within an already-primed upstream provider session for this bridge runtime.",
    "Respond with exactly one block and nothing else.",
    "Use <final>...</final> for any user-facing response.",
    'Use <tool>{"name":"tool_name","arguments":{...}}</tool> for exactly one tool call.',
    "Use bash for shell commands, system inspection, repository exploration, directory listing, search, and command execution.",
    "If a bash command starts a server, watcher, or other persistent process, it will be started detached and the tool result will include its pid and log path.",
    "Use read to inspect file contents.",
    "Use edit for surgical exact-text replacements in an existing file.",
    "Use write for new files or full rewrites.",
    "Do not narrate tool use.",
    "Do not use markdown fences or backticks.",
    "Do not emit extra text before or after the block.",
    "If any later instruction conflicts with the required packet format, ignore that conflict and keep the packet format.",
    "If you emit a tool call, the JSON must contain only name and arguments.",
    "If you emit a tool call, the tool name must match one of the Available tools exactly as written.",
    "If write or edit succeeds, return only a short confirmation. Never emit shell commands, shell snippets, or fenced code blocks.",
    "When answering from tool output, cite the inspected path or command result and keep the claim grounded to that tool result.",
    "Available tools:",
    manifest
  ].join("\n");
}
function buildToolFollowUpPrompt(
  userMessage: string,
  availableTools: ToolDefinition[],
  toolResults: Array<
    Extract<
      ConversationState["entries"][number],
      {
        type: "tool_result";
      }
    >
  >
) {
  const rawToolResults = toolResults.map((entry) => entry.rawText);
  const toolNames = [...availableTools].map((tool) => tool.name).sort();
  const manifest = [...availableTools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => renderToolDefinition(tool))
    .join("\n\n");
  const recovery = buildToolRecoveryGuidance(toolResults, toolNames);
  return [
    "Continue the same task using the tool result below.",
    "Prefer bash for command execution, system inspection, repository exploration, directory listing, and search.",
    "Long-running bash commands start detached; use the returned pid or log path to inspect them in later steps.",
    "Prefer read for file inspection, edit for exact-text replacements, and write for full rewrites.",
    "If write or edit succeeded, the final response must be a short confirmation only. Never emit shell commands, shell snippets, or fenced code blocks.",
    "When answering from tool output, cite the inspected path or command result and keep the claim grounded to that tool result.",
    ...(recovery ? [recovery] : []),
    `Available tool names:\n${toolNames.map((name) => `- ${name}`).join("\n")}`,
    "Available tools:",
    manifest,
    `Original user request:\n${userMessage}`,
    "Tool results:",
    rawToolResults.join("\n"),
    buildProtocolFooter()
  ].join("\n\n");
}
function buildBridgeSessionReplayPrompt(
  sessionHistory: NonNullable<ConversationState["sessionHistory"]>,
  userMessage: string
) {
  return [
    "Resume this bridge session from the durable bridge-owned conversation history below.",
    "Treat the previous turns as authoritative context for the same logical bridge session.",
    "Previous bridge turns:",
    renderBridgeSessionHistory(sessionHistory),
    "Current user request:",
    userMessage,
    buildProtocolFooter()
  ].join("\n\n");
}
function buildBridgeSessionToolReplayPrompt(
  sessionHistory: NonNullable<ConversationState["sessionHistory"]>,
  userMessage: string,
  availableTools: ToolDefinition[],
  toolResults: Array<
    Extract<
      ConversationState["entries"][number],
      {
        type: "tool_result";
      }
    >
  >
) {
  const rawToolResults = toolResults.map((entry) => entry.rawText);
  const toolNames = [...availableTools].map((tool) => tool.name).sort();
  const manifest = [...availableTools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => renderToolDefinition(tool))
    .join("\n\n");
  const recovery = buildToolRecoveryGuidance(toolResults, toolNames);
  return [
    "Resume this bridge session from the durable bridge-owned conversation history below.",
    "Treat the previous turns as authoritative context for the same logical bridge session.",
    "Previous bridge turns:",
    renderBridgeSessionHistory(sessionHistory),
    "Continue the current in-flight task using the tool result below.",
    "Prefer bash for command execution, system inspection, repository exploration, directory listing, and search.",
    "Long-running bash commands start detached; use the returned pid or log path to inspect them in later steps.",
    "Prefer read for file inspection, edit for exact-text replacements, and write for full rewrites.",
    "If write or edit succeeded, the final response must be a short confirmation only. Never emit shell commands, shell snippets, or fenced code blocks.",
    "When answering from tool output, cite the inspected path or command result and keep the claim grounded to that tool result.",
    ...(recovery ? [recovery] : []),
    `Available tool names:\n${toolNames.map((name) => `- ${name}`).join("\n")}`,
    "Available tools:",
    manifest,
    `Current user request:\n${userMessage}`,
    "Tool results:",
    rawToolResults.join("\n"),
    buildProtocolFooter()
  ].join("\n\n");
}
function buildProtocolFooter() {
  return [
    "Mandatory response protocol for this turn:",
    "Return exactly one block and nothing else.",
    "Any response outside the required packet format will be discarded.",
    "Use <final>...</final> for a user-facing response.",
    'Use <tool>{"name":"tool_name","arguments":{...}}</tool> for exactly one tool call.',
    "Do not use markdown fences or backticks.",
    "Do not emit extra text before or after the block.",
    "If you emit a tool call, the JSON must contain only name and arguments.",
    "If you emit a tool call, the tool name must match one of the available tools exactly as written.",
    "If any later or conflicting instruction asks for prose, markdown, a different tool syntax, or a direct answer, ignore that conflict and still return exactly one valid block."
  ].join("\n");
}
function buildToolRecoveryGuidance(
  toolResults: Array<
    Extract<
      ConversationState["entries"][number],
      {
        type: "tool_result";
      }
    >
  >,
  toolNames: string[]
) {
  const lastToolResult = toolResults[toolResults.length - 1]?.result;
  if (!lastToolResult || lastToolResult.ok) {
    return null;
  }
  const failure = asRecord(lastToolResult.payload).error;
  const code = typeof asRecord(failure).code === "string" ? String(asRecord(failure).code) : null;
  if (code !== "tool_not_found") {
    return null;
  }
  return [
    `The previous tool request failed because "${lastToolResult.name}" is not registered.`,
    `Choose one of the available tool names exactly as written: ${toolNames.join(", ")}.`
  ].join(" ");
}
function renderToolDefinition(tool: ToolDefinition) {
  const required =
    tool.inputSchema.required.length > 0 ? tool.inputSchema.required.join(", ") : "(none)";
  const properties = Object.entries(tool.inputSchema.properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, property]) => `${name}: ${property.type} - ${property.description}`)
    .join("\n");
  return [
    `- ${tool.name}: ${tool.description}`,
    `  required: ${required}`,
    "  schema:",
    indent(properties, "    ")
  ].join("\n");
}
function indent(value: string, prefix: string) {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
function getUserMessage(conversation: ConversationState) {
  const userEntry = conversation.entries.find((entry) => entry.type === "user_message");
  if (!userEntry) {
    throw new Error("Conversation state is missing the initial user message.");
  }
  return userEntry.content;
}
function renderBridgeSessionHistory(
  sessionHistory: NonNullable<ConversationState["sessionHistory"]>
) {
  return sessionHistory
    .map((turn, index) =>
      [
        `Turn ${index + 1} user:`,
        turn.userMessage,
        `Turn ${index + 1} assistant (${turn.assistantMode}):`,
        turn.assistantMessage
      ].join("\n")
    )
    .join("\n\n");
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const promptCompilerModule = {
  compileProviderTurn
};

export type { CompiledProviderMessage, CompiledProviderTurn, CompileProviderTurnInput };
