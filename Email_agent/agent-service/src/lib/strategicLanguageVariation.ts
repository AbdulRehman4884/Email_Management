export type StrategicPhraseKey =
  | "workflowMap"
  | "workflowAutomation"
  | "handoffQuality"
  | "operatingCadence"
  | "reportingVisibility"
  | "operationalRisk"
  | "campaignPreview"
  | "nextStep";

const PHRASE_LIBRARY: Record<StrategicPhraseKey, string[]> = {
  workflowMap: [
    "operational review",
    "delivery coordination assessment",
    "campaign strategy preview",
    "reporting visibility walkthrough",
    "process intelligence review",
    "onboarding workflow analysis",
    "execution visibility discussion",
    "operational readiness assessment",
    "buyer handoff review",
    "cross-functional alignment check",
  ],
  workflowAutomation: [
    "process intelligence",
    "execution support",
    "operational enablement",
    "workflow orchestration",
    "repeatable execution model",
    "team coordination layer",
    "operational visibility",
    "reporting consistency",
    "delivery coordination",
  ],
  handoffQuality: [
    "context transfer",
    "delivery continuity",
    "handover discipline",
    "next-step ownership",
    "implementation readiness",
    "cross-team follow-through",
  ],
  operatingCadence: [
    "management rhythm",
    "delivery coordination",
    "team coordination model",
    "operational governance",
    "delivery tempo",
    "review cadence",
    "cross-functional alignment",
  ],
  reportingVisibility: [
    "management visibility",
    "decision visibility",
    "performance transparency",
    "operational reporting clarity",
    "executive-level visibility",
    "accountability reporting",
  ],
  operationalRisk: [
    "execution drag",
    "coordination loss",
    "delivery leakage",
    "margin pressure",
    "readiness gap",
    "process variance",
    "buyer handoff risk",
    "reporting inconsistency",
  ],
  campaignPreview: [
    "campaign strategy preview",
    "personalization preview",
    "executive sequence review",
    "first-touch strategy draft",
    "account-specific outreach outline",
    "buyer-message preview",
  ],
  nextStep: [
    "short operational review",
    "strategic campaign preview",
    "onboarding coordination assessment",
    "delivery visibility discussion",
    "finance reporting walkthrough",
    "AI workflow readiness review",
    "account-specific messaging preview",
    "operational efficiency assessment",
    "buyer handoff clarity review",
    "cross-functional alignment discussion",
  ],
};

const DIRECT_REPLACEMENTS: Array<[RegExp, StrategicPhraseKey]> = [
  [/\bworkflow map\b/gi, "workflowMap"],
  [/\bworkflow automation\b/gi, "workflowAutomation"],
  [/\bhandoff quality\b/gi, "handoffQuality"],
  [/\boperating cadence\b/gi, "operatingCadence"],
  [/\breporting visibility\b/gi, "reportingVisibility"],
  [/\boperational risk\b/gi, "operationalRisk"],
  [/\bcampaign preview\b/gi, "campaignPreview"],
];

export interface LanguageVariationContext {
  companyName?: string;
  industry?: string;
  persona?: string;
  trigger?: string;
}

export function pickStrategicPhrase(
  key: StrategicPhraseKey,
  context: LanguageVariationContext = {},
  offset = 0,
): string {
  const options = PHRASE_LIBRARY[key];
  const seed = stableSeed([
    context.companyName,
    context.industry,
    context.persona,
    context.trigger,
    key,
  ]);
  return options[(seed + offset) % options.length] ?? options[0]!;
}

export function diversifyStrategicText(
  value: string,
  context: LanguageVariationContext = {},
): string {
  let output = value;
  const useCount = new Map<StrategicPhraseKey, number>();

  for (const [pattern, key] of DIRECT_REPLACEMENTS) {
    output = output.replace(pattern, () => {
      const count = useCount.get(key) ?? 0;
      useCount.set(key, count + 1);
      return pickStrategicPhrase(key, context, count);
    });
  }

  return output;
}

export function diversifyStrategicLines(
  values: string[],
  context: LanguageVariationContext = {},
): string[] {
  return values.map((value, index) => diversifyStrategicText(value, { ...context, trigger: `${context.trigger ?? ""}:${index}` }));
}

export function repeatedPhraseCount(value: string, phrases: string[] = overusedStrategicPhrases()): number {
  const normalized = value.toLowerCase();
  return phrases.reduce((count, phrase) => {
    const matches = normalized.match(new RegExp(`\\b${escapeRegExp(phrase.toLowerCase())}\\b`, "g"));
    return count + (matches?.length ?? 0);
  }, 0);
}

export function overusedStrategicPhrases(): string[] {
  return [
    "workflow map",
    "handoff quality",
    "operating cadence",
    "reporting visibility",
    "workflow automation",
    "would it be useful",
    "would a short review be useful",
    "signal that stood out",
    "i was reviewing",
    "public positioning points to",
    "practical executive question",
    "operational follow-through",
    "campaign personalization",
    "the relevant conversation is",
    "pressure-testing",
    "credible outreach angle",
    "read-only view",
    "credibly claim",
  ];
}

function stableSeed(parts: Array<string | undefined>): number {
  const text = parts.filter(Boolean).join("|");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 9973;
  }
  return hash;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
