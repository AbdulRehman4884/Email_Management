export type GenerationMode =
  | "default"
  | "low_promotional_plaintext"
  | "executive_direct"
  | "friendly_human"
  | "value_first";

export interface OutreachQualityResult {
  modeUsed: Exclude<GenerationMode, "default">;
  wordCount: number;
  promotionalKeywordScore: number;
  promotionalKeywords: string[];
  genericGreeting: boolean;
  longParagraphCount: number;
  marketingToneScore: number;
  claimCount: number;
  issues: string[];
  suggestions: string[];
  rewriteSuggestion: string;
}

export interface FallbackOutreachInput {
  recipientName: string;
  company?: string;
  industry?: string;
  senderName?: string;
  mode?: GenerationMode | null;
}

export interface FallbackOutreachEmail {
  subject: string;
  text: string;
  html: string;
  modeUsed: Exclude<GenerationMode, "default">;
}

const PROMOTIONAL_TERMS: Array<[string, number]> = [
  ["campaign", 3],
  ["initiative", 3],
  ["marketing", 3],
  ["marketing team", 4],
  ["latest", 1],
  ["ai-powered", 3],
  ["innovative", 2],
  ["solution", 1],
  ["solutions", 1],
  ["excited", 2],
  ["offer", 2],
  ["exclusive", 2],
  ["transform", 1],
  ["unlock", 1],
  ["boost", 1],
  ["scale", 1],
];

const MARKETING_TONE_TERMS = [
  "reach out",
  "learn more",
  "book a demo",
  "special offer",
  "our platform",
  "our solution",
  "cutting-edge",
  "state-of-the-art",
  "marketing team",
  "latest initiative",
];

const CLAIM_TERMS = [
  "best",
  "leading",
  "powerful",
  "seamless",
  "revolutionary",
  "guarantee",
  "proven",
  "world-class",
];

const GENERIC_GREETING_PATTERNS = [
  /^hi there\b/i,
  /^hello there\b/i,
  /^dear sir\/madam\b/i,
  /^dear customer\b/i,
  /^greetings\b/i,
  /^hello friend\b/i,
  /^to whom it may concern\b/i,
];

