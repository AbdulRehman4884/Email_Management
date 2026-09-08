import { diversifyStrategicText, overusedStrategicPhrases } from "./strategicLanguageVariation.js";
import { applyExecutiveConversationalRealism } from "./executiveConversationalRealism.js";
import { forbiddenMicroPhrases } from "./microPhraseRealism.js";

export interface HumanizationContext {
  companyName?: string;
  industry?: string;
  persona?: string;
  offset?: number;
}

const ROBOTIC_REPLACEMENTS: Array<[RegExp, string[]]> = [
  [/\bpublic positioning points to\b/gi, ["the public story points toward", "the company narrative indicates", "the market-facing message shows"]],
  [/\bpractical executive question\b/gi, ["commercial question", "leadership issue", "management concern"]],
  [/\boperational follow-through\b/gi, ["follow-up discipline", "execution clarity", "next-step ownership"]],
  [/\bcampaign personalization\b/gi, ["account-specific messaging", "buyer-specific outreach", "message tailoring"]],
  [/\bexecution rhythm and context discipline\b/gi, ["delivery coordination and buyer handoff clarity", "operational visibility and cross-functional alignment"]],
  [/\bcampaign intelligence and operational readiness\b/gi, ["account intelligence and campaign review quality", "buyer context and launch readiness"]],
  [/\boperating cadence\b/gi, ["management rhythm", "delivery coordination", "review discipline"]],
  [/\bworkflow map\b/gi, ["operational review", "delivery coordination review", "campaign strategy preview"]],
  [/\bworkflow automation\b/gi, ["process support", "operational visibility", "team coordination"]],
  [/\bwould a short review be useful\b/gi, ["open to a focused review", "worth a quick readout", "would a concise assessment help"]],
  [/\bwould it be useful\b/gi, ["would it help", "open to", "worth comparing notes on"]],
  [/\bthis may not be a priority right now\b/gi, ["This may be early", "Timing may not be right", "This might sit behind other priorities"]],
  [/\bthe relevant conversation is\b/gi, ["what usually matters is", "the practical question is", "the useful discussion is"]],
  [/\bpressure-testing\b/gi, ["comparing notes on", "reviewing briefly", "walking through"]],
  [/\bcredible outreach angle\b/gi, ["practical way into the conversation", "useful first-touch theme", "grounded campaign opening"]],
  [/\bread-only view\b/gi, ["lightweight breakdown", "quick observations", "short perspective"]],
  [/\bcredibly claim\b/gi, ["say without stretching the positioning", "keep grounded", "state without creating messaging drift"]],
];

export function humanizeOutreachText(value: string, context: HumanizationContext = {}): string {
  let output = diversifyStrategicText(value, context);

  ROBOTIC_REPLACEMENTS.forEach(([pattern, replacements], index) => {
    output = output.replace(pattern, () => {
      const seed = stableSeed([context.companyName, context.industry, context.persona, String(context.offset ?? 0), String(index)]);
      return replacements[seed % replacements.length] ?? replacements[0]!;
    });
  });

  output = output
    .replace(/\bpoints to continued investment in\b/gi, "indicates continued attention to")
    .replace(/\bshould be treated as\b/gi, "is better framed as")
    .replace(/\bvisible hiring activity points to\b/gi, "visible hiring activity usually means")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return applyExecutiveConversationalRealism(reduceRepeatedOpenings(output), context);
}

export function humanizeSequence(sequence: string[], context: HumanizationContext = {}): string[] {
  return sequence.map((item, index) => humanizeOutreachText(item, { ...context, offset: (context.offset ?? 0) + index }));
}

export function hasRoboticPhrasing(value: string): boolean {
  const lower = value.toLowerCase();
  return overusedStrategicPhrases().some((phrase) => lower.includes(phrase)) ||
    forbiddenMicroPhrases().some((phrase) => lower.includes(phrase)) ||
    /execution rhythm and context discipline|campaign intelligence and operational readiness|public positioning points to/.test(lower);
}

export function phraseRepetitionScore(value: string): number {
  const lower = value.toLowerCase();
  const phrases = [
    ...overusedStrategicPhrases(),
    "would a short review be useful",
    "public positioning points to",
    "practical executive question",
    "operational follow-through",
    ...forbiddenMicroPhrases(),
  ];
  return phrases.reduce((score, phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return score + (lower.match(new RegExp(`\\b${escaped}\\b`, "g"))?.length ?? 0);
  }, 0);
}

function reduceRepeatedOpenings(value: string): string {
  return value
    .replace(/I was reviewing/gi, "I looked at")
    .replace(/The signal that stood out/gi, "The business issue worth testing")
    .replace(/A practical first step/gi, "One useful starting point");
}

function stableSeed(parts: Array<string | undefined>): number {
  const text = parts.filter(Boolean).join("|");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 37 + text.charCodeAt(i)) % 8191;
  return Math.abs(hash);
}
