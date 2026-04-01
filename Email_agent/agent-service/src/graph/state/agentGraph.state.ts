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
  agentDomain: Annotation<"campaign" | "analytics" | "inbox" | "settings" | "general" | undefined>({
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
