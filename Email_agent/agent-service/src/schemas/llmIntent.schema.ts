/**
 * src/schemas/llmIntent.schema.ts
 *
 * Zod schemas and TypeScript types for the structured JSON response that
 * the LLM (OpenAI) must return when classifying a user's intent.
 *
 * These schemas are the contract between:
 *   - OpenAIService.classifyIntent()  (produces the raw JSON string)
 *   - IntentDetectionService.detectWithLLM()  (validates and consumes it)
 *
 * Every field is validated before any value is trusted.  The schemas are
 * deliberately narrow:
 *   - `intent` must be one of the statically-known Intent literals.
 *   - `confidence` is clamped to [0, 1].
 *   - `arguments` fields are individually typed; unknown keys are stripped.
 *
 * If the LLM returns anything that does not satisfy these schemas, the caller
 * falls back to deterministic rule-based detection rather than accepting
 * potentially corrupt data.
 *
 * Adding a new extractable argument:
 *   1. Add the field to LLMIntentArgumentsSchema with the correct Zod type.
 *   2. Update the prompt in OpenAIService.classifyIntent() to mention the
 *      new field so the LLM knows to include it.
 *   3. Update the relevant domain agent to read the new field from
 *      state.llmExtractedArgs.
 */

import { z } from "zod";
import { ALL_INTENTS, type Intent } from "../config/intents.js";

// ── Arguments ─────────────────────────────────────────────────────────────────

/**
 * Structured arguments that Gemini can extract from a natural-language message.
 *
 * All fields are optional — Gemini should only populate a key when the user
 * explicitly mentioned the corresponding value.  Keys not mentioned by the
 * user must be omitted entirely (not set to null or an empty string).
 *
 * Fields:
 *   campaignId — A campaign name or identifier the user referred to.
 *   filters    — Arbitrary key/value filter criteria (date range, status, etc.)
 *                For create_campaign, Gemini is instructed to nest the five
 *                required fields here: name, subject, fromName, fromEmail, body.
 *   limit      — A count or maximum number of items the user requested.
 *   query      — A keyword, search term, or free-text query the user stated.
 *
 * create_campaign fields (name / subject / fromName / fromEmail / body):
 *   The classification prompt instructs the LLM to place these inside
 *   `filters`.  However, some models may return them at the top level of the
 *   `arguments` object instead.  Declaring them here (as optional fields)
 *   prevents `.strip()` from discarding them so toolArgResolver can read
 *   them as a fallback when they are not present in `filters`.
 */
export const LLMIntentArgumentsSchema = z
  .object({
    campaignId: z.string().min(1).optional(),
    replyId: z.string().min(1).optional(),
    recipientId: z.string().min(1).optional(),
    recipientEmail: z.string().email().optional(),
    replyText: z.string().min(1).optional(),
    scenario: z.enum([
      "pricing_objection",
      "competitor_objection",
      "timing_objection",
      "meeting_interest",
      "positive_interest",
      "unsubscribe",
      "spam_complaint",
    ]).optional(),
    mode: z.enum(["default", "low_promotional_plaintext", "executive_direct", "friendly_human", "value_first"]).optional(),
    filters:    z.record(z.unknown()).optional(),
    limit:      z.number().int().positive().optional(),
    query:      z.string().min(1).optional(),
    // create_campaign fields — present when Gemini returns them at top level
    // instead of (or in addition to) nesting them inside `filters`.
    name:       z.string().min(1).optional(),
    subject:    z.string().min(1).optional(),
    fromName:   z.string().min(1).optional(),
    fromEmail:  z.string().min(1).optional(),
    body:       z.string().min(1).optional(),
  })
  .strip(); // discard any truly unknown keys Gemini may invent

export type LLMIntentArguments = z.infer<typeof LLMIntentArgumentsSchema>;

// ── Full LLM response ─────────────────────────────────────────────────────────

const VALID_INTENTS: readonly string[] = ALL_INTENTS;

/**
 * The complete JSON object that the LLM must return from classifyIntent().
 *
 * `intent` is validated against the compile-time Intent union so a stale or
 * hallucinated intent name is caught before it reaches the router.
 *
 * `confidence` is normalised to 4 decimal places after parsing.
 */
export const LLMIntentResponseSchema = z.object({
  intent: z
    .string()
    .refine(
      (v): v is Intent => VALID_INTENTS.includes(v),
      (v) => ({ message: `"${v}" is not a recognised intent` }),
    ),

  confidence: z
    .number()
    .min(0, "confidence must be ≥ 0")
    .max(1, "confidence must be ≤ 1")
    .transform((v) => parseFloat(v.toFixed(4))),

  arguments: LLMIntentArgumentsSchema.optional(),
});

export type LLMIntentResponse = z.infer<typeof LLMIntentResponseSchema>;
