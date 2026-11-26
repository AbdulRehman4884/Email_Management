/**
 * src/lib/automationContext.ts
 *
 * Session memory of the chat automation flow (persisted as `automationFlow`). Small on purpose: the
 * per-recipient follow-ups live in the job store (services/campaignCreationJob.service.ts).
 *
 * Create:  kind → target (form / campaign) → template or own plan → [email account] → [what you offer] →
 *          [sender name] → writing → review (approve / change) → saved OFF → approval card turns it on.
 * Edit:    "change the emails of automation X" → writing → review → approval card saves the new emails.
 */

export type AutomationFlowStep =
  | "kind"
  | "target"
  | "template"
  | "plan"
  | "smtp"
  | "purpose"
  | "sender"
  | "writing"
  | "review";

/** One email of the automation, in step order (call results included). */
export interface FlowEmail {
  /** What this email is for, e.g. "first email", "follow-up 2", "after the call: no answer". */
  role: string;
  /** Empty for a reply in the same thread. */
  subject: string;
  body: string;
}

export interface AutomationFlowState {
  step: AutomationFlowStep;
  mode: "create" | "edit";
  kind?: "form" | "campaign";
  /** The form or campaign it is for; none = not attached (form automations only). */
  target?: { type: "form" | "campaign"; id: number; name: string; status?: string };
  /** Choices shown at the current question, in the order shown. */
  choices?: Array<{ id: string; label: string }>;
  templateKey?: string;
  templateName?: string;
  /** Own plan: number of follow-ups and days between emails. */
  plan?: { followUps: number; gapDays: number; reminder: boolean };
  smtpSettingsId?: number;
  smtpLabel?: string;
  /** The account list was shown (several accounts), so "back" from the purpose returns to it. */
  smtpAsked?: boolean;
  /** Form automations: several email accounts (the first = smtpSettingsId); each new lead gets one of them. */
  smtpSettingIds?: number[];
  purpose?: string;
  senderName?: string;
  /** The automation (created OFF when the template / plan was chosen; edit: the one being changed). */
  automationId?: number;
  automationName?: string;
  /** Edit: whether it was on (saving then needs approval). */
  wasActive?: boolean;
  /** Template emails (form automations, scheduled campaigns). */
  emails?: FlowEmail[];
  /** Campaign follow-ups written per recipient (draft campaigns): the job store holds them. */
  perRecipient?: boolean;
  /** Number of follow-up emails of a campaign automation. */
  followUpCount?: number;
  /** Last change request, shown in the review. */
  instruction?: string;
  atIso: string;
}

/** An unfinished flow is dropped after 2 days. */
const TTL_MS = 2 * 24 * 3600 * 1000;

export function liveAutomationFlow(ctx: AutomationFlowState | undefined, now = Date.now()): AutomationFlowState | undefined {
  if (!ctx || typeof ctx.step !== "string") return undefined;
  const at = new Date(ctx.atIso).getTime();
  return Number.isFinite(at) && now - at <= TTL_MS ? ctx : undefined;
}
