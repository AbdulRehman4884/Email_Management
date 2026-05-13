export type CTAType =
  | "curiosity_cta"
  | "soft_meeting_cta"
  | "reply_cta"
  | "value_cta"
  | "direct_cta"
  | "no_pressure_cta";

export type ToneType =
  | "executive_direct"
  | "founder_style"
  | "consultant_style"
  | "friendly_human"
  | "technical_advisor"
  | "concise_enterprise";

export type SequenceType =
  | "cold_outreach"
  | "warm_followup"
  | "reengagement"
  | "founder_outreach";

export interface SdrStrategyInput {
  leadScore?: number | null;
  industry?: string | null;
  companySize?: string | number | null;
  enrichmentData?: Record<string, unknown> | null;
  painPoints?: string[] | null;
  intent?: string | null;
  recipientRole?: string | null;
  recipientTitle?: string | null;
  confidence?: number | null;
  preferredCtaType?: CTAType | null;
  preferredTone?: ToneType | null;
  preferredSequenceType?: SequenceType | null;
}

export interface SelectedCTA {
  ctaType: CTAType;
  ctaText: string;
  reasoning: string;
}

export interface SelectedTone {
  tone: ToneType;
  reasoning: string;
}

export interface SelectedSequenceStrategy {
  sequenceType: SequenceType;
  outreachApproach: string;
  reasoning: string;
}

export interface SdrStrategySummary {
  tone: ToneType;
  ctaType: CTAType;
  ctaText: string;
  sequenceType: SequenceType;
  outreachApproach: string;
  reasoning: string[];
}

function normalizeScore(value?: number | null): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, value));
}

function roleSignals(input: SdrStrategyInput) {
  const role = `${input.recipientRole ?? ""} ${input.recipientTitle ?? ""}`.toLowerCase();
  return {
    isExecutive: /\b(ceo|cfo|coo|chief|vp|president|director|head)\b/.test(role),
    isFounder: /\b(founder|co-founder|owner)\b/.test(role),
    isTechnical: /\b(engineer|engineering|developer|cto|architect|devops|technical|it)\b/.test(role),
    isOps: /\b(operations|ops|revenue operations|sales ops|marketing ops|enablement)\b/.test(role),
  };
}

function isStartupLike(input: SdrStrategyInput): boolean {
  const size = String(input.companySize ?? "").toLowerCase();
  const industry = String(input.industry ?? "").toLowerCase();
  return /\b(startup|seed|series a|small|1-50|11-50|51-200)\b/.test(size + " " + industry);
}

function painPointStrength(input: SdrStrategyInput): number {
  return Array.isArray(input.painPoints) ? input.painPoints.filter(Boolean).length : 0;
}

export function selectBestCTA(input: SdrStrategyInput): SelectedCTA {
  if (input.preferredCtaType) {
    return {
      ctaType: input.preferredCtaType,
      ctaText: ctaTextForType(input.preferredCtaType),
      reasoning: "User preference override applied.",
    };
  }

  const score = normalizeScore(input.leadScore);
  const role = roleSignals(input);
  const confidence = typeof input.confidence === "number" ? input.confidence : 0.8;

  if (role.isFounder || role.isExecutive) {
    return {
      ctaType: score >= 70 ? "curiosity_cta" : "direct_cta",
      ctaText: score >= 70 ? "Worth sharing a quick idea?" : "Are you the right person to discuss this?",
      reasoning: "Executive and founder audiences respond better to concise CTAs with minimal friction.",
    };
  }

  if (role.isTechnical) {
    return {
      ctaType: "value_cta",
      ctaText: "I can send over a few practical examples if useful.",
      reasoning: "Technical audiences usually respond better to value-led CTAs than meeting asks.",
    };
  }

  if (score >= 80) {
    return {
      ctaType: "soft_meeting_cta",
      ctaText: "Open to a short 15-minute conversation next week?",
      reasoning: "High-score or warmer leads can support a soft meeting ask without feeling too aggressive.",
    };
  }

  if (confidence < 0.55) {
    return {
      ctaType: "reply_cta",
      ctaText: "Would love your thoughts.",
      reasoning: "Lower-confidence enrichment should use a lighter reply CTA instead of a stronger ask.",
    };
  }

  return {
    ctaType: "curiosity_cta",
    ctaText: "Worth sharing a quick idea?",
    reasoning: "Cold outreach works best with a low-friction curiosity CTA.",
  };
}

