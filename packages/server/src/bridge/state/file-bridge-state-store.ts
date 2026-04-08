import crypto from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  BridgeSessionTurn,
  SessionBindingStore,
  UpstreamConversationBinding
} from "@openbridge/runtime";

type BridgeProviderSession = {
  providerId: string;
  cookie: string;
  userAgent: string;
  bearerToken: string;
  extraHeaders?: Record<string, string>;
  updatedAt: string;
};
type StoredConversationBinding = {
  providerId: string;
  sessionId: string;
  conversationId: string;
  parentId: string;
  runtimePlannerPrimed?: boolean;
  updatedAt: string;
};
type StoredBridgeSessionHistory = {
  sessionId: string;
  turns: Array<
    BridgeSessionTurn & {
      recordedAt: string;
    }
  >;
};
type StoredChatCompletionContinuation = {
  providerId: string;
  modelKey: string;
  lookupKey: string;
  sessionId: string;
  updatedAt: string;
};
type StoredSharedChatCompletionContinuation = {
  lookupKey: string;
  sessionId: string;
  providerId?: string;
  modelKey?: string;
  updatedAt: string;
};
class FileBridgeStateStore implements SessionBindingStore {
  readonly rootDir: string;
  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }
  async loadProviderSession(providerId: string): Promise<BridgeProviderSession | null> {
    try {
      const raw = await readFile(this.getProviderSessionPath(providerId), "utf8");
      return JSON.parse(raw) as BridgeProviderSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  async loadBinding(
    providerId: string,
    sessionId: string
  ): Promise<UpstreamConversationBinding | null> {
    try {
      const raw = await readFile(this.getConversationPath(providerId, sessionId), "utf8");
      const parsed = JSON.parse(raw) as StoredConversationBinding;
      return {
        conversationId: parsed.conversationId,
        parentId: parsed.parentId,
        runtimePlannerPrimed: parsed.runtimePlannerPrimed
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  async saveBinding(
    providerId: string,
    sessionId: string,
    binding: UpstreamConversationBinding
  ): Promise<void> {
    const stored: StoredConversationBinding = {
      providerId,
      sessionId,
      conversationId: binding.conversationId,
      parentId: binding.parentId,
      runtimePlannerPrimed: binding.runtimePlannerPrimed,
      updatedAt: new Date().toISOString()
    };
    await writeSecureJson(this.getConversationPath(providerId, sessionId), stored);
  }
  async clearBinding(providerId: string, sessionId: string): Promise<void> {
    try {
      await unlink(this.getConversationPath(providerId, sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
  async loadSessionHistory(sessionId: string): Promise<BridgeSessionTurn[]> {
    const stored = await this.readStoredSessionHistory(sessionId);
    return (
      stored?.turns.map((turn) => ({
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
        assistantMode: turn.assistantMode
      })) ?? []
    );
  }
  async appendSessionTurn(sessionId: string, turn: BridgeSessionTurn): Promise<void> {
    const stored = (await this.readStoredSessionHistory(sessionId)) ?? {
      sessionId,
      turns: []
    };
    stored.turns.push({
      ...turn,
      recordedAt: new Date().toISOString()
    });
    await writeSecureJson(this.getSessionHistoryPath(sessionId), stored);
  }
  async loadChatCompletionSession(
    providerId: string,
    modelKey: string,
    lookupKey: string
  ): Promise<string | null> {
    try {
      const raw = await readFile(
        this.getChatCompletionContinuationPath(providerId, modelKey, lookupKey),
        "utf8"
      );
      const parsed = JSON.parse(raw) as StoredChatCompletionContinuation;
      return typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  async loadSharedChatCompletionSession(lookupKey: string): Promise<string | null> {
    try {
      const raw = await readFile(this.getSharedChatCompletionContinuationPath(lookupKey), "utf8");
      const parsed = JSON.parse(raw) as StoredSharedChatCompletionContinuation;
      return typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  async saveChatCompletionSession(
    providerId: string,
    modelKey: string,
    lookupKey: string,
    sessionId: string
  ): Promise<void> {
    const stored: StoredChatCompletionContinuation = {
      providerId,
      modelKey,
      lookupKey,
      sessionId,
      updatedAt: new Date().toISOString()
    };
    await writeSecureJson(
      this.getChatCompletionContinuationPath(providerId, modelKey, lookupKey),
      stored
    );
  }
  async saveSharedChatCompletionSession(
    lookupKey: string,
    sessionId: string,
    metadata?: {
      providerId?: string;
      modelKey?: string;
    }
  ): Promise<void> {
    const stored: StoredSharedChatCompletionContinuation = {
      lookupKey,
      sessionId,
      providerId: metadata?.providerId,
      modelKey: metadata?.modelKey,
      updatedAt: new Date().toISOString()
    };
    await writeSecureJson(this.getSharedChatCompletionContinuationPath(lookupKey), stored);
  }
  private async readStoredSessionHistory(sessionId: string) {
    try {
      const raw = await readFile(this.getSessionHistoryPath(sessionId), "utf8");
      return JSON.parse(raw) as StoredBridgeSessionHistory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  private getProviderSessionPath(providerId: string) {
    return path.join(this.rootDir, "sessions", `${providerId}.json`);
  }
  private getConversationPath(providerId: string, sessionId: string) {
    const digest = crypto.createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.rootDir, "conversations", `${providerId}-${digest}.json`);
  }
  private getSessionHistoryPath(sessionId: string) {
    const digest = crypto.createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.rootDir, "bridge-sessions", `${digest}.json`);
  }
  private getChatCompletionContinuationPath(
    providerId: string,
    modelKey: string,
    lookupKey: string
  ) {
    const digest = crypto.createHash("sha256").update(`${modelKey}:${lookupKey}`).digest("hex");
    return path.join(this.rootDir, "chat-completion-continuations", `${providerId}-${digest}.json`);
  }
  private getSharedChatCompletionContinuationPath(lookupKey: string) {
    const digest = crypto.createHash("sha256").update(lookupKey).digest("hex");
    return path.join(this.rootDir, "chat-completion-continuations", `shared-${digest}.json`);
  }
}
async function writeSecureJson(targetPath: string, value: unknown) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await chmod(targetPath, 0o600);
}

export const fileBridgeStateStoreModule = {
  FileBridgeStateStore
};

export type { BridgeProviderSession, FileBridgeStateStore };
