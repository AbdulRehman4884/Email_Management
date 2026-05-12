/**
 * src/memory/sessionMemory.store.ts
 *
 * Storage abstraction for session memory.
 *
 * ISessionMemoryStore is the interface.
 * InMemorySessionStore is the default (non-Redis) implementation.
 * RedisSessionStore (src/memory/redisSession.store.ts) is the production impl.
 *
 * Key schema: `${userId}:${sessionId}`
 * This keeps sessions user-scoped and maps cleanly to a Redis key prefix.
 */

import type { PlannedStep, PlanStepResult } from "../lib/planTypes.js";
import type { ActiveWorkflowLock, WorkflowStackItem } from "../graph/state/agentGraph.state.js";

// ── Record types ──────────────────────────────────────────────────────────────

/** A single message turn stored in session history. */
export interface StoredMessage {
  readonly role: "human" | "ai" | "system";
  readonly content: string;
  readonly timestamp: string; // ISO-8601
}

/** A summary of one MCP tool call appended after execution. */
export interface ToolCallRecord {
  readonly toolName: string;
  readonly timestamp: string; // ISO-8601
  readonly success: boolean;  // false if toolResult.isToolError or threw
}

/** Full session snapshot persisted per userId+sessionId pair. */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly userId: string;

  /** Bounded conversation history — oldest entries are dropped at MAX_MESSAGES. */
  readonly messages: StoredMessage[];

  /** Total number of messages ever written to this session (monotonically increasing). */
  readonly messageCount: number;

  /** Intent detected in the most recent turn. */
  readonly lastIntent?: string;

  /** Agent domain that handled the most recent turn. */
  readonly lastAgentDomain?: string;

  /** Campaign the user is currently working with (persists across turns). */
  readonly activeCampaignId?: string;

  /** Saved fromName / fromEmail from a prior successful campaign — reused as defaults. */
  readonly senderDefaults?: { fromName: string; fromEmail: string };

  /** Partial campaign fields collected during a multi-turn campaign creation wizard. */
  readonly pendingCampaignDraft?: Record<string, string>;
  /** Current step in the campaign creation wizard ("name" | "subject" | … | "confirm"). */
  readonly pendingCampaignStep?: string;

  /** Pending action to dispatch once user selects a campaign from the list. */
  readonly pendingCampaignAction?: "start_campaign" | "pause_campaign" | "resume_campaign" | "update_campaign" | "schedule_campaign" | "get_campaign_stats" | "show_sequence_progress" | "show_pending_follow_ups";
  /** Fetched campaign list for numbered selection — maps position to campaignId. */
  readonly campaignSelectionList?: Array<{ id: string; name: string; status: string }>;
  /** ISO datetime stored during campaign selection for the schedule_campaign flow. */
  readonly pendingScheduledAt?: string;

  // ── Phase 1: AI Campaign wizard state ─────────────────────────────────────

  /** Current step in the Phase 1 AI campaign wizard. Undefined when not active. */
  readonly pendingAiCampaignStep?: string;

  /** Accumulated data for the Phase 1 AI campaign wizard (templateType, tone, etc.). */
  readonly pendingAiCampaignData?: Record<string, string>;

  // ── CSV file ingestion ─────────────────────────────────────────────────────
  // Raw file buffer is intentionally NOT stored here — only the parsed result.
  // This avoids persisting potentially large base64 blobs in session memory.

  /** Parsed rows from parse_csv_file — stored so confirmation can save without the raw file. */
  readonly pendingCsvData?: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    columns: string[];
    preview: Array<Record<string, string>>;
    rows: Array<Record<string, string>>;
  };

  // ── Contact enrichment flow ────────────────────────────────────────────────

  /** Current step in the contact enrichment flow ("enrich" | "template" | "confirm"). */
  readonly pendingEnrichmentStep?: string;

  /** Enriched contact data accumulated during the enrichment flow. */
  readonly pendingEnrichmentData?: {
    contacts: Array<Record<string, unknown>>;
    totalProcessed: number;
    enrichedCount: number;
    summary: {
      byIndustry: Record<string, number>;
      hotLeads: number;
      warmLeads: number;
      coldLeads: number;
      businessEmails: number;
    };
  };

  /** Draft outreach template pending user review or customization. */
  readonly pendingOutreachDraft?: {
    subject: string;
    body: string;
    variables: string[];
    tone: string;
  };

  /** Enrichment save action pending campaign selection. */
  readonly pendingEnrichmentAction?: "save_enriched_contacts";

  /** Workflow UX deadline for enrichment-related pending UI state (ISO-8601). */
  readonly pendingWorkflowDeadlineIso?: string;

  /** Snapshot schema version for safe migrations across deployments. */
  readonly sessionSchemaVersion?: number;

  /** Active workflow lock for concurrency safety (persisted). */
  readonly activeWorkflowLock?: ActiveWorkflowLock;

  /** Stack of suspended workflows for safe interruption/resume (persisted). */
  readonly workflowStack?: WorkflowStackItem[];

  /** Phase 3 company-intelligence chain (optional persistence across turns). */
  readonly pendingPhase3EnrichmentAction?: string;
  readonly pendingPhase3CompanyName?: string;
  readonly pendingPhase3Url?: string;
  readonly pendingPhase3WebsiteContent?: string;
  readonly pendingPhase3ToolQueue?: string[];
  readonly pendingPhase3Scratch?: Record<string, unknown>;
  readonly pendingPhase3ContinueExecute?: boolean;

  /** Recent tool calls — bounded at MAX_TOOL_CALLS. */
  readonly recentToolCalls: ToolCallRecord[];

  // ── Multi-step plan state (persisted so plan survives across API calls) ──

  /** Active multi-step plan, if any. Undefined between turns. */
  readonly plan?: PlannedStep[];
  /** Next step to execute within the active plan. */
  readonly planIndex?: number;
  /** Accumulated results from completed plan steps in the current session. */
  readonly planResults?: PlanStepResult[];

  readonly createdAt: string; // ISO-8601
  readonly updatedAt: string; // ISO-8601
}

