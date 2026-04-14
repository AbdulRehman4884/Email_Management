/**
 * src/config/intents.ts
 *
 * Intent taxonomy and keyword rule configuration for deterministic detection.
 *
 * Design rules:
 *  - Intent is a compile-safe union — adding a new intent requires updating
 *    ALL_INTENTS and adding a rule to INTENT_RULES (enforced at startup).
 *  - Rules are data, not logic — all matching logic lives in intentDetection.service.ts.
 *  - Patterns are lowercase substrings matched against normalised input.
 *  - Weight scale: 0.1 (weak/shared signal) → 0.5 (strong/specific signal).
 *    Multi-word phrases carry more weight than single-word tokens.
 */

// ── Intent union ──────────────────────────────────────────────────────────────

export type Intent =
  | "create_campaign"
  | "update_campaign"
  | "start_campaign"
  | "pause_campaign"
  | "resume_campaign"
  | "get_campaign_stats"
  | "list_replies"
  | "summarize_replies"
  | "check_smtp"
  | "update_smtp"
  | "general_help";

/** Ordered tuple of every valid intent — used for exhaustiveness checks. */
export const ALL_INTENTS: readonly Intent[] = [
  "create_campaign",
  "update_campaign",
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "get_campaign_stats",
  "list_replies",
  "summarize_replies",
  "check_smtp",
  "update_smtp",
  "general_help",
] as const;

/** Intent domain groupings used by the Manager Agent for routing. */
export const INTENT_DOMAIN: Record<Intent, "campaign" | "analytics" | "inbox" | "settings" | "general"> = {
  create_campaign:    "campaign",
  update_campaign:    "campaign",
  start_campaign:     "campaign",
  pause_campaign:     "campaign",
  resume_campaign:    "campaign",
  get_campaign_stats: "analytics",
  list_replies:       "inbox",
  summarize_replies:  "inbox",
  check_smtp:         "settings",
  update_smtp:        "settings",
  general_help:       "general",
};

// ── Pattern types ─────────────────────────────────────────────────────────────

/**
 * A single detection signal.
 *
 * `pattern` is matched as a case-insensitive substring of the normalised input.
 * Multi-word patterns (e.g. "new campaign") naturally require both tokens to
 * appear adjacent, making them stronger signals than individual words.
 *
 * `weight` contributes to the intent's raw score:
 *   confidence = rawScore / maxPossibleScore
 */
export interface IntentPattern {
  readonly pattern: string;
  readonly weight: number;
}

export interface IntentRule {
  readonly intent: Intent;
  readonly patterns: readonly IntentPattern[];
}

// ── Keyword rules ─────────────────────────────────────────────────────────────

/**
 * One rule per intent — keyed by Intent for compile-safe completeness.
 * The Record type ensures every Intent has an entry.
 */
