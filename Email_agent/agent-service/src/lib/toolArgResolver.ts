/**
 * src/lib/toolArgResolver.ts
 *
 * Central argument-resolution layer for MCP tool calls.
 *
 * Responsibility: given the structured arguments extracted by Gemini during
 * intent detection (state.llmExtractedArgs) and the session context
 * (state.activeCampaignId), produce a validated, sanitised toolArgs object
 * that is safe to pass directly to mcpClientService.dispatch().
 *
 * Resolution priority for campaignId:
 *   1. llmExtractedArgs.campaignId  — LLM identified a specific campaign in the message
 *   2. activeCampaignId             — session context from a prior conversation turn
 *   3. absent                       — MCP tool receives no campaignId;
 *                                     the MCP server returns a validation error
 *
 * Security rules (enforced here, tested in toolArgResolver.test.ts):
 *   • userId, accountId, tenantId are NEVER accepted from LLM-extracted args.
 *     User identity is resolved exclusively from the JWT bearer token inside
 *     toolExecution.service.ts → the MCP server. No LLM output can influence
 *     whose account an action is performed on.
 *   • Any key inside `filters` whose name matches an identity or auth pattern
 *     is stripped before the filters are merged into toolArgs.
 *   • All numeric/string field values are validated for type and range.
 *
 * MCP tools apply their own authoritative Zod validation on receipt.
 * This resolver provides best-effort population — it does not duplicate
 * the MCP server's validation rules.
 *
 * Adding a new tool:
 *   1. Add the tool name to KNOWN_TOOL_NAMES in src/types/tools.ts.
 *   2. Add a resolver function below.
 *   3. Register it in RESOLVERS.
 *   4. Add tests in src/lib/__tests__/toolArgResolver.test.ts.
 */

import { createLogger } from "./logger.js";
import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import type { KnownToolName } from "../types/tools.js";

const log = createLogger("toolArgResolver");

// ── Resolver input ────────────────────────────────────────────────────────────

export interface ResolverInput {
  /**
   * Structured arguments extracted by Gemini during intent detection.
   * Set by detectIntent.node via intentDetection.service.detectWithLLM().
   * Undefined when the deterministic detection path ran or Gemini found no args.
   */
  readonly extractedArgs: LLMIntentArguments | undefined;

  /**
   * Campaign the user is currently working with, persisted across turns.
   * Used as a fallback source for campaignId when the LLM did not extract one.
   */
  readonly activeCampaignId: string | undefined;
}

// ── Security: forbidden key patterns ─────────────────────────────────────────

/**
 * Lowercase key fragments that MUST NOT appear in tool args sourced from LLM
 * output. User identity and auth material must come only from the bearer token.
 *
 * The check normalises keys by lower-casing and stripping separators before
 * comparing, so variants like "user_id", "UserId", "USER-ID" are all caught.
 */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  "userid",
  "accountid",
  "tenantid",
  "token",
  "secret",
  "password",
  "apikey",
  "auth",
  "credential",
];

/** Returns true when `key` contains an identity or auth pattern. */
function isForbiddenKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[_\-\s]/g, "");
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) =>
    normalised.includes(fragment),
  );
}

/**
 * Return a copy of `filters` with every identity/auth key removed.
 * Returns `{}` when `filters` is absent or empty.
 */
