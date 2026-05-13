/**
 * src/graph/state/agentGraph.state.ts
 *
 * LangGraph state definition for the MailFlow agent graph.
 *
 * State design rules:
 *  - Every field has an explicit reducer — no implicit LangGraph defaults.
 *  - Most fields use last-writer-wins (replace) semantics.
 *  - `messages` uses messagesStateReducer (append/update by message id).
 *  - Sensitive fields (rawToken) are present in state but excluded from logs
 *    via Pino redaction config in src/lib/logger.ts.
 *  - All optional fields default to undefined so nodes can detect "not yet set".
 *
 * Phase coverage:
 *  Fields needed for all 12 phases are declared here even if not yet consumed.
 *  Nodes added in later phases will read/write to the relevant fields.
 */

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { Intent } from "../../config/intents.js";
import type { McpToolResult } from "../../types/mcp.js";
import type { SessionId, UserId } from "../../types/common.js";
import type { LLMIntentArguments } from "../../schemas/llmIntent.schema.js";
import type { PlannedStep, PlanStepResult } from "../../lib/planTypes.js";

// ── Reducer helpers ───────────────────────────────────────────────────────────

/** Last-writer-wins: the new value always replaces the current one. */
function replace<T>(_current: T, update: T): T {
  return update;
}

// ── Workflow concurrency primitives ───────────────────────────────────────────

export type WorkflowType = "enrichment" | "campaign" | "phase3" | "analytics" | "inbox";

export interface ActiveWorkflowLock {
  workflowId: string;
  type: WorkflowType;
  startedAtIso: string;
  expiresAtIso: string;
  interruptible: boolean;
}

export interface WorkflowStackItem {
  workflowId: string;
  type: string;
  resumeIntent?: string;
  snapshot: Record<string, unknown>;
  createdAtIso: string;
}

// ── State definition ──────────────────────────────────────────────────────────

