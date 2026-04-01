/**
 * src/services/openai.service.ts
 *
 * Provider-isolated OpenAI integration service.
 *
 * Capabilities exposed to the rest of agent-service:
 *   1. classifyIntent   — LLM intent classification returning structured JSON
 *   2. summarizeReplies — Transform raw MCP reply data into human-readable text
 *   3. enhanceResponse  — Polish a deterministic response into natural language
 *   4. planSteps        — Determine if a message needs multi-step MCP tool calls
 *
 * Design rules:
 *   - The OpenAI SDK is NEVER imported by callers. Only this module knows about
 *     the provider. Swap the implementation here to change providers without
 *     touching any other file.
 *   - OPENAI_API_KEY is read once at construction time and never written to any
 *     log field, error message, or variable name that could be serialised.
 *   - All SDK errors are caught and re-thrown as OpenAIServiceError so callers
 *     never need to import "openai" for error handling.
 *   - OpenAI must NEVER make MCP tool calls or backend API requests directly.
 *     It only processes text and data passed to it by callers.
 *   - OPENAI_MODEL defaults to "gpt-4o-mini" (controlled via env.ts).
 */

import OpenAI from "openai";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";

// ── Error type ────────────────────────────────────────────────────────────────

export class OpenAIServiceError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpenAIServiceError";
  }
}

// ── Intent descriptions used in the classification prompt ─────────────────────

const INTENT_DESCRIPTIONS: Record<string, string> = {
  create_campaign:    "Create a new email marketing campaign",
  update_campaign:    "Edit or modify an existing campaign (name, subject, body, etc.)",
  start_campaign:     "Launch or send a campaign — this triggers real email delivery to recipients",
  pause_campaign:     "Pause a currently running campaign",
  resume_campaign:    "Resume a previously paused campaign",
  get_campaign_stats: "Retrieve analytics for a campaign: open rate, click rate, bounces, etc.",
  list_replies:       "List email replies received from campaign recipients",
  summarize_replies:  "Summarise or analyse the email replies received from recipients",
  check_smtp:         "Check or view the current SMTP / email server configuration",
  update_smtp:        "Change or update the SMTP / email server settings",
  general_help:       "General question about capabilities, or the user's intent is unclear",
};

// ── Service ───────────────────────────────────────────────────────────────────

const logger = createLogger("OpenAIService");

export class OpenAIService {
  private readonly client: OpenAI;
  private readonly modelName: string;

  /**
   * @param apiKey - The OpenAI API key. Callers must ensure this is non-empty.
   *                 The factory `getOpenAIService()` enforces this invariant —
   *                 only construct directly in tests where you control the key.
   */
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
    this.modelName = env.OPENAI_MODEL;