function sanitizeFilters(
  filters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!filters) return {};

  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (!isForbiddenKey(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

// ── Campaign ID validation ────────────────────────────────────────────────────

/**
 * Returns true when `value` is a valid campaign ID for this backend.
 *
 * The backend stores campaign IDs as PostgreSQL INTEGER primary keys.
 * Any non-numeric value (e.g. "...", "all", "recipients", "camp-1") causes
 * a PostgreSQL 22P02 error when the backend tries to bind it to an INTEGER
 * column parameter.
 *
 * Accepts:
 *   • Numeric-only strings:  "1", "42", "123"
 *   • Positive integers:      1, 42, 123
 *
 * Rejects:
 *   • Non-numeric strings:   "all", "...", "recipients", "camp-1", ""
 *   • Zero or negative ints: 0, -1
 *   • null / undefined / other types
 */
export function isValidCampaignId(value: unknown): boolean {
  return (
    (typeof value === "string" && /^[0-9]+$/.test(value.trim())) ||
    (typeof value === "number" && Number.isInteger(value) && value > 0)
  );
}

/**
 * Returns the canonical string form of a valid campaign ID, or `undefined`
 * when the value is invalid.  Applied to both LLM-extracted and session-held
 * campaignId values before they are used.
 */
export function normalizeCampaignId(value: unknown): string | undefined {
  if (!isValidCampaignId(value)) return undefined;
  return String(value).trim();
}

/**
 * Resolves the best available campaignId from two sources, applying the same
 * numeric validation to both:
 *
 *   1. extractedArgs.campaignId — LLM identified a specific campaign.
 *      Accepted only when the value passes isValidCampaignId().  Template
 *      artefacts like "...", natural-language phrases, and slug-style IDs
 *      are all rejected.
 *
 *   2. activeCampaignId — session context from a prior conversation turn.
 *      Also validated — in-session IDs came from real campaign-creation
 *      responses (backend integers), so they should always pass.  If for
 *      any reason a stale or malformed value is present it is discarded.
 *
 * Returns `undefined` when neither source provides a valid numeric ID.  The
 * caller decides how to handle the absence (e.g. trigger campaign selection).
 */
function resolveCampaignId(input: ResolverInput): string | undefined {
  const fromLLM = normalizeCampaignId(input.extractedArgs?.campaignId);
  if (fromLLM !== undefined) return fromLLM;
  return normalizeCampaignId(input.activeCampaignId);
}

// ── Per-tool resolver functions ───────────────────────────────────────────────

/**
 * Required fields for the create_campaign MCP tool.
 * Exported so CampaignAgent can validate completeness before dispatch.
 */
export const CREATE_CAMPAIGN_REQUIRED_FIELDS = [
  "name",
  "subject",
  "body",
] as const;

export type CreateCampaignField = (typeof CREATE_CAMPAIGN_REQUIRED_FIELDS)[number];

function resolveCreateCampaign(input: ResolverInput): Record<string, unknown> {
  // create_campaign requires name, subject, fromName, fromEmail, body.
  //
  // Two Gemini output patterns are supported (checked in priority order):
  //
  //   1. filters.{field}  — Primary path.
  //      The classification prompt instructs Gemini to nest campaign-creation
  //      fields inside the `filters` bag, e.g.:
  //        arguments: { filters: { name: "…", subject: "…", … } }
  //
  //   2. extractedArgs.{field}  — Fallback path.
  //      Some Gemini responses (or future model versions) may return the fields
  //      at the top level of `arguments` rather than inside `filters`, e.g.:
  //        arguments: { name: "…", subject: "…", … }
  //      LLMIntentArgumentsSchema explicitly declares these fields so .strip()
  //      does not discard them before this resolver runs.
  //
  // CampaignAgent calls hasAllCreateCampaignFields() after this resolver and
  // returns a clarification prompt if any required field is still absent.
  const ext = input.extractedArgs;
  const args: Record<string, unknown> = {};

  for (const field of CREATE_CAMPAIGN_REQUIRED_FIELDS) {
    // Path 1: filters bag
    const fromFilters = ext?.filters?.[field];
    if (typeof fromFilters === "string" && fromFilters.length > 0) {
      args[field] = fromFilters;
      continue;
    }
    // Path 2: top-level extractedArgs field
    const fromTopLevel = ext?.[field as keyof typeof ext];
    if (typeof fromTopLevel === "string" && fromTopLevel.length > 0) {
      args[field] = fromTopLevel;
    }
  }

  return args;
}

function resolveUpdateCampaign(input: ResolverInput): Record<string, unknown> {
  const campaignId = resolveCampaignId(input);
  // update_campaign requires campaignId; optional fields (name, subject, etc.)
  // are not safely extractable from a generic query without more context.
  return campaignId !== undefined ? { campaignId } : {};
}

function resolveCampaignAction(input: ResolverInput): Record<string, unknown> {
  // start_campaign, pause_campaign, resume_campaign all take { campaignId }.
  const campaignId = resolveCampaignId(input);
  return campaignId !== undefined ? { campaignId } : {};
}

function resolveGetCampaignStats(
  input: ResolverInput,
): Record<string, unknown> {
  const campaignId = resolveCampaignId(input);
  return campaignId !== undefined ? { campaignId } : {};
}

function resolveRecipientLookup(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const campaignId = resolveCampaignId(input);
  if (campaignId !== undefined) args.campaignId = campaignId;
  if (typeof input.extractedArgs?.recipientId === "string" && input.extractedArgs.recipientId.trim().length > 0) {
    args.recipientId = input.extractedArgs.recipientId.trim();
  }
  if (typeof input.extractedArgs?.recipientEmail === "string" && input.extractedArgs.recipientEmail.trim().length > 0) {
    args.recipientEmail = input.extractedArgs.recipientEmail.trim().toLowerCase();
  }
  return args;
}

function resolveListReplies(input: ResolverInput): Record<string, unknown> {
  const { extractedArgs } = input;
  const args: Record<string, unknown> = {};

  const campaignId = resolveCampaignId(input);
  if (campaignId !== undefined) args.campaignId = campaignId;

  // limit: must be a positive integer
  if (
    typeof extractedArgs?.limit === "number" &&
    Number.isInteger(extractedArgs.limit) &&
    extractedArgs.limit > 0
  ) {
    args.limit = extractedArgs.limit;
  }

  // Safe filters (identity keys already stripped)
  const safeFilters = sanitizeFilters(extractedArgs?.filters);
  Object.assign(args, safeFilters);

  return args;
}

function resolveSummarizeReplies(
  input: ResolverInput,
): Record<string, unknown> {
  const { extractedArgs } = input;
  const args: Record<string, unknown> = {};

  const campaignId = resolveCampaignId(input);
  if (campaignId !== undefined) args.campaignId = campaignId;

  // query: free-text search/filter term for the summarization
  if (typeof extractedArgs?.query === "string" && extractedArgs.query.length > 0) {
    args.query = extractedArgs.query;
  }

  const safeFilters = sanitizeFilters(extractedArgs?.filters);
  Object.assign(args, safeFilters);

  return args;
}

function resolveReplyLeadList(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const campaignId = resolveCampaignId(input);
  if (campaignId !== undefined) args.campaignId = campaignId;
  const limit = input.extractedArgs?.limit;
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) args.limit = limit;
  return args;
}

function resolveReplyIdAction(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const replyId = input.extractedArgs?.replyId ?? input.extractedArgs?.filters?.replyId;
  if (typeof replyId === "string" && replyId.trim()) args.replyId = replyId.trim();
  if (typeof replyId === "number" && Number.isFinite(replyId)) args.replyId = String(replyId);
  const reason = input.extractedArgs?.query ?? input.extractedArgs?.filters?.reason;
  if (typeof reason === "string" && reason.trim()) args.reason = reason.trim();
  return args;
}

function resolveAutonomousRecommendation(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const recipientId = input.extractedArgs?.recipientId ?? input.extractedArgs?.filters?.recipientId;
  if (typeof recipientId === "string" && recipientId.trim()) args.recipientId = recipientId.trim();
  if (typeof recipientId === "number" && Number.isFinite(recipientId)) args.recipientId = String(recipientId);
  return args;
}

function inferScenario(query?: string): string | undefined {
  const text = String(query ?? "").toLowerCase();
  if (text.includes("pricing")) return "pricing_objection";
  if (text.includes("competitor") || text.includes("provider")) return "competitor_objection";
  if (text.includes("timing")) return "timing_objection";
  if (text.includes("meeting")) return "meeting_interest";
  if (text.includes("unsubscribe")) return "unsubscribe";
  if (text.includes("spam")) return "spam_complaint";
  if (text.includes("positive")) return "positive_interest";
  return undefined;
}

function resolveSequenceAdaptationPreview(input: ResolverInput): Record<string, unknown> {
  const args = resolveAutonomousRecommendation(input);
  const campaignId = resolveCampaignId(input);
  if (campaignId !== undefined) args.campaignId = campaignId;
  const replyText = input.extractedArgs?.replyText ?? input.extractedArgs?.filters?.replyText;
  if (typeof replyText === "string" && replyText.trim()) args.replyText = replyText.trim();
  const scenario = input.extractedArgs?.scenario ?? input.extractedArgs?.filters?.scenario ?? inferScenario(input.extractedArgs?.query);
  if (typeof scenario === "string" && scenario.trim()) args.scenario = scenario.trim();
  return args;
}

function resolveGetAllCampaigns(_input: ResolverInput): Record<string, unknown> {
  // get_all_campaigns accepts no arguments.
  return {};
}

function resolveGetSmtpSettings(_input: ResolverInput): Record<string, unknown> {
  // get_smtp_settings accepts no arguments.
  return {};
}

function resolveUpdateSmtpSettings(
  input: ResolverInput,
): Record<string, unknown> {
  // SMTP fields (host, port, secure, username, password) are precise values
  // that cannot be reliably inferred from free text.
  // If a caller has structured filter data it flows through here after
  // stripping any forbidden keys (password is blocked by the forbidden list).
  return sanitizeFilters(input.extractedArgs?.filters);
}

// ── Phase 1 AI campaign tool resolvers ───────────────────────────────────────

function resolveRecipientCount(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const id = resolveCampaignId(input);
  if (id !== undefined) args.campaignId = id;
  return args;
}

function resolveSaveAiPrompt(input: ResolverInput): Record<string, unknown> {
  // campaignId is required; templateType, toneInstruction, customPrompt are
  // optional and come from wizard state set directly by CampaignAgent, not here.
  const args: Record<string, unknown> = {};
  const id = resolveCampaignId(input);
  if (id !== undefined) args.campaignId = id;
  return args;
}

function resolveGeneratePersonalizedEmails(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const id = resolveCampaignId(input);
  if (id !== undefined) args.campaignId = id;
  const mode = input.extractedArgs?.mode;
  if (
    mode === "default" ||
    mode === "low_promotional_plaintext" ||
    mode === "executive_direct" ||
    mode === "friendly_human" ||
    mode === "value_first"
  ) {
    args.mode = mode;
  }
  return args;
}

function resolveGetPersonalizedEmails(input: ResolverInput): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const id = resolveCampaignId(input);
  if (id !== undefined) args.campaignId = id;
  const limit = input.extractedArgs?.limit;
  if (typeof limit === "number" && limit > 0) args.limit = limit;
  return args;
}