export const AgentGraphState = Annotation.Root({

  // ── Conversation ────────────────────────────────────────────────────────────

  /**
   * Full conversation history for this session.
   * Uses LangGraph's built-in reducer: new messages are appended; messages
   * with a matching id update in place.
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * The plain-text content of the current user turn.
   * Extracted from the most recent HumanMessage before graph entry.
   */
  userMessage: Annotation<string>({
    reducer: replace,
    default: () => "",
  }),

  // ── Session / auth ──────────────────────────────────────────────────────────

  /** Stable identifier for the current chat session. */
  sessionId: Annotation<SessionId | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /** Authenticated user — resolved from JWT, never from user input. */
  userId: Annotation<UserId | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Raw JWT bearer token forwarded to the MCP server.
   * Never logged (redacted by Pino config).
   */
  rawToken: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Intent ──────────────────────────────────────────────────────────────────

  /** Detected intent for the current turn. Set by the detectIntent node. */
  intent: Annotation<Intent | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Confidence score for the detected intent in [0, 1].
   * Set alongside `intent` by the detectIntent node.
   */
  confidence: Annotation<number>({
    reducer: replace,
    default: () => 0,
  }),

  /**
   * Structured arguments extracted from the user message by Gemini during
   * LLM-first intent detection.  Written by detectIntent.node when
   * detectWithLLM() succeeds and the LLM found extractable values.
   *
   * Domain agents should read this field (alongside state.userMessage) when
   * constructing toolArgs, preferring pre-parsed values over re-parsing
   * the raw message.
   *
   * Undefined when:
   *   - detectWithLLM fell back to deterministic detection
   *   - The LLM found no relevant argument values in the message
   *   - GEMINI_API_KEY is not configured
   */
  llmExtractedArgs: Annotation<LLMIntentArguments | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Routing ─────────────────────────────────────────────────────────────────

  /**
   * Domain agent responsible for handling the current intent.
   * Set by the routeAgent node after intent detection.
   */
  agentDomain: Annotation<"campaign" | "analytics" | "inbox" | "settings" | "general" | "enrichment" | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Tool execution ──────────────────────────────────────────────────────────

  /**
   * MCP tool name to invoke for the current intent.
   * Set by the domain agent node before the executeTool node runs.
   */
  toolName: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Arguments for the MCP tool call.
   * Set by the domain agent node; validated by the agent before setting.
   */
  toolArgs: Annotation<Record<string, unknown>>({
    reducer: replace,
    default: () => ({}),
  }),

  /**
   * Normalised result returned by McpToolCallerService.
   * Set by the executeTool node after a successful MCP call.
   */
  toolResult: Annotation<McpToolResult | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Approval workflow ────────────────────────────────────────────────────────

  /**
   * True when the current action requires explicit user confirmation before
   * the MCP tool is invoked. Set by the approvalCheck node.
   */
  requiresApproval: Annotation<boolean>({
    reducer: replace,
    default: () => false,
  }),

  /**
   * ID of the pending action stored in the approval store.
   * Present only when requiresApproval is true and the action has been
   * registered, waiting for the user to confirm or cancel.
   */
  pendingActionId: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Response ─────────────────────────────────────────────────────────────────

  /**
   * The final formatted response string to return to the user.
   * Set by the formatResponse node as the last step in the graph.
   */
  finalResponse: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Session context ───────────────────────────────────────────────────────────

  /**
   * The campaign the user is currently working with.
   * Populated by loadMemory from session data; updated by agents when a
   * campaignId is present in tool args or tool results.
   * Persisted back to session memory by saveMemory.
   */
  activeCampaignId: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Saved sender identity defaults, populated after a successful campaign
   * creation and reused in future campaigns so the user is not asked for
   * fromName / fromEmail every time.
   */
  senderDefaults: Annotation<{ fromName: string; fromEmail: string } | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Partial campaign fields being collected during a multi-turn campaign
   * creation wizard (step-by-step or auto-generated draft awaiting confirmation).
   * Set by CampaignAgent; cleared when the campaign is created or cancelled.
   * Persisted across turns via session memory.
   */
  pendingCampaignDraft: Annotation<Record<string, string> | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Current step in the campaign creation wizard.
   * Values: "name" | "subject" | "fromName" | "fromEmail" | "body" | "confirm"
   * "confirm" means all fields are collected and the draft awaits user approval.
   * Cleared alongside pendingCampaignDraft when creation completes or is cancelled.
   */
  pendingCampaignStep: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Campaign selection flow ───────────────────────────────────────────────────

  /**
   * When no campaignId is known for start/pause/resume/update/schedule/stats,
   * the agent fetches all campaigns and stores the pending action here so it
   * can be dispatched once the user selects a campaign from the presented list.
   */
  pendingCampaignAction: Annotation<"start_campaign" | "pause_campaign" | "resume_campaign" | "update_campaign" | "schedule_campaign" | "get_campaign_stats" | "show_sequence_progress" | "show_pending_follow_ups" | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * ISO datetime string for a scheduled send, stored during campaign selection
   * so the schedule time survives the selection turn.
   */
  pendingScheduledAt: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Compact campaign list fetched for selection. Populated by saveMemory after
   * a get_all_campaigns tool call; read by CampaignAgent to map a user
   * selection ("1", "Summer Sale") to a concrete campaignId.
   */
  campaignSelectionList: Annotation<Array<{ id: string; name: string; status: string }> | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Multi-step plan ────────────────────────────────────────────────────────────

  /**
   * Ordered list of tool calls forming a multi-step plan.
   * Set by planDetection.node when Gemini identifies a 2–3 step task.
   * Undefined for single-step requests (they use the standard agent path).
   */
  plan: Annotation<PlannedStep[] | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Index of the step currently being executed within the plan.
   * Updated by executePlanStep.node as it progresses through the plan.
   */
  planIndex: Annotation<number>({
    reducer: replace,
    default: () => 0,
  }),

  /**
   * Accumulated results from plan steps that have already been executed.
   * Built up by executePlanStep.node; read by finalResponse.node to produce
   * a multi-step summary response.
   */
  planResults: Annotation<PlanStepResult[]>({
    reducer: replace,
    default: () => [],
  }),

  // ── CSV file ingestion ────────────────────────────────────────────────────────

  /**
   * Base64-encoded CSV/XLSX file uploaded through the agent chat.
   * Present from the turn the file is received until recipients are saved or
   * the user discards the upload.  Drives `upload_csv` intent bypass in
   * detectIntent.node — any turn with this field set skips LLM detection.
   */
  pendingCsvFile: Annotation<{ filename: string; fileContent: string } | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Parsed result returned by the `parse_csv_file` MCP tool.
   * Stored across turns: preview shown on turn N, user confirms on turn N+1,
   * rows passed to save_csv_recipients.  Cleared after save or discard.
   * The raw file buffer (pendingCsvFile) is NOT persisted — only this struct is.
   */
  pendingCsvData: Annotation<{
    totalRows: number;
    validRows: number;
    invalidRows: number;
    columns: string[];
    preview: Array<Record<string, string>>;
    rows: Array<Record<string, string>>;
  } | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Phase 1: AI Campaign wizard ───────────────────────────────────────────────

  /**
   * Current step in the Phase 1 AI campaign wizard.
   * Values: "template" | "tone" | "schedule" | "upload_prompt" | "generate" | "review" | "approve"
   * Cleared when the wizard completes or is cancelled.
   */
  pendingAiCampaignStep: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Accumulated data for the Phase 1 AI campaign wizard.
   * Carries: templateType, toneInstruction, customPrompt, scheduledAt
   * Cleared alongside pendingAiCampaignStep when wizard ends.
   */
  pendingAiCampaignData: Annotation<Record<string, string> | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Enrichment flow ────────────────────────────────────────────────────────────

  /**
   * Current step in the contact enrichment flow.
   * Values: "enrich" | "template" | "confirm"
   * Set by EnrichmentAgent; cleared after save_enriched_contacts succeeds.
   */
  pendingEnrichmentStep: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Enriched contact data accumulated during the enrichment flow.
   * Persisted so the user can review and confirm without re-uploading.
   * Cleared after save_enriched_contacts.
   */
  pendingEnrichmentData: Annotation<{
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
  } | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Draft outreach template generated from enriched contact sample.
   * Persisted so user can customize before confirming.
   * Cleared after save_enriched_contacts.
   */
  pendingOutreachDraft: Annotation<{
    subject: string;
    body: string;
    variables: string[];
    tone: string;
  } | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Enrichment action waiting for campaign selection.
   * Set when the user confirms enrichment save but no activeCampaignId exists —
   * the agent fetches all campaigns and waits for the user to pick one.
   * Cleared after save_enriched_contacts succeeds or flow is discarded.
   */
  pendingEnrichmentAction: Annotation<"save_enriched_contacts" | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * ISO timestamp after which pending enrichment / campaign-selection state is stale.
   * Refreshed whenever enrichment wizard state is persisted; cleared on completion.
   */
  pendingWorkflowDeadlineIso: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * One-shot UX notice when loadMemory dropped expired workflow state.
   * Not persisted — consumed by finalResponse on the same turn.
   */
  workflowExpiredNotice: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Session metadata schema version from persisted snapshot (forward-compat).
   */
  sessionSchemaVersion: Annotation<number | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Active workflow lock to prevent overlapping multi-turn flows from corrupting state.
   * Persisted to session memory; expired locks are cleared in loadMemory.
   */
  activeWorkflowLock: Annotation<ActiveWorkflowLock | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Stack of suspended workflows (e.g. enrichment interrupted by Phase 3).
   * Persisted to session memory; expired items are cleared in loadMemory.
   */
  workflowStack: Annotation<WorkflowStackItem[] | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Direct response channel ────────────────────────────────────────────────────

  /**
   * Pre-formatted response string set by domain agents that have a complete
   * user-facing message ready without needing clarification or tool execution.
   *
   * When set, validation.node routes directly to finalResponse (bypassing the
   * clarification node) and finalResponse.node returns this value as-is.
   *
   * This is transient per-turn — never persisted to session memory.
   *
   * Used by EnrichmentAgent to surface enrichment previews, cancellation
   * messages, and help text without triggering the campaign-wizard
   * clarification flow.
   */
  formattedResponse: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  // ── Phase 3 multi-step enrichment (fetch → chained MCP tools, same turn) ────

  /**
   * Which Phase 3 intelligence flow is active after URL extraction (single-turn).
   * Set by EnrichmentAgent before fetch_website_content; consumed by phase3Continuation.
   */
  pendingPhase3EnrichmentAction: Annotation<
    | "analyze_company"
    | "detect_pain_points"
    | "generate_outreach"
    | "enrich_company"
    | undefined
  >({
    reducer: replace,
    default: () => undefined,
  }),

  /** Company label extracted from the user message (or hostname fallback). */
  pendingPhase3CompanyName: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /** Normalized page URL used for fetch_website_content and downstream tools. */
  pendingPhase3Url: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /** Website text after a successful fetch (capped); used by chained tools. */
  pendingPhase3WebsiteContent: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * MCP tools still to run after fetch succeeds, in order (does not include fetch).
   */
  pendingPhase3ToolQueue: Annotation<string[] | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * Scratch payload between chained steps (industry hints, pain points for draft, etc.).
   */
  pendingPhase3Scratch: Annotation<Record<string, unknown> | undefined>({
    reducer: replace,
    default: () => undefined,
  }),

  /**
   * When true, route executeTool → phase3Continuation → executeTool again.
   */
  pendingPhase3ContinueExecute: Annotation<boolean>({
    reducer: replace,
    default: () => false,
  }),

  // ── Error ─────────────────────────────────────────────────────────────────────

  /**
   * Human-readable error message if any node encountered a recoverable error.
   * When set, the formatResponse node renders an error reply rather than a
   * success response. Unrecoverable errors throw and are caught by the
   * graph executor.
   */
  error: Annotation<string | undefined>({
    reducer: replace,
    default: () => undefined,
  }),
});

// ── Exported type ─────────────────────────────────────────────────────────────

/** TypeScript type of the graph state — use this in node function signatures. */
export type AgentGraphStateType = typeof AgentGraphState.State;