// ── Store interface ───────────────────────────────────────────────────────────

/**
 * Minimal key-value interface for session storage.
 * Implementations must be safe for concurrent reads from the same process.
 *
 * Redis replacement notes:
 *   get  → GET key + JSON.parse
 *   set  → SETEX key TTL JSON.stringify
 *   delete → DEL key
 *   clear → FLUSHDB (test only)
 */
export interface ISessionMemoryStore {
  get(key: string): Promise<SessionSnapshot | undefined>;
  set(key: string, snapshot: SessionSnapshot): Promise<void>;
  delete(key: string): Promise<void>;
  /** Clears all entries. Intended for tests only. */
  clear(): Promise<void>;
}

// ── Key helper ────────────────────────────────────────────────────────────────

export function sessionKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}

// ── In-memory implementation ──────────────────────────────────────────────────

export class InMemorySessionStore implements ISessionMemoryStore {
  private readonly store = new Map<string, SessionSnapshot>();

  async get(key: string): Promise<SessionSnapshot | undefined> {
    return this.store.get(key);
  }

  async set(key: string, snapshot: SessionSnapshot): Promise<void> {
    this.store.set(key, snapshot);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /** Exposed for testing — returns current store size. */
  get size(): number {
    return this.store.size;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates the appropriate session store based on runtime configuration.
 *
 * If REDIS_URL is set and the Redis client connects successfully, returns a
 * RedisSessionStore. Otherwise falls back to InMemorySessionStore.
 *
 * Called once during startup in src/index.ts (or lazily in sessionMemory.service.ts).
 */
export async function createSessionStore(): Promise<ISessionMemoryStore> {
  const { getRedisClient } = await import("../lib/redisClient.js");
  const client = await getRedisClient();
  if (client) {
    const { RedisSessionStore } = await import("./redisSession.store.js");
    return new RedisSessionStore(client);
  }
  return new InMemorySessionStore();
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Module-level singleton.
 * Starts as in-memory; replaced with Redis-backed store at startup when
 * REDIS_URL is present (see src/index.ts → initStores()).
 */
export let sessionMemoryStore: ISessionMemoryStore = new InMemorySessionStore();

/** Replaces the active store. Called once during startup by initStores(). */
export function setSessionMemoryStore(store: ISessionMemoryStore): void {
  sessionMemoryStore = store;
}