// ── Main resolver ─────────────────────────────────────────────────────────────

type ResolverFn = (input: ResolverInput) => Record<string, unknown>;

// Enrichment tool resolvers — args are built directly by EnrichmentAgent, not here.
// These return {} so the planner path (if ever reached) doesn't crash.
function resolveEnrichmentPassThrough(_input: ResolverInput): Record<string, unknown> {
  return {};
}

const RESOLVERS: Record<KnownToolName, ResolverFn> = {
  get_all_campaigns:            resolveGetAllCampaigns,
  create_campaign:              resolveCreateCampaign,
  update_campaign:              resolveUpdateCampaign,
  start_campaign:               resolveCampaignAction,
  pause_campaign:               resolveCampaignAction,
  resume_campaign:              resolveCampaignAction,
  get_campaign_stats:           resolveGetCampaignStats,
  get_sequence_progress:        resolveGetCampaignStats,
  get_pending_follow_ups:       resolveGetCampaignStats,
  get_recipient_touch_history:  resolveRecipientLookup,
  mark_recipient_replied:       resolveRecipientLookup,
  mark_recipient_bounced:       resolveRecipientLookup,
  list_replies:                 resolveListReplies,
  summarize_replies:            resolveSummarizeReplies,
  get_reply_intelligence_summary: resolveGetCampaignStats,
  show_hot_leads:               resolveReplyLeadList,
  show_meeting_ready_leads:     resolveReplyLeadList,
  draft_reply_suggestion:       resolveReplyIdAction,
  mark_reply_human_review:      resolveReplyIdAction,
  get_autonomous_recommendation: resolveAutonomousRecommendation,
  get_campaign_autonomous_summary: resolveGetCampaignStats,
  preview_sequence_adaptation:  resolveSequenceAdaptationPreview,
  get_smtp_settings:            resolveGetSmtpSettings,
  update_smtp_settings:         resolveUpdateSmtpSettings,
  get_recipient_count:          resolveRecipientCount,
  save_ai_prompt:               resolveSaveAiPrompt,
  generate_personalized_emails: resolveGeneratePersonalizedEmails,
  get_personalized_emails:      resolveGetPersonalizedEmails,
  parse_csv_file:               resolveEnrichmentPassThrough,
  save_csv_recipients:          resolveEnrichmentPassThrough,
  validate_email:               resolveEnrichmentPassThrough,
  extract_domain:               resolveEnrichmentPassThrough,
  fetch_website_content:        resolveEnrichmentPassThrough,
  enrich_domain:                resolveEnrichmentPassThrough,
  search_company:               resolveEnrichmentPassThrough,
  classify_industry:            resolveEnrichmentPassThrough,
  score_lead:                   resolveEnrichmentPassThrough,
  generate_outreach_template:   resolveEnrichmentPassThrough,
  save_enriched_contacts:       resolveEnrichmentPassThrough,
  search_company_web:           resolveEnrichmentPassThrough,
  select_official_website:      resolveEnrichmentPassThrough,
  verify_company_website:       resolveEnrichmentPassThrough,
  // Phase 3 — args built by EnrichmentAgent
  extract_company_profile:      resolveEnrichmentPassThrough,
  detect_pain_points:           resolveEnrichmentPassThrough,
  generate_outreach_draft:      resolveEnrichmentPassThrough,
};

/**
 * Resolve the final toolArgs for the given MCP tool.
 *
 * This is the single entry point all domain agents must use.  It merges
 * LLM-extracted arguments with session context and applies per-tool security
 * and validation rules.
 *
 * The returned object is ready to pass unchanged to mcpClientService.dispatch().
 *
 * @param toolName - The MCP tool that will be invoked
 * @param input    - Extracted args and session context from graph state
 */
export function resolveToolArgs(
  toolName: KnownToolName,
  input: ResolverInput,
): Record<string, unknown> {
  const resolver = RESOLVERS[toolName];
  if (!resolver) {
    log.warn({ toolName }, "resolveToolArgs: no resolver registered for tool — returning {}");
    return {};
  }
  return resolver(input);
}
