/**
 * src/services/intentDetection.service.ts
 *
 * Intent detection service — two execution modes:
 *
 * ── Mode 1: deterministic (detect) ───────────────────────────────────────────
 *   Synchronous, sub-millisecond, zero I/O.
 *   Scores every IntentRule against the normalised input and picks the winner.
 *   Falls back to general_help when nothing exceeds INTENT_CONFIDENCE_THRESHOLD.
 *   Used directly in tests and as the safe fallback in all async paths.
 *
 * ── Mode 2: LLM-first (detectWithLLM) ────────────────────────────────────────
 *   Async. OpenAI is the PRIMARY classification path.
 *   Deterministic detect() is the FALLBACK.
 *
 *   Full LLM-first flow:
 *     1. If OPENAI_API_KEY is not configured → run detect() only.
 *     2. Call OpenAIService.classifyIntent() → raw JSON string.
 *     3. Parse JSON (safe — invalid JSON → fallback).
 *     4. Validate with LLMIntentResponseSchema (Zod).
 *        - Unknown intent      → fallback
 *        - Schema violation    → fallback
 *     5. If confidence < LLM_CONFIDENCE_THRESHOLD (0.7) → fallback.
 *     6. Any uncaught error    → fallback.
 *     7. Success → return LLM result with extractedArgs.
 *
 *   The deterministic path is ALWAYS the last resort, ensuring the method
 *   never throws and always returns a usable intent.
 *
 * ── Mode 3: deterministic-first (detectAsync) ────────────────────────────────
 *   Legacy async path kept for callers that prefer deterministic-primary
 *   behaviour with OpenAI as a low-confidence fallback.
 *
 * Adding a new intent:
 *   1. Add the literal to the Intent union in src/config/intents.ts.
 *   2. Add it to ALL_INTENTS and INTENT_RULES in the same file.
 *   3. Add it to INTENT_DOMAIN.
 *   4. Add a description to INTENT_DESCRIPTIONS in openai.service.ts.
 *   The Record<Intent, …> types enforce exhaustiveness at compile time.
 *
 * Provider note: the active LLM provider is OpenAI (openai.service.ts).
 *   Gemini (gemini.service.ts) remains in the codebase as a legacy class
 *   but is not wired into any live path.
 */

import { z } from "zod";
import { createLogger } from "../lib/logger.js";
import { getOpenAIService } from "./openai.service.js";
import { LLMIntentResponseSchema } from "../schemas/llmIntent.schema.js";
import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import {
  ALL_INTENTS,
  INTENT_RULES,
  INTENT_CONFIDENCE_THRESHOLD,
  FALLBACK_CONFIDENCE,
  type Intent,
  type IntentRule,
} from "../config/intents.js";

const log = createLogger("intentDetection");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum LLM confidence to accept the OpenAI result.
 * Below this value the service falls back to deterministic detection.
 * Chosen at 0.7 to reject hedging outputs (0.5–0.6 = "I'm not sure").
 */
const LLM_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Confidence assigned to a result from the old OpenAI fallback path
 * (detectAsync). Sits above INTENT_CONFIDENCE_THRESHOLD so routing proceeds.
 */
const OPENAI_FALLBACK_CONFIDENCE = 0.6;

// ── Result type ───────────────────────────────────────────────────────────────

export interface DetectedIntent {
  /** The resolved intent — always a valid member of the Intent union. */
  readonly intent: Intent;

  /**
   * Normalised confidence in [0, 1].
   *
   * Source mapping:
   *   1.0                        — every pattern in the deterministic rule matched
   *   OPENAI_FALLBACK_CONFIDENCE — OpenAI provided the result via detectAsync
   *   LLM value (≥ 0.7)          — OpenAI provided the result via detectWithLLM
   *   FALLBACK_CONFIDENCE        — fell back to general_help (no signal)
   */
  readonly confidence: number;

