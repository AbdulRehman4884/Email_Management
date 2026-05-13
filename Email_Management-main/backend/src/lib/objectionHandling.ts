import { analyzeOutreachQuality, plainTextToHtml } from "./outreachQuality.js";
import { buildDeliverabilityDiagnostics, type DeliverabilityDiagnostics } from "./deliverabilityDiagnostics.js";
import type {
  AutoReplyStrategyMode,
  ReplyIntentCategory,
  ReplyIntelligenceResult,
} from "./replyIntelligence.js";

export type ObjectionType =
  | "pricing"
  | "timing"
  | "competitor"
  | "authority"
  | "trust"
  | "complexity"
  | "implementation_effort"
  | "no_perceived_need";

export interface ReplySuggestion {
  subject: string;
  bodyText: string;
  bodyHtml: string;
  autoReplyMode: AutoReplyStrategyMode;
  reasoning: string[];
  quality: ReturnType<typeof analyzeOutreachQuality>;
  deliverability: DeliverabilityDiagnostics;
}

function trimToWordLimit(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[.,;:!?-]+$/g, "")}.`;
}

function firstName(name?: string | null): string {
  return String(name ?? "").trim().split(/\s+/)[0] || "there";
}

function safeSubject(subject?: string | null): string {
  const base = String(subject ?? "").trim();
  if (!base) return "Re: quick follow-up";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

function simpleTemplate(input: {
  greetingName?: string | null;
  body: string[];
  senderName?: string | null;
}): string {
  const greeting = `Hi ${firstName(input.greetingName)},`;
  const signoff = input.senderName?.trim() ? `Best,\n${input.senderName.trim()}` : "Best,";
  return [greeting, "", ...input.body, "", signoff].join("\n");
}

function objectionTemplate(
  objectionType: ObjectionType,
  recipientName?: string | null,
  senderName?: string | null,
  softer = false,
): string {
  switch (objectionType) {
    case "pricing":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          softer
            ? "Understood. In many cases teams start small before expanding."
            : "Understood. In many cases teams start small before expanding.",
          "Happy to share a lightweight approach if that would be useful.",
        ],
      });
    case "timing":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Totally makes sense.",
          softer
            ? "Would it help if I checked back in next quarter instead?"
            : "Would it help if I checked back in next quarter instead?",
        ],
      });
    case "competitor":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Understood.",
          "Many teams we speak with are already using similar platforms and usually evaluate where manual work still exists.",
          "If useful, I can send one short example.",
        ],
      });
    case "authority":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Thanks for the quick note.",
          "If there is a better person to speak with, I am happy to keep this brief and relevant.",
        ],
      });
    case "trust":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Completely fair.",
          "Happy to share a concise explanation of how teams usually evaluate this before making any decision.",
        ],
      });
    case "complexity":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Understood.",
          "The easiest next step is usually a simple explanation of the workflow, not a big rollout.",
        ],
      });
    case "implementation_effort":
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Makes sense.",
          "If helpful, I can outline the lightest starting point so you can gauge the effort quickly.",
        ],
      });
    case "no_perceived_need":
    default:
      return simpleTemplate({
        greetingName: recipientName,
        senderName,
        body: [
          "Understood.",
          "If it helps, I can share one short example of where teams usually see value and you can decide if it is relevant.",
        ],
      });
  }
}

function categoryTemplate(input: {
  category: ReplyIntentCategory;
  objectionType?: ObjectionType | null;
  recipientName?: string | null;
  senderName?: string | null;
  softer?: boolean;
}): string | null {
  switch (input.category) {
    case "positive_interest":
      return simpleTemplate({
        greetingName: input.recipientName,
        senderName: input.senderName,
        body: [
          "Thanks for the reply.",
          input.softer
            ? "Happy to send a short overview if that would help."
            : "Happy to send a short overview if that would help.",
        ],
      });
    case "meeting_interest":
      return simpleTemplate({
        greetingName: input.recipientName,
        senderName: input.senderName,
        body: [
          "Happy to coordinate.",
          "If useful, send a time that works for you or I can share a couple of options.",
        ],
      });
    case "neutral_question":
      return simpleTemplate({
        greetingName: input.recipientName,
        senderName: input.senderName,
        body: [
          "Happy to explain.",
          "I can send a short answer focused on the part you care about most.",
        ],
      });
    case "objection_price":
      return objectionTemplate("pricing", input.recipientName, input.senderName, input.softer);
    case "objection_timing":
      return objectionTemplate("timing", input.recipientName, input.senderName, input.softer);
    case "objection_competitor":
      return objectionTemplate("competitor", input.recipientName, input.senderName, input.softer);
    case "objection_authority":
      return objectionTemplate("authority", input.recipientName, input.senderName, input.softer);
    case "negative_not_interested":
      return simpleTemplate({
        greetingName: input.recipientName,
        senderName: input.senderName,
        body: [
          "Understood, and thanks for letting me know.",
          "I will close the loop here.",
        ],
      });
    default:
      if (input.objectionType) {
        return objectionTemplate(input.objectionType, input.recipientName, input.senderName, input.softer);
      }
      return null;
  }
}

export function generateReplySuggestion(input: {
  analysis: Omit<ReplyIntelligenceResult, "suggestedReplyText" | "suggestedReplyHtml" | "suggestionDiagnostics">;
  replySubject?: string | null;
  recipientName?: string | null;
  senderName?: string | null;
  senderEmail?: string | null;
  recipientEmail?: string | null;
  smtpProvider?: string | null;
  softer?: boolean;
}): ReplySuggestion | null {
  if (
    input.analysis.category === "unsubscribe_request" ||
    input.analysis.category === "spam_warning" ||
    input.analysis.autoReplyMode === "human_review_required"
  ) {
    return null;
  }

  const rawText = categoryTemplate({
    category: input.analysis.category,
    objectionType: input.analysis.objectionType,
    recipientName: input.recipientName,
    senderName: input.senderName,
    softer: input.softer,
  });
  if (!rawText) return null;

  const bodyText = trimToWordLimit(rawText, 65);
  const bodyHtml = plainTextToHtml(bodyText);
  const quality = analyzeOutreachQuality({
    subject: safeSubject(input.replySubject),
    bodyText,
    bodyHtml,
    mode: "low_promotional_plaintext",
  });
  const deliverability = buildDeliverabilityDiagnostics({
    subject: safeSubject(input.replySubject),
    html: bodyHtml,
    text: bodyText,
    smtpProvider: input.smtpProvider ?? "unknown",
    senderEmail: input.senderEmail ?? "noreply@example.com",
    recipientEmail: input.recipientEmail ?? "lead@example.com",
    unsubscribeHeaderPresence: false,
  });

  const reasoning = [
    `Matched reply category: ${input.analysis.category}.`,
    ...(input.analysis.objectionType ? [`Objection type: ${input.analysis.objectionType}.`] : []),
    `Suggested mode: ${input.analysis.autoReplyMode}.`,
  ];

  return {
    subject: safeSubject(input.replySubject),
    bodyText,
    bodyHtml,
    autoReplyMode: input.analysis.autoReplyMode,
    reasoning,
    quality,
    deliverability,
  };
}
