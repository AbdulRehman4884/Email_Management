/**
 * src/graph/nodes/detectIntent.node.ts
 *
 * First detection node in the agent graph.
 *
 * Strategy — LLM-first with deterministic fallback:
 *   1. detectWithLLM() asks OpenAI to classify the intent AND extract
 *      structured arguments (campaignId, limit, query, filters).
 *   2. If OpenAI is unavailable, returns low-confidence JSON, or fails Zod
 *      validation → falls back to synchronous rule-based detect().
 *   3. If LLM confidence < 0.7 → falls back to deterministic detect().
 *
 * State written:
 *   intent           — resolved Intent literal
 *   confidence       — normalised confidence in [0, 1]
 *   llmExtractedArgs — structured args from OpenAI; undefined when
 *                      the deterministic path ran or no args were found.
 *                      Domain agents should read this field to get
 *                      pre-parsed values instead of re-parsing userMessage.
 *
 * What this node does NOT do:
 *   - Set toolArgs (domain agents own that field)
 *   - Call MCP tools
 *   - Execute any workflow actions
 *
 * Audit and structured logging are unchanged from the previous implementation.
 */

import { createLogger } from "../../lib/logger.js";
import { intentDetectionService } from "../../services/intentDetection.service.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:detectIntent");

export async function detectIntentNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { userMessage, sessionId, userId } = state;

  // ── LLM-first detection ───────────────────────────────────────────────────
  // detectWithLLM() never throws — deterministic detect() is always the
  // last resort if anything goes wrong with the LLM path.
  const detected = await intentDetectionService.detectWithLLM(userMessage);

  // ── Structured log ────────────────────────────────────────────────────────
  log.info(
    {
      sessionId,
      userId,
      intent:          detected.intent,
      confidence:      detected.confidence,
      matchedPatterns: detected.matchedPatterns,
      // Log extracted arg keys only — values may contain user PII
      extractedArgKeys: detected.extractedArgs
        ? Object.keys(detected.extractedArgs)
        : [],
      source: detected.matchedPatterns.length > 0 ? "deterministic" : "llm",
    },
    "Intent detected",
  );

  // ── Audit log (unchanged contract) ────────────────────────────────────────
  auditLogService.intentDetected(
    {
      userId:    userId    as string | undefined,
      sessionId: sessionId as string | undefined,
    },
    {
      intent:          detected.intent,
      confidence:      detected.confidence,
      matchedPatterns: detected.matchedPatterns,
    },
  );

  // ── State patch ───────────────────────────────────────────────────────────
  // llmExtractedArgs is written to state so domain agents can read pre-parsed
  // values (campaignId, limit, query, filters) without re-parsing userMessage.
  // When the deterministic path ran, extractedArgs is undefined — the field
  // defaults to undefined in state, so no explicit clear is needed.
  return {
    intent:          detected.intent,
    confidence:      detected.confidence,
    llmExtractedArgs: detected.extractedArgs,
  };
}