export function normalizeGenerationMode(
  mode?: GenerationMode | string | null,
): Exclude<GenerationMode, "default"> {
  switch (String(mode ?? "").trim()) {
    case "executive_direct":
    case "friendly_human":
    case "value_first":
    case "low_promotional_plaintext":
      return String(mode) as Exclude<GenerationMode, "default">;
    case "default":
    default:
      return "low_promotional_plaintext";
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function htmlToPlainText(html: string): string {
  return decodeBasicHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br/>")}</p>`);
  return paragraphs.join("\n");
}

function countWeightedMatches(text: string, terms: Array<[string, number]>): {
  score: number;
  matched: string[];
} {
  const lower = text.toLowerCase();
  let score = 0;
  const matched = new Set<string>();
  for (const [term, weight] of terms) {
    if (lower.includes(term.toLowerCase())) {
      score += weight;
      matched.add(term);
    }
  }
  return { score, matched: [...matched] };
}

function countSimpleMatches(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((sum, term) => sum + (lower.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function countSentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function detectGenericGreeting(text: string): boolean {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  return GENERIC_GREETING_PATTERNS.some((pattern) => pattern.test(firstLine));
}

function detectLongParagraphs(text: string): number {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.filter((paragraph) => paragraph.length > 280 || countSentences(paragraph) > 4).length;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

export function analyzeOutreachQuality(input: {
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  mode?: GenerationMode | null;
}): OutreachQualityResult {
  const modeUsed = normalizeGenerationMode(input.mode);
  const bodyText = (input.bodyText?.trim() || htmlToPlainText(input.bodyHtml ?? "")).trim();
  const combined = `${input.subject}\n${bodyText}`.trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  const promo = countWeightedMatches(combined, PROMOTIONAL_TERMS);
  const marketingToneScore = countSimpleMatches(combined, MARKETING_TONE_TERMS);
  const claimCount = countSimpleMatches(combined, CLAIM_TERMS);
  const genericGreeting = detectGenericGreeting(bodyText);
  const longParagraphCount = detectLongParagraphs(bodyText);

  const issues: string[] = [];
  const suggestions: string[] = [];

  if (promo.score >= 3) {
    issues.push("Promotional wording detected");
    suggestions.push("Avoid words like campaign, initiative, marketing, and AI-powered.");
  }
  if (genericGreeting) {
    issues.push("Generic greeting");
    suggestions.push("Use the recipient's actual first name or a simple direct greeting.");
  }
  if (longParagraphCount > 0) {
    issues.push("Long paragraphs reduce readability");
    suggestions.push("Keep paragraphs to 1-3 short sentences.");
  }
  if (marketingToneScore >= 2) {
    issues.push("Marketing-style tone");
    suggestions.push("Write like a person, not a campaign.");
  }
  if (claimCount >= 2) {
    issues.push("Too many claims");
    suggestions.push("Make one concrete point and use one CTA.");
  }
  if (wordCount > 120) {
    issues.push("Email is longer than the target cold outreach length");
    suggestions.push("Aim for 80-120 words max.");
  }

  const rewriteSuggestion = [
    "Keep the note plain text, under 120 words, with one simple CTA.",
    "Use a short greeting, one observation, one value angle, and one question.",
    "Avoid hype, marketing language, and stacked claims.",
  ].join(" ");

  return {
    modeUsed,
    wordCount,
    promotionalKeywordScore: promo.score,
    promotionalKeywords: promo.matched,
    genericGreeting,
    longParagraphCount,
    marketingToneScore,
    claimCount,
    issues: dedupe(issues),
    suggestions: dedupe(suggestions),
    rewriteSuggestion,
  };
}

function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] || "there";
}

function buildObservationLine(company?: string, industry?: string): string {
  if (company && industry) {
    return `I noticed ${company} is working in ${industry}.`;
  }
  if (company) {
    return `I noticed the work happening at ${company}.`;
  }
  if (industry) {
    return `I noticed the work you are doing in ${industry}.`;
  }
  return "I wanted to reach out with a simple observation.";
}

export function buildFallbackOutreachEmail(input: FallbackOutreachInput): FallbackOutreachEmail {
  const modeUsed = normalizeGenerationMode(input.mode);
  const firstName = firstNameOnly(input.recipientName);
  const senderName = input.senderName?.trim() || "Best";
  const observation = buildObservationLine(input.company, input.industry);

  const subjectByMode: Record<Exclude<GenerationMode, "default">, string> = {
    low_promotional_plaintext: `Quick question, ${firstName}`,
    executive_direct: `${firstName}, quick question`,
    friendly_human: `Hi ${firstName}`,
    value_first: `Possible idea for ${input.company || "your team"}`,
  };

  const textByMode: Record<Exclude<GenerationMode, "default">, string> = {
    low_promotional_plaintext: [
      `Hi ${firstName},`,
      "",
      observation,
      "",
      "A lot of teams are trying to reduce manual work without adding more tools.",
      "Would it be worth sharing one simple idea that may help?",
      "",
      "Best,",
      senderName,
    ].join("\n"),
    executive_direct: [
      `Hi ${firstName},`,
      "",
      observation,
      "",
      "I have one direct idea that could help reduce manual work.",
      "Open to a short note with the detail?",
      "",
      "Best,",
      senderName,
    ].join("\n"),
    friendly_human: [
      `Hi ${firstName},`,
      "",
      observation,
      "",
      "I thought I would ask because teams in a similar spot are looking for simpler ways to handle repetitive work.",
      "If helpful, I can send over one idea in a short reply.",
      "",
      "Best,",
      senderName,
    ].join("\n"),
    value_first: [
      `Hi ${firstName},`,
      "",
      observation,
      "",
      "One thing that often helps is cutting manual follow-up work without changing the full stack.",
      "Worth sending a brief example?",
      "",
      "Best,",
      senderName,
    ].join("\n"),
  };

  const text = textByMode[modeUsed];
  return {
    subject: subjectByMode[modeUsed],
    text,
    html: plainTextToHtml(text),
    modeUsed,
  };
}

export function modePromptInstructions(mode?: GenerationMode | null): string {
  const modeUsed = normalizeGenerationMode(mode);
  switch (modeUsed) {
    case "executive_direct":
      return [
        "Write in an executive-direct style.",
        "Use short, clear sentences.",
        "Lead with relevance and one business outcome.",
        "Keep the CTA to one simple yes/no style question.",
      ].join(" ");
    case "friendly_human":
      return [
        "Write in a friendly, human tone.",
        "Sound like one person writing to another person.",
        "Do not sound like a sales sequence or a marketing email.",
      ].join(" ");
    case "value_first":
      return [
        "Lead with a concrete value point before asking for anything.",
        "Keep the message short and practical.",
        "Use one simple CTA only.",
      ].join(" ");
    case "low_promotional_plaintext":
    default:
      return [
        "Write in a low-promotional plain-text cold outreach style.",
        "Keep it 80-120 words.",
        "No hype, no campaign language, no marketing wording, no excited tone.",
        "Avoid words like campaign, initiative, innovative, AI-powered, marketing team, cutting-edge, latest.",
        "Use one short CTA only.",
      ].join(" ");
  }
}