export const INTENT_RULES: Record<Intent, IntentRule> = {
  // ── Campaign ────────────────────────────────────────────────────────────────

  create_campaign: {
    intent: "create_campaign",
    patterns: [
      { pattern: "create campaign",   weight: 0.5 },
      { pattern: "new campaign",      weight: 0.5 },
      { pattern: "build campaign",    weight: 0.5 },
      { pattern: "draft campaign",    weight: 0.4 },
      { pattern: "set up campaign",   weight: 0.4 },
      { pattern: "make campaign",     weight: 0.4 },
      { pattern: "create",            weight: 0.3 },
      { pattern: "build",             weight: 0.4 },
      { pattern: "campaign",          weight: 0.2 },
    ],
  },

  update_campaign: {
    intent: "update_campaign",
    patterns: [
      { pattern: "update campaign",        weight: 0.5 },
      { pattern: "edit campaign",          weight: 0.5 },
      { pattern: "change campaign",        weight: 0.5 },
      { pattern: "modify campaign",        weight: 0.5 },
      { pattern: "rename campaign",        weight: 0.4 },
      // Handles: "update an existing campaign", "edit an existing campaign", etc.
      { pattern: "update an existing",     weight: 0.4 },
      { pattern: "edit an existing",       weight: 0.4 },
      { pattern: "modify an existing",     weight: 0.4 },
      // "existing campaign" is a strong signal — only update makes sense on an existing one
      { pattern: "existing campaign",      weight: 0.3 },
      { pattern: "update",                 weight: 0.2 },
      { pattern: "edit",                   weight: 0.2 },
      { pattern: "change",                 weight: 0.2 },
      { pattern: "modify",                 weight: 0.2 },
      { pattern: "campaign",               weight: 0.2 },
    ],
  },

  start_campaign: {
    intent: "start_campaign",
    patterns: [
      { pattern: "start campaign",    weight: 0.5 },
      { pattern: "launch campaign",   weight: 0.5 },
      { pattern: "send campaign",     weight: 0.5 },
      { pattern: "activate campaign", weight: 0.5 },
      { pattern: "run campaign",      weight: 0.4 },
      { pattern: "begin campaign",    weight: 0.4 },
      { pattern: "start",             weight: 0.3 },
      { pattern: "launch",            weight: 0.3 },
      { pattern: "send",              weight: 0.2 },
      { pattern: "campaign",          weight: 0.2 },
    ],
  },

  pause_campaign: {
    intent: "pause_campaign",
    patterns: [
      { pattern: "pause campaign",    weight: 0.5 },
      { pattern: "stop campaign",     weight: 0.5 },
      { pattern: "halt campaign",     weight: 0.5 },
      { pattern: "freeze campaign",   weight: 0.4 },
      { pattern: "suspend campaign",  weight: 0.4 },
      { pattern: "pause",             weight: 0.4 },
      { pattern: "halt",              weight: 0.3 },
      { pattern: "stop",              weight: 0.3 },
      { pattern: "campaign",          weight: 0.2 },
    ],
  },

  resume_campaign: {
    intent: "resume_campaign",
    patterns: [
      { pattern: "resume campaign",   weight: 0.5 },
      { pattern: "restart campaign",  weight: 0.5 },
      { pattern: "unpause campaign",  weight: 0.5 },
      { pattern: "continue campaign", weight: 0.5 },
      { pattern: "reactivate campaign", weight: 0.4 },
      { pattern: "resume",            weight: 0.5 },
      { pattern: "unpause",           weight: 0.5 },
      { pattern: "restart",           weight: 0.3 },
      { pattern: "campaign",          weight: 0.2 },
    ],
  },

  // ── Analytics ───────────────────────────────────────────────────────────────

  get_campaign_stats: {
    intent: "get_campaign_stats",
    patterns: [
      { pattern: "campaign stats",        weight: 0.5 },
      { pattern: "campaign analytics",    weight: 0.5 },
      { pattern: "campaign performance",  weight: 0.5 },
      { pattern: "campaign metrics",      weight: 0.5 },
      { pattern: "campaign report",       weight: 0.4 },
      { pattern: "open rate",             weight: 0.5 },
      { pattern: "click rate",            weight: 0.5 },
      { pattern: "bounce rate",           weight: 0.5 },
      { pattern: "how is my campaign",    weight: 0.4 },
      { pattern: "stats",                 weight: 0.3 },
      { pattern: "analytics",             weight: 0.3 },
      { pattern: "metrics",               weight: 0.2 },
      { pattern: "performance",           weight: 0.2 },
      { pattern: "campaign",              weight: 0.2 },
    ],
  },

  // ── Inbox ────────────────────────────────────────────────────────────────────

  list_replies: {
    intent: "list_replies",
    patterns: [
      { pattern: "list replies",          weight: 0.5 },
      { pattern: "show replies",          weight: 0.5 },
      { pattern: "view replies",          weight: 0.5 },
      { pattern: "get replies",           weight: 0.4 },
      { pattern: "fetch replies",         weight: 0.4 },
      { pattern: "see replies",           weight: 0.4 },
      { pattern: "list responses",        weight: 0.4 },
      { pattern: "show responses",        weight: 0.4 },
      { pattern: "replies",               weight: 0.4 },
      { pattern: "responses",             weight: 0.3 },
      { pattern: "inbox",                 weight: 0.2 },
    ],
  },

  summarize_replies: {
    intent: "summarize_replies",
    patterns: [
      { pattern: "summarize replies",     weight: 0.5 },
      { pattern: "summary of replies",    weight: 0.5 },
      { pattern: "analyse replies",       weight: 0.5 },
      { pattern: "analyze replies",       weight: 0.5 },
      { pattern: "summarize responses",   weight: 0.5 },
      { pattern: "reply summary",         weight: 0.5 },
      { pattern: "response summary",      weight: 0.4 },
      { pattern: "summarise replies",     weight: 0.5 }, // British English
      { pattern: "digest replies",        weight: 0.4 },
      { pattern: "summarize",             weight: 0.3 },
      { pattern: "summarise",             weight: 0.3 },
      { pattern: "summary",               weight: 0.3 },
      { pattern: "replies",               weight: 0.2 },
    ],
  },

  // ── Settings ─────────────────────────────────────────────────────────────────

  check_smtp: {
    intent: "check_smtp",
    patterns: [
      { pattern: "check smtp",            weight: 0.5 },
      { pattern: "show smtp",             weight: 0.5 },
      { pattern: "view smtp",             weight: 0.5 },
      { pattern: "get smtp",              weight: 0.4 },
      { pattern: "smtp settings",         weight: 0.5 },
      { pattern: "email server settings", weight: 0.4 },
      { pattern: "mail settings",         weight: 0.3 },
      { pattern: "smtp",                  weight: 0.4 },
    ],
  },

  update_smtp: {
    intent: "update_smtp",
    patterns: [
      { pattern: "update smtp",           weight: 0.7 },
      { pattern: "change smtp",           weight: 0.5 },
      { pattern: "configure smtp",        weight: 0.5 },
      { pattern: "set smtp",              weight: 0.5 },
      { pattern: "edit smtp",             weight: 0.5 },
      { pattern: "modify smtp",           weight: 0.5 },
      { pattern: "update email server",   weight: 0.4 },
      { pattern: "change email server",   weight: 0.4 },
      { pattern: "update",                weight: 0.3 },
      { pattern: "smtp",                  weight: 0.3 },
    ],
  },

  // ── General ──────────────────────────────────────────────────────────────────

  general_help: {
    intent: "general_help",
    patterns: [
      { pattern: "help",                  weight: 0.5 },
      { pattern: "what can you do",       weight: 0.5 },
      { pattern: "what can you",          weight: 0.4 },
      { pattern: "how do i",              weight: 0.4 },
      { pattern: "what do you",           weight: 0.4 },
      { pattern: "capabilities",          weight: 0.4 },
      { pattern: "getting started",       weight: 0.4 },
      { pattern: "how does this work",    weight: 0.4 },
      { pattern: "guide",                 weight: 0.3 },
      { pattern: "tutorial",              weight: 0.3 },
    ],
  },
};

// ── Confidence thresholds ─────────────────────────────────────────────────────

/**
 * Minimum normalised confidence to accept an intent as detected.
 * Below this value the service falls back to general_help.
 */
export const INTENT_CONFIDENCE_THRESHOLD = 0.06;

/**
 * Confidence score assigned to the general_help fallback when no intent
 * exceeds the threshold.
 */
export const FALLBACK_CONFIDENCE = 0.1;
