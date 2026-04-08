import type { AssistantResponse } from "./assistant-protocol.ts";
import type { ToolDefinition } from "./execution/types.ts";
import type { ToolResult, ZcPacket } from "./protocol.ts";

type BridgeSessionTurn = {
  userMessage: string;
  assistantMessage: string;
  assistantMode: "final" | "ask_user";
};
type ConversationEntry =
  | {
      type: "user_message";
      content: string;
    }
  | {
      type: "provider_packet";
      rawText: string;
      packet: AssistantResponse | ZcPacket;
    }
  | {
      type: "tool_result";
      rawText: string;
      result: ToolResult;
    };
type ConversationState = {
  sessionHistory?: BridgeSessionTurn[];
  entries: ConversationEntry[];
};
type ProviderTurnInput = {
  conversation: ConversationState;
  availableTools: ToolDefinition[];
};
type RepairInvalidResponseInput = {
  conversation: ConversationState;
  availableTools: ToolDefinition[];
  invalidResponse: string;
  validationError: string;
};
interface ProviderAdapter {
  readonly id: string;
  completeTurn(input: ProviderTurnInput): Promise<string>;
  repairInvalidResponse?(input: RepairInvalidResponseInput): Promise<string>;
}

export type {
  BridgeSessionTurn,
  ConversationEntry,
  ConversationState,
  ProviderAdapter,
  ProviderTurnInput,
  RepairInvalidResponseInput
};