  /**
   * Keyword patterns that contributed to the score.
   * Empty when the result was produced by an LLM path.
   */
  readonly matchedPatterns: readonly string[];

  /**
   * Structured arguments extracted from the user message by Gemini.
   * Only present when detectWithLLM() succeeded and the LLM identified
   * relevant values in the message (campaignId, limit, query, filters).
   *
   * Undefined when the result came from the deterministic path or when
   * the LLM found no extractable values.
   *
   * Downstream nodes write this to state.llmExtractedArgs so domain agents
   * can read pre-parsed arguments instead of parsing the raw userMessage.
   */
  readonly extractedArgs?: LLMIntentArguments;
}

// ── Internal scoring ──────────────────────────────────────────────────────────

interface ScoredIntent {
  intent: Intent;
  rawScore: number;
  maxScore: number;
  confidence: number;
  matchedPatterns: string[];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreRule(rule: IntentRule, normalisedInput: string): ScoredIntent {
  let rawScore = 0;
  let maxScore = 0;
  const matchedPatterns: string[] = [];

  for (const { pattern, weight } of rule.patterns) {
    maxScore += weight;
    if (normalisedInput.includes(pattern)) {
      rawScore += weight;
      matchedPatterns.push(pattern);
    }
  }

  const confidence = maxScore > 0 ? Math.min(rawScore / maxScore, 1.0) : 0;

  return { intent: rule.intent, rawScore, maxScore, confidence, matchedPatterns };
}

// ── Service ───────────────────────────────────────────────────────────────────

export class IntentDetectionService {

  // ── Mode 1: deterministic ──────────────────────────────────────────────────

  /**
   * Synchronous, rule-based intent detection.
   * Always returns a result — never throws.
   *
   * This is the guaranteed fallback for all async methods.
   *
   * @param message - Raw user message (any casing, any whitespace)
   */
  detect(message: string): DetectedIntent {
    if (!message || message.trim().length === 0) {
      return this.fallback();
    }

    const normalisedInput = normalise(message);

    const scores: ScoredIntent[] = Object.values(INTENT_RULES).map((rule) =>
      scoreRule(rule, normalisedInput),
    );

    scores.sort((a, b) =>
      b.confidence !== a.confidence
        ? b.confidence - a.confidence
        : b.rawScore - a.rawScore,
    );

    const best = scores[0];

    if (!best || best.confidence < INTENT_CONFIDENCE_THRESHOLD) {
      log.debug(
        { normalisedInput, topIntent: best?.intent, topConfidence: best?.confidence },
        "No intent exceeded threshold — falling back to general_help",
      );
      return this.fallback();
    }

    log.debug(
      { intent: best.intent, confidence: best.confidence, matchedPatterns: best.matchedPatterns },
      "Intent detected (deterministic)",
    );

    return {
      intent: best.intent,
      confidence: parseFloat(best.confidence.toFixed(4)),
      matchedPatterns: best.matchedPatterns,
    };
  }

  // ── Mode 2: LLM-first ─────────────────────────────────────────────────────

