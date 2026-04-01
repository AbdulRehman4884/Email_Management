/**
 * src/services/sessionMemory.service.ts
 *
 * Service layer for session memory operations.
 *
 * Responsibilities:
 *  - Compose the session key (userId:sessionId)
 *  - Enforce bounded arrays (messages, toolCalls)
 *  - Provide typed read/write helpers for graph nodes
 *  - Shield callers from the raw store interface
 *
 * Bounds:
 *  MEMORY_MAX_MESSAGES   = 20  (10 conversation turns)
 *  MEMORY_MAX_TOOL_CALLS = 10
 */

import { createLogger } from "../lib/logger.js";
import {
  sessionMemoryStore,
  sessionKey,
  type ISessionMemoryStore,
  type SessionSnapshot,
  type StoredMessage,
  type ToolCallRecord,
} from "../memory/sessionMemory.store.js";

const log = createLogger("sessionMemory");

const MEMORY_MAX_MESSAGES   = 20;
const MEMORY_MAX_TOOL_CALLS = 10;

// ── Partial update shape ──────────────────────────────────────────────────────

export interface SessionUpdate {
  lastIntent?: string;
  lastAgentDomain?: string;
  activeCampaignId?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class SessionMemoryService {
  constructor(private readonly store: ISessionMemoryStore = sessionMemoryStore) {}

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Returns the current snapshot for a session, or undefined if not found.
   */
  async get(userId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
    const key = sessionKey(userId, sessionId);
    return this.store.get(key);
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Updates scalar metadata fields on an existing session (or creates one).
   * Does NOT touch messages or toolCalls — use appendMessage / appendToolCall.
   */
  async update(
    userId: string,
    sessionId: string,
    changes: SessionUpdate,
  ): Promise<void> {
    const key = sessionKey(userId, sessionId);
    const existing = await this.store.get(key);
    const now = new Date().toISOString();

    const next: SessionSnapshot = {
      ...(existing ?? this.empty(userId, sessionId, now)),
      ...changes,
      updatedAt: now,
    };

    await this.store.set(key, next);
    log.debug({ userId, sessionId, changes }, "Session updated");
  }

  /**
   * Appends a message to the session history, trimming oldest entries
   * if the array exceeds MEMORY_MAX_MESSAGES.
   */
  async appendMessage(
    userId: string,
    sessionId: string,
    role: StoredMessage["role"],
    content: string,
  ): Promise<void> {
    const key = sessionKey(userId, sessionId);
    const existing = await this.store.get(key);
    const now = new Date().toISOString();

    const base = existing ?? this.empty(userId, sessionId, now);
    const messages: StoredMessage[] = [
      ...base.messages,
      { role, content, timestamp: now },
    ].slice(-MEMORY_MAX_MESSAGES);

    await this.store.set(key, { ...base, messages, updatedAt: now });
  }

  /**
   * Appends a tool call record, trimming oldest entries at MEMORY_MAX_TOOL_CALLS.
   */
  async appendToolCall(
    userId: string,
    sessionId: string,
    record: Omit<ToolCallRecord, "timestamp">,
  ): Promise<void> {
    const key = sessionKey(userId, sessionId);
    const existing = await this.store.get(key);
    const now = new Date().toISOString();

    const base = existing ?? this.empty(userId, sessionId, now);
    const recentToolCalls: ToolCallRecord[] = [
      ...base.recentToolCalls,
      { ...record, timestamp: now },
    ].slice(-MEMORY_MAX_TOOL_CALLS);

    await this.store.set(key, { ...base, recentToolCalls, updatedAt: now });
  }

  /**
   * Saves a complete turn: user message, AI response, metadata, and tool call.
   * Convenience wrapper for saveMemory node — single store write.
   */
  async saveTurn(
    userId: string,
    sessionId: string,
    turn: {
      userMessage: string;
      aiResponse: string;
      metadata: SessionUpdate;
      toolCall?: Omit<ToolCallRecord, "timestamp">;
    },
  ): Promise<void> {
    const key = sessionKey(userId, sessionId);
    const existing = await this.store.get(key);
    const now = new Date().toISOString();

    const base = existing ?? this.empty(userId, sessionId, now);

    const newMessages: StoredMessage[] = [
      ...base.messages,
      { role: "human" as const, content: turn.userMessage, timestamp: now },
      { role: "ai" as const,    content: turn.aiResponse,  timestamp: now },
    ].slice(-MEMORY_MAX_MESSAGES);

    const newToolCalls: ToolCallRecord[] = turn.toolCall
      ? [
          ...base.recentToolCalls,
          { ...turn.toolCall, timestamp: now },
        ].slice(-MEMORY_MAX_TOOL_CALLS)
      : base.recentToolCalls;

    const next: SessionSnapshot = {
      ...base,
      ...turn.metadata,
      messages: newMessages,
      messageCount: (base.messageCount ?? 0) + 2, // +1 human + 1 AI per turn
      recentToolCalls: newToolCalls,
      updatedAt: now,
    };

    await this.store.set(key, next);
    log.debug({ userId, sessionId }, "Session turn saved");
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private empty(userId: string, sessionId: string, now: string): SessionSnapshot {
    return {
      sessionId,
      userId,
      messages: [],
      messageCount: 0,
      recentToolCalls: [],
      createdAt: now,
      updatedAt: now,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const sessionMemoryService = new SessionMemoryService();
