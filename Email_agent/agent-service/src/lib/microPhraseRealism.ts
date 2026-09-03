export interface MicroPhraseContext {
  companyName?: string;
  industry?: string;
  persona?: string;
  offset?: number;
}

const PRESSURE_TEST_ALTERNATIVES = [
  "compare notes on",
  "review briefly",
  "walk through",
  "share observations on",
  "review patterns around",
  "discuss practical gaps in",
  "explore",
  "validate assumptions around",
  "exchange ideas on",
];

const READ_ONLY_ALTERNATIVES = [
  "lightweight breakdown",
  "quick observations",
  "brief operational review",
  "short perspective",
  "practical patterns we tend to see",
];

const CREDIBLE_CLAIM_ALTERNATIVES = [
  "without stretching the positioning",
  "while keeping the outreach grounded",
  "without creating messaging drift",
  "without losing clarity as teams scale",
  "without overcomplicating the message",
];

const RELEVANT_CONVERSATION_ALTERNATIVES = [
  "What usually becomes difficult at this stage is",
  "One thing that often happens as delivery expands is",
  "At enterprise scale, visibility tends to get harder around",
  "What stood out reviewing the company is",
  "Teams often discover that",
];

const CREDIBLE_ANGLE_ALTERNATIVES = [
  "the growth trajectory raises some coordination challenges",
  "the expansion pace usually creates visibility gaps",
  "scaling delivery tends to expose handoff friction",
  "growth often introduces reporting inconsistencies",
  "the company story gives the outreach a practical way in",
];

const AI_FINGERPRINTS = [
  "the relevant conversation is",
  "pressure-testing",
  "credible outreach angle",
  "read-only view",
  "credibly claim",
  "market story does create",
  "market story creates",
];

export function cleanMicroPhrases(value: string, context: MicroPhraseContext = {}): string {
  let output = value;

  output = output
    .replace(/\bThe relevant conversation is not another tool pitch\.?\s*It is whether\b/gi, () =>
      `${pick(RELEVANT_CONVERSATION_ALTERNATIVES, context)} whether`)
    .replace(/\bThe relevant conversation is whether\b/gi, () =>
      `${pick(RELEVANT_CONVERSATION_ALTERNATIVES, context)} whether`)
    .replace(/\bthe relevant conversation is\b/gi, () => pick(RELEVANT_CONVERSATION_ALTERNATIVES, context).toLowerCase())
    .replace(/\bmarket story does create a credible outreach angle around\b/gi, () =>
      `${pick(CREDIBLE_ANGLE_ALTERNATIVES, context)} around`)
    .replace(/\bmarket story creates a credible outreach angle around\b/gi, () =>
      `${pick(CREDIBLE_ANGLE_ALTERNATIVES, context)} around`)
    .replace(/\bcredible outreach angle\b/gi, "practical way into the conversation")
    .replace(/\bpressure-testing\b/gi, () => pick(PRESSURE_TEST_ALTERNATIVES, context))
    .replace(/\bpressure test\b/gi, () => pick(PRESSURE_TEST_ALTERNATIVES, context))
    .replace(/\bread-only view\b/gi, () => pick(READ_ONLY_ALTERNATIVES, context))
    .replace(/\bwhat the company can credibly claim\b/gi, () => pick(CREDIBLE_CLAIM_ALTERNATIVES, context))
    .replace(/\bcredibly claim\b/gi, () => pick(CREDIBLE_CLAIM_ALTERNATIVES, context))
    .replace(/\blooks like the kind of business where\b/gi, "appears to be at a stage where")
    .replace(/\buseful conversation\b/gi, "practical discussion")
    .replace(/\bAI workflow readiness\b/gi, "AI enablement readiness")
    .replace(/\bread-only operating intelligence\b/gi, "operational visibility");

  return output
    .replace(/\s+([.,;:?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function containsAiFingerprint(value: string): boolean {
  const lower = value.toLowerCase();
  return AI_FINGERPRINTS.some((phrase) => lower.includes(phrase));
}

export function forbiddenMicroPhrases(): string[] {
  return [...AI_FINGERPRINTS];
}

function pick(values: string[], context: MicroPhraseContext): string {
  const index = stableSeed([
    context.companyName,
    context.industry,
    context.persona,
    String(context.offset ?? 0),
  ]) % values.length;
  return values[index] ?? values[0]!;
}

function stableSeed(parts: Array<string | undefined>): number {
  const text = parts.filter(Boolean).join("|");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 41 + text.charCodeAt(i)) % 12289;
  return Math.abs(hash);
}
