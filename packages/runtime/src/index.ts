import { assistantProtocolModule } from "./assistant-protocol.ts";
import { inProcessModule } from "./execution/in-process.ts";
import { executionTypesModule } from "./execution/types.ts";
import { outputSanitizerModule } from "./output-sanitizer.ts";
import { packetExtractorModule } from "./packet-extractor.ts";
import { packetNormalizerModule } from "./packet-normalizer.ts";
import { promptCompilerModule } from "./prompt-compiler.ts";
import { protocolModule } from "./protocol.ts";
import { providerFailureModule } from "./provider-failure.ts";
import { runtimeModule } from "./runtime.ts";
import { sessionBoundProviderModule } from "./session-bound-provider.ts";
import { toolNameAliasesModule } from "./tool-name-aliases.ts";
import { toolsModule } from "./tools/index.ts";

export const bridgeRuntime = {
  AssistantProtocolError: assistantProtocolModule.AssistantProtocolError,
  createFinalResponse: assistantProtocolModule.createFinalResponse,
  createToolResponse: assistantProtocolModule.createToolResponse,
  parseAndValidateAssistantResponse: assistantProtocolModule.parseAndValidateAssistantResponse,
  parseAssistantResponse: assistantProtocolModule.parseAssistantResponse,
  serializeAssistantResponse: assistantProtocolModule.serializeAssistantResponse,
  validateAssistantResponse: assistantProtocolModule.validateAssistantResponse,
  extractPacketCandidate: packetExtractorModule.extractPacketCandidate,
  InProcessToolExecutor: inProcessModule.InProcessToolExecutor,
  ToolExecutionError: executionTypesModule.ToolExecutionError,
  toolFailure: executionTypesModule.toolFailure,
  extractPacketMessage: outputSanitizerModule.extractPacketMessage,
  looksLikeInternalControlText: outputSanitizerModule.looksLikeInternalControlText,
  sanitizeVisibleModelOutput: outputSanitizerModule.sanitizeVisibleModelOutput,
  normalizeProviderPacket: packetNormalizerModule.normalizeProviderPacket,
  compileProviderTurn: promptCompilerModule.compileProviderTurn,
  createBashTool: toolsModule.createBashTool,
  createDefaultRuntimeTools: toolsModule.createDefaultRuntimeTools,
  createEditTool: toolsModule.createEditTool,
  createListDirTool: toolsModule.createListDirTool,
  createReadTool: toolsModule.createReadTool,
  createRuntimeTools: toolsModule.createRuntimeTools,
  createSearchFilesTool: toolsModule.createSearchFilesTool,
  createSecondaryRuntimeTools: toolsModule.createSecondaryRuntimeTools,
  createWriteTool: toolsModule.createWriteTool,
  ensureRuntimeRoot: toolsModule.ensureRuntimeRoot,
  ensureWorkspaceRoot: toolsModule.ensureWorkspaceRoot,
  MAX_FILE_READ_BYTES: toolsModule.MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES: toolsModule.MAX_FILE_WRITE_BYTES,
  resolveRuntimePath: toolsModule.resolveRuntimePath,
  resolveWorkspacePath: toolsModule.resolveWorkspacePath,
  normalizeProviderToolName: toolNameAliasesModule.normalizeProviderToolName,
  createMessagePacket: protocolModule.createMessagePacket,
  createToolRequestPacket: protocolModule.createToolRequestPacket,
  parseZcPacket: protocolModule.parseZcPacket,
  serializeToolResult: protocolModule.serializeToolResult,
  PacketProtocolError: protocolModule.PacketProtocolError,
  ProviderFailure: providerFailureModule.ProviderFailure,
  classifyProviderTransportError: providerFailureModule.classifyProviderTransportError,
  formatProviderFailureMessage: providerFailureModule.formatProviderFailureMessage,
  isProviderFailure: providerFailureModule.isProviderFailure,
  serializeProviderFailure: providerFailureModule.serializeProviderFailure,
  withProviderRecovery: providerFailureModule.withProviderRecovery,
  runBridgeRuntime: runtimeModule.runBridgeRuntime,
  SessionBoundProviderAdapter: sessionBoundProviderModule.SessionBoundProviderAdapter
};

export type {
  AssistantFinalResponse,
  AssistantProtocolError,
  AssistantResponse,
  AssistantToolCall,
  AssistantToolResponse
} from "./assistant-protocol.ts";

export type { InProcessToolExecutor } from "./execution/in-process.ts";

export type {
  ExecutionRequest,
  ExecutionResponse,
  RuntimeTool,
  ToolDefinition,
  ToolExecutionError,
  ToolExecutionResult,
  ToolExecutor,
  ToolFailurePayload,
  ToolSchema
} from "./execution/types.ts";

export type { VisibleModelOutputSanitizationResult } from "./output-sanitizer.ts";

export type {
  PacketExtractionFailure,
  PacketExtractionResult,
  PacketExtractionSuccess
} from "./packet-extractor.ts";

export type {
  PacketNormalizationFailure,
  PacketNormalizationFailureCode,
  PacketNormalizationResult,
  PacketNormalizationStrategy,
  PacketNormalizationSuccess
} from "./packet-normalizer.ts";

export type {
  CompiledProviderMessage,
  CompiledProviderTurn,
  CompileProviderTurnInput
} from "./prompt-compiler.ts";

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
} from "./protocol.ts";

export type {
  BridgeSessionTurn,
  ConversationEntry,
  ConversationState,
  ProviderAdapter,
  ProviderTurnInput,
  RepairInvalidResponseInput
} from "./provider.ts";

export type {
  ProviderFailure,
  ProviderFailureCode,
  ProviderFailureKind,
  ProviderRecoveryState,
  SerializedProviderFailure
} from "./provider-failure.ts";

export type {
  RunRuntimeInput,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeOutcome,
  RuntimeTerminalMode
} from "./runtime.ts";

export type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse,
  SessionBindingStore,
  SessionBoundProviderAdapter,
  SessionBoundProviderAdapterOptions,
  UpstreamConversationBinding
} from "./session-bound-provider.ts";

export type { ResolvedWorkspacePath, RuntimeToolProfile } from "./tools/index.ts";
