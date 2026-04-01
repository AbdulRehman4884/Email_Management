/**
 * src/schemas/plan.schema.ts
 *
 * Zod schemas for validating the LLM's multi-step plan response.
 *
 * The LLM (OpenAI) is asked to return a JSON object describing whether the
 * user message requires multiple tool calls, and if so, what the ordered
 * steps are. This schema validates that response before PlannerService builds
 * the typed PlannedStep[] array.
 *
 * Validation rules:
 *   - tool must be a known MCP tool name (prevents hallucinated tool calls)
 *   - intent must be a known intent (keeps routing consistent)
 *   - steps array is capped at MAX_PLAN_STEPS (prevents prompt injection bloat)
 *   - description is limited to 200 characters (UI safety)
 */

import { z } from "zod";
import { KNOWN_TOOL_NAMES } from "../types/tools.js";
import { ALL_INTENTS } from "../config/intents.js";
import { MAX_PLAN_STEPS } from "../lib/planTypes.js";

// ── Step schema ───────────────────────────────────────────────────────────────

export const LLMPlanStepSchema = z.object({
  tool: z.string().refine(
    (v): v is (typeof KNOWN_TOOL_NAMES)[number] =>
      (KNOWN_TOOL_NAMES as readonly string[]).includes(v),
    (v) => ({ message: `"${v}" is not a known MCP tool` }),
  ),
  intent: z.string().refine(
    (v): v is (typeof ALL_INTENTS)[number] =>
      (ALL_INTENTS as readonly string[]).includes(v),
    (v) => ({ message: `"${v}" is not a recognised intent` }),
  ),
  description: z.string().min(1).max(200),
});

export type LLMPlanStep = z.infer<typeof LLMPlanStepSchema>;

// ── Full plan response schema ─────────────────────────────────────────────────

export const LLMPlanResponseSchema = z.object({
  isMultiStep: z.boolean(),
  steps: z.array(LLMPlanStepSchema).min(1).max(MAX_PLAN_STEPS),
});

export type LLMPlanResponse = z.infer<typeof LLMPlanResponseSchema>;

// ── Legacy aliases (kept for any external consumers) ─────────────────────────

/** @deprecated Use LLMPlanStepSchema */
export const GeminiPlanStepSchema = LLMPlanStepSchema;
/** @deprecated Use LLMPlanStep */
export type GeminiPlanStep = LLMPlanStep;
/** @deprecated Use LLMPlanResponseSchema */
export const GeminiPlanResponseSchema = LLMPlanResponseSchema;
/** @deprecated Use LLMPlanResponse */
export type GeminiPlanResponse = LLMPlanResponse;
