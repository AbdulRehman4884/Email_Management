import OpenAI from "openai";
import {
  analyzeOutreachQuality,
  htmlToPlainText,
  modePromptInstructions,
  normalizeGenerationMode,
  plainTextToHtml,
  type GenerationMode,
  type OutreachQualityResult,
} from "./outreachQuality.js";
import type { CTAType, SequenceType, ToneType } from "./sequenceGenerator.js";

interface RecipientData {
  name?: string | null;
  email: string;
  customFields?: Record<string, unknown>;
}

interface CampaignContext {
  name: string;
  subject: string;
  templateType?: string | null;
  toneInstruction?: string | null;
  customPrompt?: string | null;
  senderName?: string | null;
  mode?: GenerationMode | string | null;
  toneUsed?: ToneType | string | null;
  ctaType?: CTAType | string | null;
  ctaText?: string | null;
  sequenceType?: SequenceType | string | null;
  touchNumber?: number;
  touchObjective?: string | null;
  previousTouchSummary?: string | null;
  recommendedDelayDays?: number;
  leadScore?: number | null;
  painPoints?: string[];
  enrichmentData?: Record<string, unknown>;
  shortenEmails?: boolean;
  strategyReasoning?: string | null;
}

export interface GeneratedPersonalizedEmail {
  subject: string;
  html: string;
  text: string;
  modeUsed: Exclude<GenerationMode, "default">;
  toneUsed: string;
  ctaType: string;
  ctaText: string;
  sequenceType: string;
  touchNumber: number;
  strategyReasoning: string;
  quality: OutreachQualityResult;
}

function resolveRecipientName(recipient: RecipientData): string {
  const cf = recipient.customFields ?? {};
  return (
    recipient.name ||
    (cf.firstName as string | undefined) ||
    (cf.fullName as string | undefined) ||
    recipient.email.split("@")[0] ||
    "there"
  );
}

function resolveCompany(recipient: RecipientData): string {
  const cf = recipient.customFields ?? {};
  return String(
    (cf.company as string | undefined) ||
      (cf.organization as string | undefined) ||
      (cf.businessName as string | undefined) ||
      "",
  ).trim();
}

function resolveIndustry(recipient: RecipientData): string {
  const cf = recipient.customFields ?? {};
  return String(
    (cf.industry as string | undefined) ||
      (cf.segment as string | undefined) ||
      (cf.vertical as string | undefined) ||
      "",
  ).trim();
}

