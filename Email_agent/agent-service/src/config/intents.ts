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
  | "list_campaigns"
  | "create_campaign"
  | "update_campaign"
  | "schedule_campaign"
  | "start_campaign"
  | "pause_campaign"
  | "resume_campaign"
  | "get_campaign_stats"
  | "show_sequence_progress"
  | "show_pending_follow_ups"
  | "show_recipient_touch_history"
  | "mark_recipient_replied"
  | "mark_recipient_bounced"
  | "list_replies"
  | "summarize_replies"
  | "show_hot_leads"
  | "show_meeting_ready_leads"
  | "summarize_objections"
  | "draft_reply_to_latest_lead"
  | "mark_reply_human_review"
  | "show_autonomous_recommendations"
  | "explain_lead_priority"
  | "preview_sequence_adaptation"
  | "show_next_best_action"
  | "show_escalation_queue"
  | "check_smtp"
  | "update_smtp"
  | "general_help"
  | "out_of_domain"
  | "create_ai_campaign"
  | "generate_personalized_emails"
  | "review_personalized_emails"
  | "template_help"
  | "upload_recipients_help"
  | "next_step_help"
  | "ai_campaign_help"
  | "recipient_status_help"
  | "upload_csv"
  | "enrich_contacts"
  | "confirm_enrichment"
  | "customize_outreach"
  | "discard_enrichment"
  | "enrichment_help"
  | "regenerate_personalized_emails"
  | "validate_email"
  | "enrich_contact"
  | "fetch_company_website"
  | "extract_domain"
  | "search_company_web"
  | "select_official_website"
  | "verify_company_website"
  // Phase 3: AI Company Intelligence
  | "analyze_company"
  | "detect_pain_points"
  | "generate_outreach"
  | "enrich_company"
  | "resume_workflow";

/** Ordered tuple of every valid intent — used for exhaustiveness checks. */
export const ALL_INTENTS: readonly Intent[] = [
  "list_campaigns",
  "create_campaign",
  "update_campaign",
  "schedule_campaign",
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "get_campaign_stats",
  "show_sequence_progress",
  "show_pending_follow_ups",
  "show_recipient_touch_history",
  "mark_recipient_replied",
  "mark_recipient_bounced",
  "list_replies",
  "summarize_replies",
  "show_hot_leads",
  "show_meeting_ready_leads",
  "summarize_objections",
  "draft_reply_to_latest_lead",
  "mark_reply_human_review",
  "show_autonomous_recommendations",
  "explain_lead_priority",
  "preview_sequence_adaptation",
  "show_next_best_action",
  "show_escalation_queue",
  "check_smtp",
  "update_smtp",
  "general_help",
  "out_of_domain",
  "create_ai_campaign",
  "generate_personalized_emails",
  "review_personalized_emails",
  "template_help",
  "upload_recipients_help",
  "next_step_help",
  "ai_campaign_help",
  "recipient_status_help",
  "upload_csv",
  "enrich_contacts",
  "confirm_enrichment",
  "customize_outreach",
  "discard_enrichment",
  "enrichment_help",
  "regenerate_personalized_emails",
  "validate_email",
  "enrich_contact",
  "fetch_company_website",
  "extract_domain",
  "search_company_web",
  "select_official_website",
  "verify_company_website",
  "analyze_company",
  "detect_pain_points",
  "generate_outreach",
  "enrich_company",
  "resume_workflow",
] as const;

