/**
 * src/lib/campaignTemplates.ts
 *
 * Chat campaign creation, step 6: templates. A template is a WRITING STRUCTURE (what each paragraph does,
 * the tone), not a design: every email stays a plain 1-to-1 email — greeting, 2–3 short paragraphs, one
 * question, sign-off with a first name — with no headers, boxes, colours, buttons or logos.
 * Applying a template rewrites each recipient's email to that structure (EMAIL_REWRITE_PROMPT) and every
 * result is checked again (lib/emailRealism.ts). The campaign body is only {{ai_body}}.
 */

export interface CampaignTemplate {
  name: string;
  /** One line on why it fits (suggested templates). */
  reason?: string;
  /** What each paragraph does and the tone. */
  structure: string;
}

export const BODY_PLACEHOLDER = "{{ai_body}}";
export const SUBJECT_PLACEHOLDER = "{{ai_subject}}";

export const CAMPAIGN_CATEGORIES = [
  "Job / Proposal",
  "Promotion",
  "Announcement",
  "Event",
  "Newsletter",
  "Follow-up",
  "Other",
] as const;

/** The built-in structures (the same five types the old wizard offered), all plain emails. */
export const DEFAULT_TEMPLATES: CampaignTemplate[] = [
  {
    name: "Promotional",
    structure: "Paragraph 1: the specific thing about them that makes the offer relevant. Paragraph 2: what the offer is and one proof. Last line: a short question about trying it.",
  },
  {
    name: "Newsletter",
    structure: "Paragraph 1: the specific thing about them. Paragraph 2: the one update that matters to them and why. Last line: ask if they want to hear more.",
  },
  {
    name: "Event",
    structure: "Paragraph 1: the specific thing about them that fits the event. Paragraph 2: what the event is, when, and what they'd get from it. Last line: ask if they'd like a spot.",
  },
  {
    name: "Announcement",
    structure: "Paragraph 1: the specific thing about them. Paragraph 2: the news in one sentence and why it matters to them. Last line: a short question.",
  },
  {
    name: "Follow-up",
    structure: "Two short paragraphs only. Paragraph 1: the specific thing about them, said briefly. Paragraph 2: one line of value and a light question.",
  },
];

/** The rewrite request that applies a template to one email. */
export function templateInstruction(t: CampaignTemplate): string {
  return `Restructure this email to the "${t.name}" structure, keeping its facts and the opening observation: ${t.structure}`;
}