export function selectBestTone(input: SdrStrategyInput): SelectedTone {
  if (input.preferredTone) {
    return { tone: input.preferredTone, reasoning: "User preference override applied." };
  }

  const role = roleSignals(input);
  const startupLike = isStartupLike(input);

  if (role.isTechnical) {
    return {
      tone: "technical_advisor",
      reasoning: "Technical leads generally respond better to practical, technical-advisor language.",
    };
  }

  if (role.isFounder && startupLike) {
    return {
      tone: "friendly_human",
      reasoning: "Startup founders usually respond better to direct but human founder-to-founder style.",
    };
  }

  if (role.isFounder || /\b(founder|owner)\b/.test(`${input.recipientTitle ?? ""}`.toLowerCase())) {
    return {
      tone: "founder_style",
      reasoning: "Founder outreach should sound peer-like and concise.",
    };
  }

  if (role.isExecutive) {
    return {
      tone: "concise_enterprise",
      reasoning: "C-level and enterprise leaders prefer concise enterprise-style messaging.",
    };
  }

  if (role.isOps) {
    return {
      tone: "consultant_style",
      reasoning: "Operations audiences often respond well to consultant-style problem framing.",
    };
  }

  return {
    tone: "friendly_human",
    reasoning: "Defaulting to a plain, human tone keeps cold outreach approachable and low-pressure.",
  };
}

export function selectBestSequenceStrategy(input: SdrStrategyInput): SelectedSequenceStrategy {
  if (input.preferredSequenceType) {
    return {
      sequenceType: input.preferredSequenceType,
      outreachApproach: outreachApproachForType(input.preferredSequenceType),
      reasoning: "User preference override applied.",
    };
  }

  const score = normalizeScore(input.leadScore);
  const role = roleSignals(input);
  const intent = String(input.intent ?? "").toLowerCase();
  const startupLike = isStartupLike(input);
  const painCount = painPointStrength(input);

  if ((role.isFounder || startupLike) && painCount > 0) {
    return {
      sequenceType: "founder_outreach",
      outreachApproach: "peer-style founder note with pain-point relevance",
      reasoning: "Founder-led or startup-like outreach is stronger when it feels peer-to-peer and pain-aware.",
    };
  }

  if (score >= 75 || /\bwarm|followup|follow-up\b/.test(intent)) {
    return {
      sequenceType: "warm_followup",
      outreachApproach: "gentle follow-up with a meeting-ready progression",
      reasoning: "Warmer leads support a slightly stronger follow-up sequence.",
    };
  }

  if (score <= 35 || /\breengage|re-engage|revive\b/.test(intent)) {
    return {
      sequenceType: "reengagement",
      outreachApproach: "light re-entry with lower pressure and a clean close-the-loop option",
      reasoning: "Colder or stale leads need a softer re-engagement pattern.",
    };
  }

  return {
    sequenceType: "cold_outreach",
    outreachApproach: "short cold outreach with value-first follow-ups",
    reasoning: "Cold outreach should start light, reinforce value, and end with a low-pressure final touch.",
  };
}

export function buildSdrStrategy(input: SdrStrategyInput): SdrStrategySummary {
  const tone = selectBestTone(input);
  const cta = selectBestCTA(input);
  const sequence = selectBestSequenceStrategy(input);
  return {
    tone: tone.tone,
    ctaType: cta.ctaType,
    ctaText: cta.ctaText,
    sequenceType: sequence.sequenceType,
    outreachApproach: sequence.outreachApproach,
    reasoning: [tone.reasoning, cta.reasoning, sequence.reasoning],
  };
}

export function ctaTextForType(type: CTAType): string {
  switch (type) {
    case "soft_meeting_cta":
      return "Open to a short 15-minute conversation next week?";
    case "reply_cta":
      return "Would love your thoughts.";
    case "value_cta":
      return "I can send over a few practical examples if useful.";
    case "direct_cta":
      return "Are you the right person to discuss this?";
    case "no_pressure_cta":
      return "If this isn't relevant, happy to close the loop.";
    case "curiosity_cta":
    default:
      return "Worth sharing a quick idea?";
  }
}

export function outreachApproachForType(type: SequenceType): string {
  switch (type) {
    case "warm_followup":
      return "gentle follow-up with stronger context";
    case "reengagement":
      return "low-pressure re-entry";
    case "founder_outreach":
      return "peer-to-peer founder style";
    case "cold_outreach":
    default:
      return "value-first cold outreach";
  }
}