    logger.info({ model: this.modelName }, "OpenAIService initialised");
  }

  // ── Low-level primitives ──────────────────────────────────────────────────────

  /**
   * Send a prompt and return a plain-text response.
   * Used for prose tasks: summarization, response enhancement.
   *
   * @throws {OpenAIServiceError} on any SDK or network failure.
   */
  async generateText(prompt: string): Promise<string> {
    logger.debug({ model: this.modelName, promptLength: prompt.length }, "OpenAI text request");

    try {
      const completion = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: "user", content: prompt }],
      });

      const text = completion.choices[0]?.message?.content ?? "";

      logger.debug(
        { model: this.modelName, responseLength: text.length },
        "OpenAI text response received",
      );

      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown OpenAI SDK error";
      logger.error({ model: this.modelName, error: message }, "OpenAI text request failed");
      throw new OpenAIServiceError(`OpenAI generateText failed: ${message}`, err);
    }
  }

  /**
   * Send a prompt and return a response guaranteed to be valid JSON.
   *
   * Uses `response_format: { type: "json_object" }` so the model cannot wrap
   * its output in markdown code fences. Requires the prompt to mention JSON.
   *
   * @throws {OpenAIServiceError} on SDK failure.
   */
  private async generateJson(prompt: string): Promise<string> {
    logger.debug({ model: this.modelName, promptLength: prompt.length }, "OpenAI JSON request");

    try {
      const completion = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });

      const text = completion.choices[0]?.message?.content ?? "{}";

      logger.debug(
        { model: this.modelName, responseLength: text.length },
        "OpenAI JSON response received",
      );

      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown OpenAI SDK error";
      logger.error({ model: this.modelName, error: message }, "OpenAI JSON request failed");
      throw new OpenAIServiceError(`OpenAI generateJson failed: ${message}`, err);
    }
  }

  // ── Intent classification ─────────────────────────────────────────────────────

  /**
   * Classify a user message and extract structured arguments.
   *
   * Returns the raw JSON string that the caller must validate with
   * LLMIntentResponseSchema (src/schemas/llmIntent.schema.ts). Returning
   * the raw string keeps this service provider-isolated — validation logic
   * and the allowed-intent list live in the intentDetection service.
   *
   * Returns `null` on any SDK failure so the caller can fall back to
   * deterministic detection without an exception handler.
   *
   * @param message    - Raw user message
   * @param candidates - Exhaustive list of valid intent names
   */
  async classifyIntent(
    message: string,
    candidates: readonly string[],
  ): Promise<string | null> {
    const prompt = this.buildClassifyIntentPrompt(message, candidates);

    try {
      return await this.generateJson(prompt);
    } catch {
      // SDK failure → let the caller fall back to deterministic detection
      return null;
    }
  }

  // ── Summarization ─────────────────────────────────────────────────────────────

  /**
   * Generate a natural-language summary from raw reply data returned by the
   * MCP `summarize_replies` tool.
   *
   * OpenAI receives only the `rawData` argument. It makes no API or tool calls.
   *
   * @param rawData - The `data` field from the MCP tool result (any shape)
   * @throws {OpenAIServiceError} on SDK failure
   */
  async summarizeReplies(rawData: unknown): Promise<string> {
    const dataStr =
      typeof rawData === "string"
        ? rawData
        : JSON.stringify(rawData, null, 2);

    const prompt = [
      "You are an assistant analysing email campaign replies for a business user.",
      "Summarise the following reply data in a clear, concise, business-friendly format.",
      "",
      "Reply data:",
      dataStr,
      "",
      "Your summary must include:",
      "1. Total reply count (if determinable from the data)",
      "2. Common themes or topics mentioned by recipients",
      "3. Overall sentiment (positive / negative / neutral / mixed)",
      "4. Actionable insights the campaign owner should know",
      "",
      "Constraints: under 200 words, plain prose (not JSON or bullet-only lists).",
    ].join("\n");

    return this.generateText(prompt);
  }

  // ── Response enhancement ──────────────────────────────────────────────────────

  /**
   * Rewrite a raw deterministic response into more natural, conversational
   * language. All factual information must be preserved exactly.
   *
   * @param intent      - The user's detected intent (for context framing)
   * @param userMessage - The original user message (for personalisation)
   * @param rawResponse - The response text to enhance
   * @throws {OpenAIServiceError} on SDK failure
   */
  async enhanceResponse(
    intent: string,
    userMessage: string,
    rawResponse: string,
  ): Promise<string> {
    const prompt = [
      "You are a helpful email campaign management assistant.",
      "Rewrite the response below to be more natural and conversational.",
      "Preserve ALL factual information exactly — do not add, remove, or invent facts.",
      "",
      `User intent: ${intent.replace(/_/g, " ")}`,
      `User said: "${userMessage}"`,
      "",
      "Current response to improve:",
      rawResponse,
      "",
      "Return ONLY the improved response text — no preamble, no quotation marks.",
    ].join("\n");

    return this.generateText(prompt);
  }

  // ── Multi-step planning ───────────────────────────────────────────────────────

  /**
   * Ask OpenAI whether a user message requires multiple sequential MCP tool
   * calls, and if so, return the ordered plan as raw JSON.
   *
   * Returns the raw JSON string for the caller to validate with
   * GeminiPlanResponseSchema. Returns `null` on any SDK failure so the
   * caller can fall back to the single-step path silently.
   *
   * @param message      - Raw user message
   * @param knownTools   - All valid MCP tool names (for prompt grounding)
   * @param knownIntents - All valid intent names (for prompt grounding)
   */
  async planSteps(
    message: string,
    knownTools: readonly string[],
    knownIntents: readonly string[],
  ): Promise<string | null> {
    const prompt = this.buildPlanStepsPrompt(message, knownTools, knownIntents);
    try {
      return await this.generateJson(prompt);
    } catch {
      return null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private buildClassifyIntentPrompt(
    message: string,
    candidates: readonly string[],
  ): string {
    const intentList = candidates
      .map((c) => `  ${c.padEnd(22)} – ${INTENT_DESCRIPTIONS[c] ?? c.replace(/_/g, " ")}`)
      .join("\n");

    return [
      "You are an intent classifier for an email campaign management platform.",
      "Your ONLY task is to analyse the user message below and return a JSON object.",
      "",
      "STRICT RESTRICTIONS — you must not violate these under any circumstances:",
      "  - Do NOT call any tools, functions, or APIs.",
      "  - Do NOT access secrets, credentials, or external services.",
      "  - Analyse only the text provided here — nothing else.",
      "",
      `User message: "${message}"`,
      "",
      "Available intents:",
      intentList,
      "",
      "Return a JSON object with EXACTLY this structure:",
      "{",
      '  "intent":     "<one of the intent names listed above>",',
      '  "confidence": 0.95,',
      '  "arguments": {',
      '    "campaignId": "<campaign name or slug — include whenever a specific campaign is mentioned>",',
      '    "limit":      <integer — omit if user stated no count>,',
      '    "query":      "<search term — omit if user stated none>",',
      '    "filters":    { } ',
      "  }",
      "}",
      "",
      "FIELD RULES:",
      "",
      '  intent      — exactly one name from the list above; use "general_help" when unclear.',
      "  confidence  — float in [0.0, 1.0]; use 0.9+ when the intent is obvious.",
      "",
      "  arguments   — include this key whenever you can extract ANY of the sub-fields below.",
      "               Omit arguments entirely ONLY when ALL sub-fields are absent.",
      "               Each sub-field is independently optional.",
      "",
      "  campaignId  — EXTRACT THIS FIELD whenever the user's message refers to a specific",
      "               campaign by any identifier: a slug, name, or keyword. Examples:",
      '               • "pause campaign test-123"           → campaignId: "test-123"',
      '               • "stop the Black Friday campaign"     → campaignId: "Black Friday"',
      '               • "show stats for summer-sale-2024"   → campaignId: "summer-sale-2024"',
      '               • "resume my Q4 Launch campaign"      → campaignId: "Q4 Launch"',
      '               • "how is that campaign doing"         → omit (no specific campaign named)',
      '               • "show all campaign stats"            → omit (refers to all campaigns)',
      "               Rule: if the message says \"campaign X\" or \"the X campaign\" or contains",
      "               a campaign-like slug/name, set campaignId to that identifier.",
      "",
      "  limit       — include only when the user stated a count (e.g. \"last 10 replies\" → 10).",
      "  query       — include only when the user provided a search term or keyword.",
      "  filters     — Use for two purposes:",
      "               (a) Structured filter criteria (date range, status, etc.).",
      "               (b) Campaign-creation fields for the create_campaign intent.",
      "                   When the user is creating a campaign, extract ALL of these",
      "                   into the filters object (omit any that were not stated):",
      '                     • "name"      — campaign name  (from "called X" or "named X")',
      '                     • "subject"   — email subject line',
      '                     • "fromName"  — sender display name (from "from NAME at …")',
      '                     • "fromEmail" — sender email address',
      '                     • "body"      — email body content (from "body: …")',
      "",
      "EXAMPLES:",
      "",
      '  Input:  "pause campaign test-123"',
      '  Output: { "intent": "pause_campaign", "confidence": 0.97, "arguments": { "campaignId": "test-123" } }',
      "",
      '  Input:  "how are my campaigns performing"',
      '  Output: { "intent": "get_campaign_stats", "confidence": 0.85 }',
      "",
      '  Input:  "show me the last 5 replies for Black Friday"',
      '  Output: { "intent": "list_replies", "confidence": 0.93, "arguments": { "campaignId": "Black Friday", "limit": 5 } }',
      "",
      '  Input:  "Create a campaign called Summer Sale, subject: Big Deals, from John at john@example.com, body: Check out our offers."',
      '  Output: { "intent": "create_campaign", "confidence": 0.97, "arguments": { "filters": { "name": "Summer Sale", "subject": "Big Deals", "fromName": "John", "fromEmail": "john@example.com", "body": "Check out our offers." } } }',
      "",
      "Return ONLY valid JSON — no markdown fences, no explanation, no extra text.",
    ].join("\n");
  }

  private buildPlanStepsPrompt(
    message: string,
    knownTools: readonly string[],
    knownIntents: readonly string[],
  ): string {
    const toolList = knownTools
      .map((t) => `  ${t.padEnd(24)} – ${INTENT_DESCRIPTIONS[t.replace("get_smtp_settings", "check_smtp").replace("update_smtp_settings", "update_smtp")] ?? t.replace(/_/g, " ")}`)
      .join("\n");

    return [
      "You are a planning assistant for an email campaign management platform.",
      "Your ONLY task is to determine if a user message requires MULTIPLE MCP tool calls and return a JSON plan.",
      "",
      "STRICT RESTRICTIONS — you must not violate these under any circumstances:",
      "  - Do NOT call any tools, functions, or APIs.",
      "  - Do NOT access secrets, credentials, or external services.",
      "  - Analyse only the text provided here — nothing else.",
      "",
      `User message: "${message}"`,
      "",
      "Available MCP tools:",
      toolList,
      "",
      `Valid intent names: ${knownIntents.join(", ")}`,
      "",
      "Determine if this message requires 2 or 3 sequential tool calls to fulfil completely.",
      "If it requires only 1 tool call (or no tool at all), set isMultiStep=false.",
      "",
      "Return a JSON object with EXACTLY this structure (no other keys, no markdown):",
      "{",
      '  "isMultiStep": true,',
      '  "steps": [',
      '    { "tool": "<exact tool name>", "intent": "<exact intent name>", "description": "<short description under 100 chars>" },',
      "    ...",
      "  ]",
      "}",
      "",
      "Rules:",
      "  isMultiStep — set to false if only 1 tool needed; steps array still required (include the single step).",
      "  tool        — must be exactly one of the tool names listed above.",
      "  intent      — must be exactly one of the valid intent names listed above.",
      "  description — one short sentence describing what this step does for the user.",
      "  Maximum 3 steps total.",
      "",
      "Return ONLY valid JSON — no markdown fences, no explanation, no extra text.",
    ].join("\n");
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: OpenAIService | undefined;

/**
 * Returns the OpenAIService singleton, or `undefined` when OPENAI_API_KEY
 * is not configured.
 *
 * Callers must handle the `undefined` case and fall back to deterministic
 * logic — no error is thrown when the key is absent.
 */
export function getOpenAIService(): OpenAIService | undefined {
  if (!env.OPENAI_API_KEY) return undefined;
  if (!_instance) {
    _instance = new OpenAIService(env.OPENAI_API_KEY);
  }
  return _instance;
}
