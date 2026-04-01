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

import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";
import type { KnownToolName } from "../types/tools.js";

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

// ── Campaign ID resolution ────────────────────────────────────────────────────

/**
 * Resolves the best available campaignId from two sources:
 *   1. extractedArgs.campaignId (LLM identified a specific campaign)
 *   2. activeCampaignId (session-level fallback from a prior turn)
 *
 * Returns `undefined` when neither source provides a value.  The caller
 * decides whether to include the field at all — tools that require it will
 * receive a validation error from the MCP server.
 */
function resolveCampaignId(input: ResolverInput): string | undefined {
  const fromLLM = input.extractedArgs?.campaignId;
  if (typeof fromLLM === "string" && fromLLM.length > 0) {
    return fromLLM;
  }
  const fromSession = input.activeCampaignId;
  if (typeof fromSession === "string" && fromSession.length > 0) {
    return fromSession;
  }
  return undefined;
}

// ── Per-tool resolver functions ───────────────────────────────────────────────

/**
 * Required fields for the create_campaign MCP tool.
 * Exported so CampaignAgent can validate completeness before dispatch.
 */
export const CREATE_CAMPAIGN_REQUIRED_FIELDS = [
  "name",
  "subject",
  "fromName",
  "fromEmail",
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

// ── Main resolver ─────────────────────────────────────────────────────────────

type ResolverFn = (input: ResolverInput) => Record<string, unknown>;

const RESOLVERS: Record<KnownToolName, ResolverFn> = {
  create_campaign:      resolveCreateCampaign,
  update_campaign:      resolveUpdateCampaign,
  start_campaign:       resolveCampaignAction,
  pause_campaign:       resolveCampaignAction,
  resume_campaign:      resolveCampaignAction,
  get_campaign_stats:   resolveGetCampaignStats,
  list_replies:         resolveListReplies,
  summarize_replies:    resolveSummarizeReplies,
  get_smtp_settings:    resolveGetSmtpSettings,
  update_smtp_settings: resolveUpdateSmtpSettings,
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
  return RESOLVERS[toolName](input);
}
