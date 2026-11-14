/**
 * src/lib/campaignCreationContext.ts
 *
 * Session memory of the chat campaign creation flow (persisted as `campaignCreation`).
 * Small on purpose: the recipients and their generated emails live in the job store
 * (services/campaignCreationJob.service.ts), keyed by user + session.
 *
 * Steps, in order (the user's fixed sequence):
 *   name → file → purpose → [sender] → generating → review (emails + subjects) → template_category →
 *   template_pick → template_review → [smtp] → schedule → (start with approval: flow ends)
 */

import type { CampaignTemplate } from "./campaignTemplates.js";

export type CampaignCreationStep =
  | "name"
  | "file"
  | "purpose"
  | "sender"
  | "generating"
  | "review"
  | "template_category"
  | "template_pick"
  | "template_review"
  | "smtp"
  | "schedule"
  // "Generate personalized emails" (lib/personalizeEmailsFlow.ts)
  | "pick_campaign"
  | "p_mode"
  | "p_tone"
  | "p_cta"
  | "p_sequence"
  | "p_length"
  | "p_breakup"
  | "p_short";

/** The writing choices of "Generate personalized emails" (keys match the generate_personalized_emails tool's values). */
export interface PersonalizeSettings {
  mode?: string;
  tone?: string;
  cta?: string;
  sequenceType?: string;
  /** Emails per recipient: 1 (no follow-ups), 3 or 4. */
  length?: number;
  breakup?: boolean;
  short?: boolean;
}

export interface CampaignFileSummary {
  fileName: string;
  totalRows: number;
  recipients: number;
  skipped: number;
  /** A few "row 4: no email address" lines. */
  skippedSample: string[];
  columns: string[];
  withLinks: number;
  /** Rows dropped over the per-campaign limit. */
  overLimit: number;
}

export interface CampaignCreationState {
  step: CampaignCreationStep;
  /** "personalize": the "Generate personalized emails" flow on an existing campaign; absent = "create campaign". */
  kind?: "personalize";
  /** Personalize: the campaigns offered at pick_campaign, in the order shown. */
  campaignChoices?: Array<{ id: string; name: string; status: string }>;
  /** Personalize: the existing campaign whose recipients get the emails (it is never changed). */
  source?: { id: string; name: string; status: string; smtpSettingsId: number | null };
  personalize?: PersonalizeSettings;
  name?: string;
  purpose?: string;
  /** First name that signs every email. */
  senderName?: string;
  /** Where the flow goes when the background run (writing / rewriting) is done. */
  afterRun?: "review" | "template_review";
  file?: CampaignFileSummary;
  category?: string;
  /** Numbered choices shown at template_pick (suggested first, then the defaults). */
  templateChoices?: CampaignTemplate[];
  template?: CampaignTemplate;
  campaignId?: string;
  smtpChoices?: Array<{ id: number; fromEmail: string; fromName?: string }>;
  smtpSettingsId?: number;
  saved?: { added: number; rejected: number; failedEmails: number };
  atIso: string;
}

/** An unfinished flow is dropped after 2 days (same as its job). */
const TTL_MS = 2 * 24 * 3600 * 1000;

export function liveCampaignCreation(
  ctx: CampaignCreationState | undefined,
  now = Date.now(),
): CampaignCreationState | undefined {
  if (!ctx || typeof ctx.step !== "string") return undefined;
  const at = new Date(ctx.atIso).getTime();
  return Number.isFinite(at) && now - at <= TTL_MS ? ctx : undefined;
}