  /**
   * LLM-primary intent detection with deterministic fallback.
   *
   * OpenAI is tried first.  detect() is called only when:
   *   - OPENAI_API_KEY is not configured
   *   - OpenAI returns null (SDK error)
   *   - The JSON response is not parseable
   *   - The parsed response fails Zod validation
   *   - The classified intent is not a known Intent literal
   *   - LLM confidence < LLM_CONFIDENCE_THRESHOLD (0.7)
   *   - Any uncaught exception
   *
   * This method NEVER throws.
   *
   * @param message - Raw user message
   */
  async detectWithLLM(message: string): Promise<DetectedIntent> {
    // Guard: OpenAI not configured → skip LLM entirely
    const openai = getOpenAIService();
    if (!openai) {
      return this.detect(message);
    }

    if (!message || message.trim().length === 0) {
      return this.fallback();
    }

    try {
      const rawJson = await openai.classifyIntent(message, ALL_INTENTS);

      // ── null → SDK failure (already logged inside classifyIntent) ──────────
      if (rawJson === null) {
        log.warn(
          { messageLength: message.length, source: "openai" },
          "OpenAI classifyIntent returned null — falling back to deterministic",
        );
        return this.detect(message);
      }

      // ── JSON parse ─────────────────────────────────────────────────────────
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        log.warn(
          { preview: rawJson.slice(0, 120), source: "openai" },
          "OpenAI response is not valid JSON — falling back to deterministic",
        );
        return this.detect(message);
      }

      // ── Zod validation ─────────────────────────────────────────────────────
      const validated = LLMIntentResponseSchema.safeParse(parsed);

      if (!validated.success) {
        const issues = validated.error.issues.map((i: z.ZodIssue) => i.message);
        log.warn(
          { issues, source: "openai" },
          "LLM response failed schema validation — falling back to deterministic",
        );
        return this.detect(message);
      }

      const llmResult = validated.data;

      // ── Confidence gate ────────────────────────────────────────────────────
      if (llmResult.confidence < LLM_CONFIDENCE_THRESHOLD) {
        log.debug(
          { intent: llmResult.intent, confidence: llmResult.confidence, threshold: LLM_CONFIDENCE_THRESHOLD, source: "openai" },
          "LLM confidence below threshold — falling back to deterministic",
        );
        return this.detect(message);
      }

      // ── Success ────────────────────────────────────────────────────────────
      log.info(
        {
          source:     "openai",
          intent:     llmResult.intent,
          confidence: llmResult.confidence,
          hasArgs:    llmResult.arguments !== undefined,
          extractedArgKeys: llmResult.arguments ? Object.keys(llmResult.arguments) : [],
        },
        "LLM-first intent detection succeeded",
      );

      return {
        intent:        llmResult.intent,
        confidence:    llmResult.confidence,
        matchedPatterns: [],
        extractedArgs: llmResult.arguments,
      };

    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : "unknown", source: "openai" },
        "LLM intent detection threw unexpectedly — falling back to deterministic",
      );
      return this.detect(message);
    }
  }

  // ── Mode 3: deterministic-first (legacy async) ────────────────────────────

  /**
   * Deterministic-first: runs detect() first, uses OpenAI only when
   * confidence falls to FALLBACK_CONFIDENCE (zero-signal case).
   *
   * Preserved for callers that prefer the deterministic-primary strategy.
   * New callers should use detectWithLLM() for the LLM-first approach.
   *
   * Never throws.
   *
   * @param message - Raw user message
   */
  async detectAsync(message: string): Promise<DetectedIntent> {
    const deterministic = this.detect(message);

    if (deterministic.confidence > FALLBACK_CONFIDENCE) {
      return deterministic;
    }

    const openai = getOpenAIService();
    if (!openai) {
      return deterministic;
    }

    try {
      const rawJson = await openai.classifyIntent(message, ALL_INTENTS);

      if (rawJson === null) return deterministic;

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        return deterministic;
      }

      const validated = LLMIntentResponseSchema.safeParse(parsed);
      if (!validated.success) return deterministic;

      const llmResult = validated.data;
      if (llmResult.intent === "general_help") return deterministic;

      log.info(
        { input: message.slice(0, 80), classified: llmResult.intent, source: "openai" },
        "OpenAI intent fallback used (detectAsync)",
      );

      return {
        intent:          llmResult.intent,
        confidence:      OPENAI_FALLBACK_CONFIDENCE,
        matchedPatterns: [],
        extractedArgs:   llmResult.arguments,
      };
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : "unknown", source: "openai" },
        "OpenAI intent classification failed — keeping deterministic result",
      );
    }

    return deterministic;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private fallback(): DetectedIntent {
    return {
      intent:          "general_help",
      confidence:      FALLBACK_CONFIDENCE,
      matchedPatterns: [],
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const intentDetectionService = new IntentDetectionService();