function normalizeSimple(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function questionCount(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function keepOnlyLastQuestionMark(text: string): string {
  const last = text.lastIndexOf("?");
  if (last < 0) return text;
  return text
    .split("")
    .map((char, index) => (char === "?" && index !== last ? "." : char))
    .join("");
}

function trimToWordLimit(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[.,;:!?-]+$/g, "")}.`;
}

function enforceCta(bodyText: string, ctaText: string): string {
  const paragraphs = bodyText
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return ctaText;

  const closingPattern = /^(best|thanks|thank you|regards|cheers)[,\s]/i;
  const lastParagraph = paragraphs[paragraphs.length - 1] ?? "";
  const hasClosing = closingPattern.test(lastParagraph);
  const closing = hasClosing ? paragraphs.pop() ?? "" : "";

  const existingCtaIndex = paragraphs.findIndex(
    (paragraph) => normalizeSimple(paragraph) === normalizeSimple(ctaText),
  );
  if (existingCtaIndex >= 0) {
    paragraphs.splice(existingCtaIndex, 1);
  }

  const content = paragraphs.map((paragraph, index) =>
    index === paragraphs.length - 1 ? paragraph : paragraph.replace(/\?/g, "."),
  );
  content.push(ctaText);
  if (closing) content.push(closing);
  return keepOnlyLastQuestionMark(content.join("\n\n")).trim();
}

function buildTouchIntro(campaign: CampaignContext, recipient: RecipientData): string {
  const name = resolveRecipientName(recipient);
  const company = resolveCompany(recipient);
  const industry = resolveIndustry(recipient);
  const touchNumber = campaign.touchNumber ?? 1;
  const objective = campaign.touchObjective ?? "open conversation";

  if (touchNumber === 2) {
    return `Hi ${name},\n\nJust following up on my earlier note in case the timing was better now.`;
  }
  if (touchNumber === 3) {
    return `Hi ${name},\n\nOne more quick thought before I leave this with you.`;
  }
  if (touchNumber >= 4) {
    return `Hi ${name},\n\nI did not want to keep chasing this if it is not a priority right now.`;
  }

  const observation =
    company && industry
      ? `I noticed ${company} is working in ${industry}.`
      : company
        ? `I noticed the work happening at ${company}.`
        : industry
          ? `I noticed the work you are doing in ${industry}.`
          : "I wanted to send a short note.";

  return `Hi ${name},\n\n${observation}`;
}

function buildValueParagraph(campaign: CampaignContext): string {
  const painPoint = Array.isArray(campaign.painPoints) && campaign.painPoints[0]
    ? campaign.painPoints[0]
    : "";
  const touchNumber = campaign.touchNumber ?? 1;

  if (touchNumber === 2) {
    return painPoint
      ? `The reason I am following up is that teams dealing with ${painPoint} usually do not need another big process change to improve things.`
      : "A lot of teams improve this without adding another heavy process or tool.";
  }
  if (touchNumber === 3) {
    return painPoint
      ? `One pattern I keep seeing is that ${painPoint} gets easier when the workflow is simplified instead of expanded.`
      : "One pattern I keep seeing is that small workflow changes often create the biggest improvement.";
  }
  if (touchNumber >= 4) {
    return "If this is not relevant, there is no need to reply and I can close the loop.";
  }
  return painPoint
    ? `A lot of teams are trying to improve ${painPoint} without adding more complexity.`
    : "A lot of teams are trying to reduce manual work without adding more tools.";
}

function buildSignoff(campaign: CampaignContext): string {
  const sender = campaign.senderName?.trim() || "Best";
  return `Best,\n${sender}`;
}

function buildFallbackEmail(
  recipient: RecipientData,
  campaign: CampaignContext,
): GeneratedPersonalizedEmail {
  const modeUsed = normalizeGenerationMode(campaign.mode);
  const toneUsed = String(campaign.toneUsed ?? campaign.toneInstruction ?? "friendly_human");
  const ctaType = String(campaign.ctaType ?? "curiosity_cta");
  const ctaText = String(campaign.ctaText ?? "Worth sharing a quick idea?").trim();
  const sequenceType = String(campaign.sequenceType ?? "cold_outreach");
  const touchNumber = campaign.touchNumber ?? 1;
  const subject =
    touchNumber === 1
      ? "Quick question"
      : touchNumber === 2
        ? "Quick follow-up"
        : touchNumber === 3
          ? "One more thought"
          : "Should I close the loop?";

  const rawText = [
    buildTouchIntro(campaign, recipient),
    buildValueParagraph(campaign),
    ctaText,
    buildSignoff(campaign),
  ].join("\n\n");
  const maxWords = campaign.shortenEmails ? 100 : 140;
  const text = trimToWordLimit(enforceCta(rawText, ctaText), maxWords);
  const html = plainTextToHtml(text);
  const quality = analyzeOutreachQuality({
    subject,
    bodyText: text,
    bodyHtml: html,
    mode: modeUsed,
  });

  return {
    subject,
    text,
    html,
    modeUsed,
    toneUsed,
    ctaType,
    ctaText,
    sequenceType,
    touchNumber,
    strategyReasoning:
      campaign.strategyReasoning ??
      `Fallback ${sequenceType} touch ${touchNumber} using ${toneUsed} and ${ctaType}.`,
    quality,
  };
}

function serializeRecord(record?: Record<string, unknown>): string {
  if (!record || Object.keys(record).length === 0) return "(none)";
  return Object.entries(record)
    .slice(0, 8)
    .map(([key, value]) => `  ${key}: ${String(value)}`)
    .join("\n");
}

function buildPrompt(recipient: RecipientData, campaign: CampaignContext): string {
  const modeUsed = normalizeGenerationMode(campaign.mode);
  const customFieldsText =
    recipient.customFields && Object.keys(recipient.customFields).length > 0
      ? Object.entries(recipient.customFields)
          .map(([k, v]) => `  ${k}: ${String(v)}`)
          .join("\n")
      : "  (no additional fields)";

  const maxWords = campaign.shortenEmails ? 100 : 140;

  return [
    "You write short AI SDR outreach emails for one recipient at a time.",
    "Use ONLY the supplied recipient and enrichment data. Do not invent facts, metrics, or claims.",
    modePromptInstructions(modeUsed),
    campaign.toneInstruction
      ? `User tone guidance: ${campaign.toneInstruction}.`
      : "Prefer a direct, human, low-hype tone.",
    campaign.customPrompt
      ? `Additional user instructions: ${campaign.customPrompt}`
      : "No additional custom instructions.",
    "",
    `Campaign name: ${campaign.name}`,
    `Base subject context: ${campaign.subject}`,
    `Selected tone: ${campaign.toneUsed ?? "friendly_human"}`,
    `Selected CTA type: ${campaign.ctaType ?? "curiosity_cta"}`,
    `Selected CTA text: ${campaign.ctaText ?? "Worth sharing a quick idea?"}`,
    `Sequence type: ${campaign.sequenceType ?? "cold_outreach"}`,
    `Touch number: ${campaign.touchNumber ?? 1}`,
    `Touch objective: ${campaign.touchObjective ?? "open conversation"}`,
    `Recommended delay after previous touch: ${campaign.recommendedDelayDays ?? 0} day(s)`,
    `Previous touch summary: ${campaign.previousTouchSummary ?? "(none)"}`,
    `Lead score: ${campaign.leadScore ?? "unknown"}`,
    `Pain points: ${campaign.painPoints?.join(", ") || "(none provided)"}`,
    "Enrichment data:",
    serializeRecord(campaign.enrichmentData),
    "",
    "Recipient data:",
    `  name: ${recipient.name ?? "(not provided)"}`,
    `  email: ${recipient.email}`,
    customFieldsText,
    "",
    "Return JSON only with this shape:",
    '{ "subject": "string", "bodyText": "string" }',
    "",
    "Requirements:",
    `  - ${maxWords - 20}-${maxWords} words max for bodyText.`,
    "  - Plain text style. No markdown. No HTML.",
    "  - Keep the email human, low-promotional, and deliverability-safe.",
    "  - Use one short observation only if it is supported by the provided data.",
    "  - Use exactly one CTA, and make it the selected CTA text above.",
    "  - Avoid innovative, cutting-edge, revolutionary, excited, campaign, and marketing team.",
    "  - No hype words. No bullet list. No multiple questions.",
    "  - Sign as one person, not a team.",
  ].join("\n");
}

function sanitizeModelOutput(
  parsed: Record<string, unknown>,
  recipient: RecipientData,
  campaign: CampaignContext,
): GeneratedPersonalizedEmail {
  const modeUsed = normalizeGenerationMode(campaign.mode);
  const subject = String(parsed.subject ?? "").trim();
  const rawBodyText = String(parsed.bodyText ?? "").trim();

  if (!subject || !rawBodyText) {
    return buildFallbackEmail(recipient, campaign);
  }

  const ctaText = String(campaign.ctaText ?? "Worth sharing a quick idea?").trim();
  const maxWords = campaign.shortenEmails ? 100 : 140;
  const text = trimToWordLimit(enforceCta(rawBodyText, ctaText), maxWords);
  const html = plainTextToHtml(text);
  const quality = analyzeOutreachQuality({
    subject,
    bodyText: text,
    bodyHtml: html,
    mode: modeUsed,
  });

  const shouldUseFallback =
    modeUsed === "low_promotional_plaintext" &&
    (quality.promotionalKeywordScore >= 3 ||
      quality.marketingToneScore >= 2 ||
      quality.genericGreeting ||
      quality.wordCount > maxWords ||
      questionCount(text) > 1);

  if (shouldUseFallback) {
    console.warn(
      `openaiEmailGenerator: model output looked too promotional or aggressive for ${recipient.email} — using fallback`,
    );
    return buildFallbackEmail(recipient, campaign);
  }

  return {
    subject,
    text,
    html,
    modeUsed,
    toneUsed: String(campaign.toneUsed ?? campaign.toneInstruction ?? "friendly_human"),
    ctaType: String(campaign.ctaType ?? "curiosity_cta"),
    ctaText,
    sequenceType: String(campaign.sequenceType ?? "cold_outreach"),
    touchNumber: campaign.touchNumber ?? 1,
    strategyReasoning:
      campaign.strategyReasoning ??
      `Model-generated ${campaign.sequenceType ?? "cold_outreach"} touch ${campaign.touchNumber ?? 1}.`,
    quality,
  };
}

export async function generatePersonalizedEmailBody(
  recipient: RecipientData,
  campaign: CampaignContext,
): Promise<GeneratedPersonalizedEmail | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("openaiEmailGenerator: OPENAI_API_KEY not configured — using template fallback.");
    return buildFallbackEmail(recipient, campaign);
  }

  const prompt = buildPrompt(recipient, campaign);

  try {
    const startMs = Date.now();
    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.45,
        max_tokens: 500,
        response_format: { type: "json_object" },
      },
      { signal: AbortSignal.timeout(8_000) },
    );
    const durationMs = Date.now() - startMs;
    console.log(`openaiEmailGenerator: generated for ${recipient.email} in ${durationMs}ms`);
    const text = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      console.warn(`openaiEmailGenerator: empty response for ${recipient.email} — using template fallback`);
      return buildFallbackEmail(recipient, campaign);
    }

    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return sanitizeModelOutput(parsed, recipient, campaign);
    } catch {
      console.warn(`openaiEmailGenerator: non-JSON response for ${recipient.email} — using template fallback`);
      return buildFallbackEmail(recipient, campaign);
    }
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.message.toLowerCase().includes("timeout") ||
        err.message.toLowerCase().includes("abort"));
    if (isTimeout) {
      console.warn(`openaiEmailGenerator: OpenAI call timed out for ${recipient.email} — using template fallback`);
    } else {
      console.error("openaiEmailGenerator: generation failed —", err instanceof Error ? err.message : err);
    }
    return buildFallbackEmail(recipient, campaign);
  }
}

export function previewPersonalizedEmailText(html: string): string {
  return htmlToPlainText(html);
}
