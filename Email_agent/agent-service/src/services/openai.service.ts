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
  list_campaigns:     "List, show, or view all existing email campaigns — does NOT create a new one",
  create_campaign:    "Create a new email marketing campaign",
  update_campaign:    "Edit or modify an existing campaign (name, subject, body, etc.)",
  schedule_campaign:  "Schedule an existing campaign to send at a specific future date and time",
  start_campaign:     "Launch or send a campaign — this triggers real email delivery to recipients",
  pause_campaign:     "Pause a currently running campaign",
  resume_campaign:    "Resume a previously paused campaign",
  get_campaign_stats: "Retrieve analytics for a campaign: open rate, click rate, bounces, etc.",
  show_sequence_progress: "Show live multi-touch sequence progress, including active, completed, due, and stopped follow-ups",
  show_pending_follow_ups: "List recipients who have scheduled or due follow-up touches in an active sequence",
  show_recipient_touch_history: "Show one recipient's touch-by-touch sequence history and next scheduled follow-up",
  mark_recipient_replied: "Manually mark a recipient as replied so future follow-up touches stop",
  mark_recipient_bounced: "Manually mark a recipient as bounced so future follow-up touches stop",
  list_replies:       "List email replies received from campaign recipients",
  summarize_replies:  "Summarise or analyse the email replies received from recipients",
  show_hot_leads:     "Show hot leads: CRM leads that replied Interested or have a hot score, hottest first",
  show_meeting_ready_leads: "Show leads whose replies indicate meeting or demo readiness",
  summarize_objections: "Summarise objection types and reply intelligence analytics",
  draft_reply_to_latest_lead: "Draft or regenerate a safe suggested reply for a specific inbound reply",
  mark_reply_human_review: "Mark a reply or lead for human review",
  show_autonomous_recommendations: "Show campaign-level autonomous SDR recommendations and priority summary",
  explain_lead_priority: "Explain why a specific recipient or lead is prioritized",
  preview_sequence_adaptation: "Preview adaptive future-touch recommendations without changing stored sequence touches",
  show_next_best_action: "Show the next best action for a specific recipient or lead",
  show_escalation_queue: "Show leads requiring human review or escalation",
  check_smtp:         "Check or view the current SMTP / email server configuration",
  update_smtp:        "Change or update the SMTP / email server settings",
  general_help:           "General question about MailFlow capabilities, or intent is unclear but platform-related",
  out_of_domain:          "Question or request completely unrelated to MailFlow, email campaigns, analytics, inbox, or platform settings (e.g. general knowledge, weather, jokes, geography, math)",
  template_help:          "User asks what email templates are available, wants to see template options, or asks which template to use",
  upload_recipients_help: "User asks how to upload recipients, how to add contacts, or how to upload a CSV file",
  next_step_help:         "User asks what to do next, what the next step is, or what they should do now — session-aware guidance",
  ai_campaign_help:       "User asks how AI campaign creation works, wants a guide or explanation of the AI campaign wizard",
  recipient_status_help:  "User asks how many recipients they have, checks recipient count, or asks if recipients were uploaded",
  validate_email:           "Validate an email address — check if it is valid, business vs personal, or disposable",
  enrich_contact:           "Enrich a single contact or email address with company and domain information",
  fetch_company_website:    "Fetch or read the content of a company website or URL for enrichment purposes",
  extract_domain:           "Extract the domain from an email address, URL, or domain string",
  search_company_web:       "Search for a company's official website using Brave Search or heuristic domain guessing",
  select_official_website:  "Score a list of candidate website URLs and select the most likely official company website",
  verify_company_website:   "Verify whether a given URL is the official website for a specified company",
  research_companies:       "Read-only SDR research for one or more company URLs; no campaign creation, no recipients, no sending",
  outreach_research:        "Research-only outreach intelligence and templates; explicitly no campaign creation or sending",
  company_analysis:         "Analyze company URLs or websites and infer business type, pain points, and opportunities",
  generate_outreach_from_urls: "Generate SDR outreach drafts from company URLs without creating or sending a campaign",
  crm_summary:        "CRM overview: lead counts per pipeline stage, funnel, win rate, Interested / meetings / Won / Lost / needs-reply totals",
  crm_list_leads:     "List CRM leads (contacts) filtered by pipeline stage, reply label, Hot/Warm/Cold score, tag, campaign or needs-reply",
  crm_lead_details:   "Show one CRM lead by name or email: stage, score and why, tags, campaigns, replies, stage history",
  crm_needs_reply:    "List leads who replied and are still waiting for the user's answer (needs reply / unanswered)",
  crm_list_pipelines: "Show the user's CRM pipelines and their stages",
  crm_list_tags:      "Show the user's CRM tags",
  crm_move_lead:      "Move ONE CRM lead to a pipeline stage, or mark one lead as Won / Lost",
  crm_tag_lead:       "Add a tag to, or remove a tag from, ONE CRM lead",
  crm_create_tag:     "Create a new CRM tag",
  crm_snooze_lead:    "Snooze one lead's needs-reply reminder for a time (hours, days, until tomorrow)",
  crm_mark_done:      "Mark one lead as answered / done so it no longer needs a reply",
  crm_change_label:   "Change the reply label of one lead's latest reply (e.g. to Question or Interested)",
  crm_bulk_update:    "Move or tag MANY CRM leads at once, chosen by a filter (all hot leads, all leads in a stage, …)",
  crm_campaign_settings: "Set a campaign's CRM start pipeline or auto tags for all of its leads",
  // Tool names (used by the planner's tool list)
  get_crm_summary:      "CRM overview: leads per stage, funnel, KPIs (read-only)",
  list_crm_contacts:    "List CRM leads with filters: stage, labels, scoreTiers, tags, campaign, needsReply (read-only)",
  get_crm_contact:      "One CRM lead by name or email (read-only)",
  list_crm_needs_reply: "Leads waiting for the user's reply (read-only)",
  list_crm_pipelines:   "CRM pipelines with stages (read-only)",
  list_crm_tags:        "CRM tags (read-only)",
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

  /**
   * Generate a short summary + focus areas for website content fetched by the
   * fetch_website_content MCP tool.
   *
   * OpenAI receives only title, url, and the first 3 000 chars of content.
   * Returns plain text in the format the finalResponse formatter expects:
   *   SUMMARY:\n<text>\n\nFOCUS AREAS:\n- area1\n- area2…
   *
   * @throws {OpenAIServiceError} on SDK failure
   */
  async summarizeWebsiteContent(
    title: string | undefined,
    url: string,
    content: string,
  ): Promise<string> {
    const excerpt = content.slice(0, 3_000);
    const prompt = [
      "You are an AI assistant helping a sales team understand a company's website.",
      "Analyse the website content below and produce a short briefing.",
      "",
      `Website: ${url}`,
      ...(title ? [`Page title: ${title}`] : []),
      "",
      "Content excerpt:",
      excerpt,
      "",
      "Respond in EXACTLY this format (no JSON, no markdown code fences):",
      "",
      "SUMMARY:",
      "<One or two sentences describing what this company or website does.>",
      "",
      "FOCUS AREAS:",
      "- <area 1>",
      "- <area 2>",
      "- <area 3>",
      "",
      "Rules: summary ≤ 60 words; 3–5 focus areas; no filler phrases; no invented facts.",
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

  // ── Campaign draft generation ─────────────────────────────────────────────────

  /**
   * Auto-generate a complete campaign draft from the user's message / topic.
   *
   * Returns a record with all five required fields (name, subject, fromName,
   * fromEmail, body) or null when generation fails or the result is incomplete.
   *
   * Callers should merge the returned draft with any already-known fields,
   * giving priority to the user-supplied values over the generated ones.
   *
   * @param userMessage  - The original user message (topic / context)
   * @param knownFields  - Fields already extracted from the message (kept as-is)
   */
  async generateCampaignDraft(
    userMessage: string,
    knownFields: Record<string, unknown> = {},
  ): Promise<Record<string, string> | null> {
    const knownLines = Object.entries(knownFields)
      .filter(([, v]) => typeof v === "string" && (v as string).length > 0)
      .map(([k, v]) => `  ${k}: "${v as string}"`)
      .join("\n");

    const prompt = [
      "You are an email marketing assistant. Generate a complete, professional email campaign draft.",
      "Return a JSON object with ALL five fields. Use professional, engaging language.",
      "",
      `User request: "${userMessage}"`,
      ...(knownLines ? ["", "Fields already provided (keep these exactly):", knownLines] : []),
      "",
      "Rules:",
      "  name      — short, descriptive campaign name (e.g. 'Summer Sale 2024')",
      "  subject   — compelling email subject line (under 60 chars, no ALL CAPS)",
      "  fromName  — sender name; use 'Your Team' if unknown",
      "  fromEmail — sender address; use 'hello@yourcompany.com' as placeholder if unknown",
      "  body      — 2-3 short paragraphs of professional email body text in plain text",
      "",
      "Return ONLY valid JSON with exactly these keys: name, subject, fromName, fromEmail, body.",
      "No markdown, no explanation, no extra keys.",
    ].join("\n");

    try {
      const json = await this.generateJson(prompt);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const required = ["name", "subject", "fromName", "fromEmail", "body"];
      if (!required.every((f) => typeof parsed[f] === "string" && (parsed[f] as string).length > 0)) {
        logger.warn({ userMessage }, "generateCampaignDraft: incomplete response from OpenAI");
        return null;
      }
      return parsed as Record<string, string>;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      logger.warn({ error: message }, "generateCampaignDraft failed — falling back to step-by-step");
      return null;
    }
  }

  /**
   * Revise an existing campaign body according to a free-text instruction,
   * instead of replacing it outright with whatever the user typed.
   *
   * @param currentBody  - The body draft currently shown to the user
   * @param instruction  - The user's free-text change request (not a full body)
   * @param campaignName - Campaign name, for context
   * @param subject      - Subject line, for context
   * @throws {OpenAIServiceError} on SDK failure
   */
  async reviseCampaignBody(
    currentBody: string,
    instruction: string,
    campaignName: string | undefined,
    subject: string | undefined,
  ): Promise<string> {
    const prompt = [
      "You are an email marketing assistant revising a draft campaign email body.",
      "Apply the user's requested change to the CURRENT BODY below and return the full revised body.",
      "Keep placeholders like {{name}} and the overall structure unless the instruction asks to change them.",
      "Do not add commentary, explanations, or markdown code fences — return ONLY the revised email body text.",
      "",
      ...(campaignName ? [`Campaign name: "${campaignName}"`] : []),
      ...(subject ? [`Subject line: "${subject}"`] : []),
      "",
      "Current body:",
      currentBody,
      "",
      `User's requested change: "${instruction}"`,
      "",
      "Return ONLY the full revised email body.",
    ].join("\n");

    return this.generateText(prompt);
  }

  // ── Multi-step planning ───────────────────────────────────────────────────────

  /**
   * Ask OpenAI whether a user message requires multiple sequential MCP tool
   * calls, and if so, return the ordered plan as raw JSON.
   *
   * Returns the raw JSON string for the caller to validate with
   * OpenAIPlanResponseSchema. Returns `null` on any SDK failure so the
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
      "OUT-OF-DOMAIN RULE (critical):",
      '  Use "out_of_domain" when the message is COMPLETELY unrelated to MailFlow.',
      "  Examples of out-of-domain messages:",
      '    • "What is the capital of Pakistan?"',
      '    • "Who is Imran Khan?"',
      '    • "Tell me a joke"',
      '    • "What is the weather today?"',
      '    • "Solve 2+2"',
      '    • "Write me a poem"',
      '    • "Who won the World Cup?"',
      '  Use "general_help" for questions that ARE about MailFlow but unclear:',
      '    • "How do I get started?"',
      '    • "What can you help me with?"',
      "",
      "RESEARCH OUTREACH RULE (critical):",
      '  If the message contains multiple company URLs, classify it as "research_companies" unless the user asks to generate outreach drafts, then use "generate_outreach_from_urls".',
      '  If the message says "no campaign creation", "no sending", "output only templates", or "research mode", never classify it as create_campaign, generate_personalized_emails, schedule_campaign, or start_campaign.',
      '  For "research these companies", "analyze these websites", "SDR intelligence", "cold email", or "outreach drafts" with URLs, choose one of the research intents.',
      "",
      "CRM RULE:",
      '  Messages about CRM leads, pipeline stages, reply labels, lead scores (Hot/Warm/Cold), tags or',
      '  "needs reply" use the crm_* intents. Messages may be English or Roman Urdu',
      '  ("interested wale leads dikhao", "kis ko jawab dena hai", "Ali ki detail").',
      '  "show hot leads" with no other CRM words stays show_hot_leads.',
      "  For crm_list_leads put these keys in filters (only the ones the user said):",
      '    stage (stage name as written), labels (array of: interested, not_interested, out_of_office,',
      '    question, meeting_booked, neutral, bounce_unsubscribe), scoreTiers (array of hot, warm, cold),',
      '    tags (array of tag names), needsReply (true), sort ("score" | "waiting" | "recent").',
      "  A campaign name goes in campaignId. A person's name or email to search goes in query.",
      "  For crm_lead_details put the person's name or email in query.",
      "  CRM CHANGES (one lead → query = that lead's name or email):",
      "    crm_move_lead: filters.toStage = destination stage name.",
      "    crm_tag_lead: filters.tags = [tag names]; filters.remove = true when removing.",
      "    crm_create_tag: filters.name = new tag name; filters.color optional (red, green, blue, …).",
      '    crm_snooze_lead: filters.duration as the user said it ("3 days", "2 hours", "tomorrow").',
      "    crm_mark_done: only query.",
      "    crm_change_label: filters.label = new label (same label names as above).",
      '    crm_bulk_update (words like "all", "saare", "sab" + a filter): filters.targets = { stage, labels,',
      "      scoreTiers, tags, campaign, needsReply } choosing the leads, plus filters.toStage and/or",
      "      filters.addTags / filters.removeTags for what to do. Never use crm_bulk_update without a filter.",
      "    crm_campaign_settings: campaignId = campaign name, filters.pipeline and/or filters.tags (auto tags).",
      '  CONTEXT WORDS: "them", "these leads", "inko", "unko", "un sab ko" mean the leads the user just saw →',
      '    crm_bulk_update with query "them" (the app fills in the leads). "him", "her", "isko", "usko" mean the',
      '    last single lead → the one-lead intent with query "him".',
      '  "show X leads and tag/move them …" (or "… dikhao aur unko …") is ONE crm_bulk_update with',
      "    filters.targets = the filters of X.",
      "",
      "EXAMPLES:",
      "",
      '  Input:  "show interested leads with VIP tag"',
      '  Output: { "intent": "crm_list_leads", "confidence": 0.95, "arguments": { "filters": { "labels": ["interested"], "tags": ["VIP"] } } }',
      "",
      '  Input:  "Meeting Booked stage mein kaun kaun hai?"',
      '  Output: { "intent": "crm_list_leads", "confidence": 0.93, "arguments": { "filters": { "stage": "Meeting Booked" } } }',
      "",
      '  Input:  "kis ko jawab dena baqi hai"',
      '  Output: { "intent": "crm_needs_reply", "confidence": 0.95 }',
      "",
      '  Input:  "ali@shop.com ka score kyun 70 hai"',
      '  Output: { "intent": "crm_lead_details", "confidence": 0.94, "arguments": { "query": "ali@shop.com" } }',
      "",
      '  Input:  "CRM ka haal batao"',
      '  Output: { "intent": "crm_summary", "confidence": 0.95 }',
      "",
      '  Input:  "Ali Khan ko Meeting Booked mein daal do"',
      '  Output: { "intent": "crm_move_lead", "confidence": 0.95, "arguments": { "query": "Ali Khan", "filters": { "toStage": "Meeting Booked" } } }',
      "",
      '  Input:  "tag sara@x.com with VIP"',
      '  Output: { "intent": "crm_tag_lead", "confidence": 0.95, "arguments": { "query": "sara@x.com", "filters": { "tags": ["VIP"] } } }',
      "",
      '  Input:  "saare hot leads ko Engaged stage mein le jao"',
      '  Output: { "intent": "crm_bulk_update", "confidence": 0.94, "arguments": { "filters": { "targets": { "scoreTiers": ["hot"] }, "toStage": "Engaged" } } }',
      "",
      '  Input:  "hot leads dikhao aur unko VIP tag laga do"',
      '  Output: { "intent": "crm_bulk_update", "confidence": 0.93, "arguments": { "filters": { "targets": { "scoreTiers": ["hot"] }, "addTags": ["VIP"] } } }',
      "",
      '  Input:  "inko Engaged mein daal do"',
      '  Output: { "intent": "crm_bulk_update", "confidence": 0.9, "arguments": { "query": "them", "filters": { "toStage": "Engaged" } } }',
      "",
      '  Input:  "snooze Ali for 3 days"',
      '  Output: { "intent": "crm_snooze_lead", "confidence": 0.95, "arguments": { "query": "Ali", "filters": { "duration": "3 days" } } }',
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
      '  Input:  "What is the capital of France?"',
      '  Output: { "intent": "out_of_domain", "confidence": 0.99 }',
      "",
      '  Input:  "Research these companies, no campaign creation: https://acme.com https://example.io"',
      '  Output: { "intent": "research_companies", "confidence": 0.99 }',
      "",
      '  Input:  "Generate outreach drafts from https://acme.com and https://example.io, output only templates"',
      '  Output: { "intent": "generate_outreach_from_urls", "confidence": 0.99 }',
      "",
      '  Input:  "Tell me a joke"',
      '  Output: { "intent": "out_of_domain", "confidence": 0.99 }',
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