/** Intent domain groupings used by the Manager Agent for routing. */
export const INTENT_DOMAIN: Record<Intent, "campaign" | "analytics" | "inbox" | "settings" | "general" | "enrichment"> = {
  list_campaigns:             "campaign",
  create_campaign:            "campaign",
  update_campaign:            "campaign",
  schedule_campaign:          "campaign",
  start_campaign:             "campaign",
  pause_campaign:             "campaign",
  resume_campaign:            "campaign",
  get_campaign_stats:         "analytics",
  show_sequence_progress:     "campaign",
  show_pending_follow_ups:    "campaign",
  show_recipient_touch_history:"campaign",
  mark_recipient_replied:     "campaign",
  mark_recipient_bounced:     "campaign",
  list_replies:               "inbox",
  summarize_replies:          "inbox",
  show_hot_leads:             "inbox",
  show_meeting_ready_leads:   "inbox",
  summarize_objections:       "inbox",
  draft_reply_to_latest_lead: "inbox",
  mark_reply_human_review:    "inbox",
  show_autonomous_recommendations: "inbox",
  explain_lead_priority:      "inbox",
  preview_sequence_adaptation: "inbox",
  show_next_best_action:      "inbox",
  show_escalation_queue:      "inbox",
  check_smtp:                 "settings",
  update_smtp:                "settings",
  general_help:               "general",
  out_of_domain:              "general",
  create_ai_campaign:         "campaign",
  generate_personalized_emails: "campaign",
  review_personalized_emails: "campaign",
  template_help:              "general",
  upload_recipients_help:     "general",
  next_step_help:             "general",
  ai_campaign_help:           "general",
  recipient_status_help:      "general",
  upload_csv:                 "enrichment",
  enrich_contacts:            "enrichment",
  confirm_enrichment:         "enrichment",
  customize_outreach:         "enrichment",
  discard_enrichment:         "enrichment",
  enrichment_help:                  "general",
  regenerate_personalized_emails:   "campaign",
  validate_email:                   "enrichment",
  enrich_contact:                   "enrichment",
  fetch_company_website:            "enrichment",
  extract_domain:                   "enrichment",
  search_company_web:               "enrichment",
  select_official_website:          "enrichment",
  verify_company_website:           "enrichment",
  // Phase 3
  analyze_company:                  "enrichment",
  detect_pain_points:               "enrichment",
  generate_outreach:                "enrichment",
  enrich_company:                   "enrichment",
  resume_workflow:                  "general",
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

  list_campaigns: {
    intent: "list_campaigns",
    patterns: [
      { pattern: "list campaigns",        weight: 0.5 },
      { pattern: "show campaigns",        weight: 0.5 },
      { pattern: "view all campaigns",    weight: 0.5 },
      { pattern: "my campaigns",          weight: 0.4 },
      { pattern: "all campaigns",         weight: 0.4 },
      { pattern: "show all campaigns",    weight: 0.5 },
      { pattern: "get all campaigns",     weight: 0.5 },
      { pattern: "list my campaigns",     weight: 0.5 },
    ],
  },

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

  schedule_campaign: {
    intent: "schedule_campaign",
    patterns: [
      { pattern: "schedule campaign",          weight: 0.5 },
      { pattern: "schedule this campaign",     weight: 0.6 },
      { pattern: "schedule for",               weight: 0.4 },
      { pattern: "schedule at",               weight: 0.4 },
      { pattern: "set schedule",              weight: 0.5 },
      { pattern: "schedule send",             weight: 0.5 },
      { pattern: "send at",                   weight: 0.3 },
      { pattern: "send tomorrow",             weight: 0.4 },
      { pattern: "send next",                 weight: 0.3 },
      { pattern: "schedule tomorrow",         weight: 0.5 },
      { pattern: "schedule next",             weight: 0.4 },
      { pattern: "plan campaign",             weight: 0.3 },
      { pattern: "schedule",                  weight: 0.2 },
      { pattern: "campaign",                  weight: 0.1 },
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
      { pattern: "start campaign",         weight: 0.5 },
      { pattern: "launch campaign",        weight: 0.5 },
      { pattern: "send campaign",          weight: 0.5 },
      { pattern: "activate campaign",      weight: 0.5 },
      { pattern: "run campaign",           weight: 0.4 },
      { pattern: "begin campaign",         weight: 0.4 },
      { pattern: "dispatch campaign",      weight: 0.5 },
      { pattern: "deliver campaign",       weight: 0.5 },
      { pattern: "send to all",            weight: 0.4 },
      { pattern: "send to recipients",     weight: 0.4 },
      { pattern: "send this campaign",     weight: 0.5 },
      { pattern: "send this email",        weight: 0.4 },
      { pattern: "start sending",          weight: 0.5 },
      { pattern: "campaign delivery",      weight: 0.4 },
      { pattern: "send email campaign",    weight: 0.5 },
      { pattern: "start",                  weight: 0.3 },
      { pattern: "launch",                 weight: 0.3 },
      { pattern: "send",                   weight: 0.2 },
      { pattern: "campaign",               weight: 0.2 },
    ],
  },

  pause_campaign: {
    intent: "pause_campaign",
    patterns: [
      { pattern: "pause campaign",    weight: 0.5 },
      { pattern: "pause sequence",    weight: 0.7 },
      { pattern: "pause follow-up sequence", weight: 0.8 },
      { pattern: "stop campaign",     weight: 0.5 },
      { pattern: "stop sequence",     weight: 0.7 },
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
      { pattern: "resume sequence",   weight: 0.7 },
      { pattern: "resume follow-up sequence", weight: 0.8 },
      { pattern: "restart campaign",  weight: 0.5 },
      { pattern: "unpause campaign",  weight: 0.5 },
      { pattern: "continue sequence", weight: 0.7 },
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

  show_sequence_progress: {
    intent: "show_sequence_progress",
    patterns: [
      { pattern: "sequence progress",     weight: 0.9 },
      { pattern: "show sequence progress", weight: 0.9 },
      { pattern: "follow-up progress",    weight: 0.8 },
      { pattern: "sequence status",       weight: 0.7 },
      { pattern: "how is the sequence",   weight: 0.7 },
      { pattern: "show progress",         weight: 0.5 },
    ],
  },

  show_pending_follow_ups: {
    intent: "show_pending_follow_ups",
    patterns: [
      { pattern: "pending follow-ups",    weight: 0.9 },
      { pattern: "pending followups",     weight: 0.9 },
      { pattern: "show pending follow-ups", weight: 0.9 },
      { pattern: "due follow-ups",        weight: 0.8 },
      { pattern: "scheduled follow-ups",  weight: 0.8 },
    ],
  },

  show_recipient_touch_history: {
    intent: "show_recipient_touch_history",
    patterns: [
      { pattern: "touch history",         weight: 0.9 },
      { pattern: "recipient touch history", weight: 0.9 },
      { pattern: "sequence history",      weight: 0.8 },
      { pattern: "touch timeline",        weight: 0.8 },
    ],
  },

  mark_recipient_replied: {
    intent: "mark_recipient_replied",
    patterns: [
      { pattern: "mark replied",          weight: 0.9 },
      { pattern: "mark as replied",       weight: 0.9 },
      { pattern: "recipient replied",     weight: 0.8 },
      { pattern: "lead replied",          weight: 0.8 },
    ],
  },

  mark_recipient_bounced: {
    intent: "mark_recipient_bounced",
    patterns: [
      { pattern: "mark bounced",          weight: 0.9 },
      { pattern: "mark as bounced",       weight: 0.9 },
      { pattern: "recipient bounced",     weight: 0.8 },
      { pattern: "lead bounced",          weight: 0.8 },
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

  show_hot_leads: {
    intent: "show_hot_leads",
    patterns: [
      { pattern: "show hot leads", weight: 0.9 },
      { pattern: "hot leads", weight: 0.8 },
      { pattern: "hottest leads", weight: 0.8 },
      { pattern: "reply hot leads", weight: 0.7 },
    ],
  },

  show_meeting_ready_leads: {
    intent: "show_meeting_ready_leads",
    patterns: [
      { pattern: "show meeting-ready leads", weight: 0.9 },
      { pattern: "meeting-ready leads", weight: 0.9 },
      { pattern: "meeting ready leads", weight: 0.9 },
      { pattern: "ready for meeting", weight: 0.7 },
      { pattern: "booked meeting signals", weight: 0.7 },
    ],
  },

  summarize_objections: {
    intent: "summarize_objections",
    patterns: [
      { pattern: "summarize objections", weight: 0.9 },
      { pattern: "objection summary", weight: 0.8 },
      { pattern: "objection breakdown", weight: 0.8 },
      { pattern: "show objections", weight: 0.7 },
      { pattern: "reply intelligence summary", weight: 0.8 },
    ],
  },

  draft_reply_to_latest_lead: {
    intent: "draft_reply_to_latest_lead",
    patterns: [
      { pattern: "draft reply to latest lead", weight: 0.9 },
      { pattern: "draft reply", weight: 0.8 },
      { pattern: "suggest reply", weight: 0.8 },
      { pattern: "regenerate softer response", weight: 0.8 },
      { pattern: "softer response", weight: 0.7 },
    ],
  },

  mark_reply_human_review: {
    intent: "mark_reply_human_review",
    patterns: [
      { pattern: "mark for human review", weight: 0.9 },
      { pattern: "human review", weight: 0.7 },
      { pattern: "review this reply", weight: 0.7 },
    ],
  },

  show_autonomous_recommendations: {
    intent: "show_autonomous_recommendations",
    patterns: [
      { pattern: "show autonomous recommendations", weight: 0.9 },
      { pattern: "autonomous recommendations", weight: 0.9 },
      { pattern: "autonomous sdr recommendations", weight: 0.9 },
      { pattern: "campaign autonomous summary", weight: 0.8 },
    ],
  },

  explain_lead_priority: {
    intent: "explain_lead_priority",
    patterns: [
      { pattern: "why is this lead high priority", weight: 0.9 },
      { pattern: "explain lead priority", weight: 0.9 },
      { pattern: "why was this lead prioritized", weight: 0.9 },
      { pattern: "lead priority", weight: 0.7 },
    ],
  },

  preview_sequence_adaptation: {
    intent: "preview_sequence_adaptation",
    patterns: [
      { pattern: "preview sequence adaptation", weight: 0.9 },
      { pattern: "preview adaptation", weight: 0.9 },
      { pattern: "preview adaptation for pricing objection", weight: 1.0 },
      { pattern: "adapt future touches", weight: 0.8 },
      { pattern: "regenerate future touches", weight: 0.8 },
    ],
  },

  show_next_best_action: {
    intent: "show_next_best_action",
    patterns: [
      { pattern: "show next best action", weight: 0.9 },
      { pattern: "next best action", weight: 0.9 },
      { pattern: "recommend next action", weight: 0.8 },
    ],
  },

  show_escalation_queue: {
    intent: "show_escalation_queue",
    patterns: [
      { pattern: "show escalation queue", weight: 0.9 },
      { pattern: "escalation queue", weight: 0.9 },
      { pattern: "show leads needing human review", weight: 0.8 },
      { pattern: "why was this escalated", weight: 0.8 },
    ],
  },

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

  // Out-of-domain queries are detected exclusively by the LLM (OpenAI classifyIntent).
  // No keyword patterns are defined here — a zero score in deterministic detection
  // ensures this intent is never selected as a fallback.
  out_of_domain: {
    intent: "out_of_domain",
    patterns: [],
  },

  // ── Phase 1: AI Campaign ─────────────────────────────────────────────────────

  create_ai_campaign: {
    intent: "create_ai_campaign",
    patterns: [
      { pattern: "ai campaign",             weight: 0.6 },
      { pattern: "personalized campaign",   weight: 0.6 },
      { pattern: "create ai campaign",      weight: 0.7 },
      { pattern: "campaign with csv",       weight: 0.6 },
      { pattern: "campaign with recipients",weight: 0.5 },
      { pattern: "guided campaign",         weight: 0.5 },
      { pattern: "smart campaign",          weight: 0.5 },
      { pattern: "personalize emails",      weight: 0.5 },
      { pattern: "upload csv",              weight: 0.4 },
      { pattern: "upload recipients",       weight: 0.4 },
    ],
  },

  generate_personalized_emails: {
    intent: "generate_personalized_emails",
    patterns: [
      { pattern: "generate personalized",   weight: 0.7 },
      { pattern: "generate emails",         weight: 0.5 },
      { pattern: "personalize campaign",    weight: 0.6 },
      { pattern: "ai generate",             weight: 0.5 },
      { pattern: "generate for recipients", weight: 0.6 },
      { pattern: "generate personalized emails", weight: 0.8 },
    ],
  },

  review_personalized_emails: {
    intent: "review_personalized_emails",
    patterns: [
      { pattern: "review emails",           weight: 0.8 },
      { pattern: "review email",            weight: 0.7 },
      { pattern: "review sequence",         weight: 0.9 },
      { pattern: "show sequence",           weight: 0.8 },
      { pattern: "preview sequence",        weight: 0.8 },
      { pattern: "show generated emails",   weight: 0.7 },
      { pattern: "preview emails",          weight: 0.7 },
    ],
  },

  // ── Help / guidance intents (domain = "general", no tool dispatch) ───────────

  template_help: {
    intent: "template_help",
    patterns: [
      { pattern: "i want templates",         weight: 0.8 },
      { pattern: "what templates",           weight: 0.7 },
      { pattern: "available templates",      weight: 0.7 },
      { pattern: "show templates",           weight: 0.7 },
      { pattern: "list templates",           weight: 0.6 },
      { pattern: "template options",         weight: 0.6 },
      { pattern: "which template",           weight: 0.6 },
      { pattern: "templates",               weight: 0.4 },
    ],
  },

  upload_recipients_help: {
    intent: "upload_recipients_help",
    patterns: [
      { pattern: "how do i upload recipients", weight: 0.9 },
      { pattern: "how to upload recipients",   weight: 0.8 },
      { pattern: "how do i upload csv",        weight: 0.8 },
      { pattern: "how to upload csv",          weight: 0.8 },
      { pattern: "how do i add recipients",    weight: 0.8 },
      { pattern: "upload recipients help",     weight: 0.7 },
      { pattern: "add recipients",             weight: 0.5 },
      { pattern: "upload contacts",            weight: 0.5 },
    ],
  },

  next_step_help: {
    intent: "next_step_help",
    patterns: [
      { pattern: "what should i do next",   weight: 0.9 },
      { pattern: "what do i do next",       weight: 0.9 },
      { pattern: "what do i do now",        weight: 0.8 },
      { pattern: "what now",                weight: 0.7 },
      { pattern: "what next",               weight: 0.7 },
      { pattern: "whats next",              weight: 0.7 },
      { pattern: "what's next",             weight: 0.7 },
      { pattern: "what should i do",        weight: 0.6 },
      { pattern: "next step",               weight: 0.6 },
    ],
  },

  ai_campaign_help: {
    intent: "ai_campaign_help",
    patterns: [
      { pattern: "how do i create ai campaign",  weight: 0.9 },
      { pattern: "how to create ai campaign",    weight: 0.9 },
      { pattern: "how does ai campaign work",    weight: 0.8 },
      { pattern: "help me create ai campaign",   weight: 0.8 },
      { pattern: "guide me through ai campaign", weight: 0.8 },
      { pattern: "explain ai campaign",          weight: 0.7 },
      { pattern: "what is ai campaign",          weight: 0.7 },
      { pattern: "ai campaign tutorial",         weight: 0.7 },
      { pattern: "ai campaign steps",            weight: 0.7 },
    ],
  },

  recipient_status_help: {
    intent: "recipient_status_help",
    patterns: [
      { pattern: "how many recipients",        weight: 0.8 },
      { pattern: "recipient count",            weight: 0.7 },
      { pattern: "check recipients",           weight: 0.7 },
      { pattern: "how many contacts",          weight: 0.7 },
      { pattern: "recipient status",           weight: 0.6 },
      { pattern: "are recipients uploaded",    weight: 0.8 },
      { pattern: "did recipients upload",      weight: 0.7 },
    ],
  },

  // upload_csv is triggered only via the detectIntent bypass (pendingCsvFile in
  // state), never by keyword matching — empty pattern list is intentional.
  upload_csv: {
    intent: "upload_csv",
    patterns: [],
  },

  // ── Enrichment ───────────────────────────────────────────────────────────────

  enrich_contacts: {
    intent: "enrich_contacts",
    patterns: [
      { pattern: "enrich contacts",        weight: 0.8 },
      { pattern: "enrich recipients",      weight: 0.8 },
      { pattern: "enrich my contacts",     weight: 0.8 },
      { pattern: "enrich the contacts",    weight: 0.7 },
      { pattern: "enrich this list",       weight: 0.6 },
      { pattern: "enrich these contacts",  weight: 0.7 },
      { pattern: "enrich leads",           weight: 0.7 },
      { pattern: "enrich",                 weight: 0.3 },
    ],
  },

  confirm_enrichment: {
    intent: "confirm_enrichment",
    patterns: [
      { pattern: "save enriched",          weight: 0.8 },
      { pattern: "save the enriched",      weight: 0.8 },
      { pattern: "confirm enrichment",     weight: 0.8 },
      { pattern: "yes save",               weight: 0.4 },
      { pattern: "yes enrich",             weight: 0.5 },
    ],
  },

  customize_outreach: {
    intent: "customize_outreach",
    patterns: [
      { pattern: "customize template",     weight: 0.8 },
      { pattern: "change template",        weight: 0.6 },
      { pattern: "edit template",          weight: 0.6 },
      { pattern: "modify template",        weight: 0.6 },
      { pattern: "customize outreach",     weight: 0.8 },
      { pattern: "change the subject",     weight: 0.5 },
      { pattern: "change tone",            weight: 0.5 },
    ],
  },

  discard_enrichment: {
    intent: "discard_enrichment",
    patterns: [
      { pattern: "discard enrichment",  weight: 0.9 },
      { pattern: "cancel enrichment",   weight: 0.9 },
      { pattern: "stop enrichment",     weight: 0.8 },
      { pattern: "discard",             weight: 0.5 },
    ],
  },

  enrichment_help: {
    intent: "enrichment_help",
    patterns: [
      { pattern: "how does enrichment work", weight: 0.8 },
      { pattern: "what is enrichment",       weight: 0.7 },
      { pattern: "enrichment help",          weight: 0.7 },
      { pattern: "how to enrich",            weight: 0.6 },
    ],
  },

  regenerate_personalized_emails: {
    intent: "regenerate_personalized_emails",
    patterns: [
      { pattern: "regenerate personalized emails", weight: 0.9 },
      { pattern: "regenerate emails",              weight: 0.7 },
      { pattern: "regenerate personalized",        weight: 0.8 },
      { pattern: "overwrite emails",               weight: 0.7 },
      { pattern: "overwrite personalized",         weight: 0.8 },
      { pattern: "redo emails",                    weight: 0.6 },
      { pattern: "recreate emails",                weight: 0.6 },
      { pattern: "regenerate",                     weight: 0.3 },
      { pattern: "founder tone",                   weight: 0.5 },
      { pattern: "softer cta",                     weight: 0.6 },
      { pattern: "more direct",                    weight: 0.5 },
      { pattern: "more technical",                 weight: 0.5 },
      { pattern: "technical tone",                 weight: 0.5 },
      { pattern: "shorten sequence",               weight: 0.6 },
      { pattern: "remove breakup email",           weight: 0.7 },
      { pattern: "remove breakup",                 weight: 0.6 },
      { pattern: "shorten emails",                 weight: 0.5 },
    ],
  },

  // ── Phase 1: Real Public Enrichment ──────────────────────────────────────────

  validate_email: {
    intent: "validate_email",
    patterns: [
      { pattern: "validate email",          weight: 0.8 },
      { pattern: "check email",             weight: 0.6 },
      { pattern: "verify email",            weight: 0.7 },
      { pattern: "is this email valid",     weight: 0.8 },
      { pattern: "is email valid",          weight: 0.7 },
      { pattern: "email valid",             weight: 0.5 },
      { pattern: "check if email",          weight: 0.5 },
      { pattern: "business email",          weight: 0.4 },
      { pattern: "disposable email",        weight: 0.5 },
    ],
  },

  enrich_contact: {
    intent: "enrich_contact",
    patterns: [
      { pattern: "enrich contact",          weight: 0.8 },
      { pattern: "enrich this contact",     weight: 0.8 },
      { pattern: "enrich email",            weight: 0.7 },
      { pattern: "lookup contact",          weight: 0.6 },
      { pattern: "look up contact",         weight: 0.6 },
      { pattern: "get info on",             weight: 0.4 },
      { pattern: "find info about",         weight: 0.4 },
    ],
  },

  fetch_company_website: {
    intent: "fetch_company_website",
    patterns: [
      { pattern: "fetch website",           weight: 0.8 },
      { pattern: "get website content",     weight: 0.8 },
      { pattern: "scrape website",          weight: 0.7 },
      { pattern: "read website",            weight: 0.6 },
      { pattern: "what does this website",  weight: 0.6 },
      { pattern: "website content",         weight: 0.5 },
      { pattern: "company website",         weight: 0.4 },
      { pattern: "fetch url",               weight: 0.6 },
      { pattern: "get url",                 weight: 0.5 },
    ],
  },

  extract_domain: {
    intent: "extract_domain",
    patterns: [
      { pattern: "extract domain from",     weight: 0.9 },
      { pattern: "extract domain",          weight: 0.8 },
      { pattern: "domain from",             weight: 0.7 },
      { pattern: "get domain from",         weight: 0.8 },
      { pattern: "get domain",              weight: 0.6 },
      { pattern: "what is the domain",      weight: 0.7 },
      { pattern: "what domain",             weight: 0.6 },
      { pattern: "parse domain",            weight: 0.7 },
      { pattern: "find domain",             weight: 0.6 },
    ],
  },

  search_company_web: {
    intent: "search_company_web",
    patterns: [
      { pattern: "search company website",    weight: 0.9 },
      { pattern: "find company website",      weight: 0.9 },
      { pattern: "find website for",          weight: 0.8 },
      { pattern: "search website for",        weight: 0.8 },
      { pattern: "find official website",     weight: 0.9 },
      { pattern: "search official website",   weight: 0.9 },
      { pattern: "what is the website of",    weight: 0.8 },
      { pattern: "website for company",       weight: 0.7 },
      { pattern: "company website for",       weight: 0.7 },
      { pattern: "look up website",           weight: 0.7 },
      { pattern: "website search",            weight: 0.5 },
    ],
  },

  select_official_website: {
    intent: "select_official_website",
    patterns: [
      { pattern: "select official website",   weight: 0.9 },
      { pattern: "pick official website",     weight: 0.9 },
      { pattern: "choose official website",   weight: 0.9 },
      { pattern: "which website is official", weight: 0.9 },
      { pattern: "best website from",         weight: 0.8 },
      { pattern: "score these websites",      weight: 0.8 },
      { pattern: "rank these websites",       weight: 0.8 },
      { pattern: "select website",            weight: 0.6 },
    ],
  },

  verify_company_website: {
    intent: "verify_company_website",
    patterns: [
      { pattern: "verify company website",    weight: 0.9 },
      { pattern: "verify this website",       weight: 0.85 },
      { pattern: "website belongs to",        weight: 0.85 },
      { pattern: "belongs to",                weight: 0.7 },
      { pattern: "verify website",            weight: 0.8 },
      { pattern: "is this the official",      weight: 0.8 },
      { pattern: "confirm website",           weight: 0.7 },
      { pattern: "check if this is",          weight: 0.6 },
      { pattern: "is this website",           weight: 0.6 },
      { pattern: "validate website",          weight: 0.7 },
      { pattern: "verify this url",           weight: 0.8 },
    ],
  },

  // ── Phase 3: AI Company Intelligence ─────────────────────────────────────────

  analyze_company: {
    intent: "analyze_company",
    patterns: [
      { pattern: "analyze company",           weight: 0.9 },
      { pattern: "analyse company",           weight: 0.9 },
      { pattern: "company intelligence",      weight: 0.9 },
      { pattern: "company analysis",          weight: 0.9 },
      { pattern: "analyze this company",      weight: 0.9 },
      { pattern: "analyse this company",      weight: 0.9 },
      { pattern: "company profile",           weight: 0.8 },
      { pattern: "extract company profile",   weight: 0.9 },
      { pattern: "company insights",          weight: 0.8 },
      { pattern: "research company",          weight: 0.7 },
      { pattern: "analyze website",           weight: 0.7 },
      { pattern: "analyse website",           weight: 0.7 },
      { pattern: "company report",            weight: 0.7 },
    ],
  },

  detect_pain_points: {
    intent: "detect_pain_points",
    patterns: [
      { pattern: "detect pain points",        weight: 0.9 },
      { pattern: "find pain points",          weight: 0.9 },
      { pattern: "identify pain points",      weight: 0.9 },
      { pattern: "pain points for",           weight: 0.8 },
      { pattern: "what are the pain points",  weight: 0.9 },
      { pattern: "business needs",            weight: 0.6 },
      { pattern: "identify needs",            weight: 0.7 },
      { pattern: "what does this company need", weight: 0.8 },
    ],
  },

  enrich_company: {
    intent: "enrich_company",
    patterns: [
      { pattern: "fully enrich company",      weight: 0.95 },
      { pattern: "full company enrichment",   weight: 0.95 },
      { pattern: "complete company enrichment", weight: 0.92 },
      { pattern: "deep company enrichment",     weight: 0.9 },
      { pattern: "enrich company fully",      weight: 0.9 },
      { pattern: "company enrichment pipeline", weight: 0.85 },
      { pattern: "enrich company",            weight: 0.82 },
    ],
  },

  generate_outreach: {
    intent: "generate_outreach",
    patterns: [
      { pattern: "generate outreach",         weight: 0.9 },
      { pattern: "write outreach",            weight: 0.9 },
      { pattern: "outreach email",            weight: 0.8 },
      { pattern: "draft outreach",            weight: 0.9 },
      { pattern: "outreach draft",            weight: 0.9 },
      { pattern: "write email for",           weight: 0.7 },
      { pattern: "generate email draft",      weight: 0.8 },
      { pattern: "cold email",                weight: 0.7 },
      { pattern: "sales email",               weight: 0.7 },
      { pattern: "outreach for",              weight: 0.7 },
    ],
  },

  resume_workflow: {
    intent: "resume_workflow",
    patterns: [
      { pattern: "resume previous",        weight: 0.8 },
      { pattern: "continue previous",      weight: 0.8 },
      { pattern: "back to previous",       weight: 0.8 },
      { pattern: "return to previous",     weight: 0.8 },
      { pattern: "continue earlier",       weight: 0.7 },
      { pattern: "go back",                weight: 0.7 },
      { pattern: "resume",                 weight: 0.5 },
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
