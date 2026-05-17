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

export interface SequenceStrategyInput {
  leadScore?: number | null;
  industry?: string | null;
  companySize?: string | number | null;
  enrichmentData?: Record<string, unknown> | null;
  painPoints?: string[] | null;
  intent?: string | null;
  recipientRole?: string | null;
  recipientTitle?: string | null;
  preferredTone?: ToneType | null;
  preferredCtaType?: CTAType | null;
  preferredSequenceType?: SequenceType | null;
  sequenceLength?: 3 | 4;
  includeBreakupEmail?: boolean;
}

export interface SequenceTouchPlan {
  touchNumber: number;
  delayDays: number;
  objective: string;
  tone: ToneType;
  ctaType: CTAType;
  ctaText: string;
  previousTouchSummary?: string;
  subjectHint: string;
}

export interface SequencePlan {
  tone: ToneType;
  toneReasoning: string;
  ctaType: CTAType;
  ctaText: string;
  ctaReasoning: string;
  sequenceType: SequenceType;
  outreachApproach: string;
  sequenceReasoning: string;
  touches: SequenceTouchPlan[];
}

function normalizeScore(value?: number | null): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, value));
}

function roleSignals(input: SequenceStrategyInput) {
  const role = `${input.recipientRole ?? ""} ${input.recipientTitle ?? ""}`.toLowerCase();
  return {
    isExecutive: /\b(ceo|cfo|coo|chief|vp|president|director|head)\b/.test(role),
    isFounder: /\b(founder|co-founder|owner)\b/.test(role),
    isTechnical: /\b(engineer|engineering|developer|cto|architect|devops|technical|it)\b/.test(role),
    isOps: /\b(operations|ops|revenue operations|sales ops|marketing ops|enablement)\b/.test(role),
  };
}

function isStartupLike(input: SequenceStrategyInput): boolean {
  const size = String(input.companySize ?? "").toLowerCase();
  return /\b(startup|seed|series a|small|1-50|11-50|51-200)\b/.test(size);
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

export function selectBestCTA(input: SequenceStrategyInput): {
  ctaType: CTAType;
  ctaText: string;
  reasoning: string;
} {
  if (input.preferredCtaType) {
    return {
      ctaType: input.preferredCtaType,
      ctaText: ctaTextForType(input.preferredCtaType),
      reasoning: "User preference override applied.",
    };
  }

  const score = normalizeScore(input.leadScore);
  const role = roleSignals(input);

  if (role.isFounder || role.isExecutive) {
    return {
      ctaType: score >= 70 ? "curiosity_cta" : "direct_cta",
      ctaText: score >= 70 ? ctaTextForType("curiosity_cta") : ctaTextForType("direct_cta"),
      reasoning: "Executive audiences do best with short, low-friction asks.",
    };
  }

  if (role.isTechnical) {
    return {
      ctaType: "value_cta",
      ctaText: ctaTextForType("value_cta"),
      reasoning: "Technical buyers respond better to practical value than a direct meeting ask.",
    };
  }

  if (score >= 80) {
    return {
      ctaType: "soft_meeting_cta",
      ctaText: ctaTextForType("soft_meeting_cta"),
      reasoning: "Warmer leads can support a soft meeting CTA.",
    };
  }

  if (score <= 35) {
    return {
      ctaType: "reply_cta",
      ctaText: ctaTextForType("reply_cta"),
      reasoning: "Colder leads should stay in a low-commitment reply lane.",
    };
  }

  return {
    ctaType: "curiosity_cta",
    ctaText: ctaTextForType("curiosity_cta"),
    reasoning: "Defaulting to a curiosity CTA keeps cold outreach low-pressure.",
  };
}

export function selectBestTone(input: SequenceStrategyInput): {
  tone: ToneType;
  reasoning: string;
} {
  if (input.preferredTone) {
    return { tone: input.preferredTone, reasoning: "User preference override applied." };
  }

  const role = roleSignals(input);

  if (role.isTechnical) {
    return {
      tone: "technical_advisor",
      reasoning: "Technical contacts prefer practical, detail-aware outreach.",
    };
  }
  if (role.isFounder && isStartupLike(input)) {
    return {
      tone: "friendly_human",
      reasoning: "Startup founders respond better to human, direct founder-style outreach.",
    };
  }
  if (role.isFounder) {
    return {
      tone: "founder_style",
      reasoning: "Founders respond best to concise, peer-like communication.",
    };
  }
  if (role.isExecutive) {
    return {
      tone: "concise_enterprise",
      reasoning: "Enterprise executives typically prefer concise business framing.",
    };
  }
  if (role.isOps) {
    return {
      tone: "consultant_style",
      reasoning: "Operations buyers often respond well to diagnostic, consultant-style messaging.",
    };
  }
  return {
    tone: "friendly_human",
    reasoning: "Defaulting to a friendly human tone keeps outreach readable and low-pressure.",
  };
}

export function selectBestSequenceType(input: SequenceStrategyInput): {
  sequenceType: SequenceType;
  outreachApproach: string;
  reasoning: string;
} {
  if (input.preferredSequenceType) {
    return {
      sequenceType: input.preferredSequenceType,
      outreachApproach: outreachApproachForType(input.preferredSequenceType),
      reasoning: "User preference override applied.",
    };
  }

  const score = normalizeScore(input.leadScore);
  const intent = String(input.intent ?? "").toLowerCase();
  const role = roleSignals(input);

  if (role.isFounder || isStartupLike(input)) {
    return {
      sequenceType: "founder_outreach",
      outreachApproach: "peer-style, short founder-led sequence",
      reasoning: "Founder and startup outreach benefits from founder-style sequencing.",
    };
  }
  if (score >= 75 || /\bwarm|followup|follow-up\b/.test(intent)) {
    return {
      sequenceType: "warm_followup",
      outreachApproach: "gentle follow-up with progressive meeting readiness",
      reasoning: "Warmer leads support a stronger but still respectful sequence.",
    };
  }
  if (score <= 35 || /\breengage|re-engage|revive\b/.test(intent)) {
    return {
      sequenceType: "reengagement",
      outreachApproach: "re-entry sequence with low pressure and clean opt-out energy",
      reasoning: "Stale or colder leads need a lower-pressure reengagement path.",
    };
  }
  return {
    sequenceType: "cold_outreach",
    outreachApproach: "short value-first cold outreach sequence",
    reasoning: "Cold outreach should be concise, value-aware, and progressively softer over time.",
  };
}

function ctaForTouch(baseCta: CTAType, touchNumber: number, includeBreakupEmail: boolean): CTAType {
  if (includeBreakupEmail && touchNumber === 4) return "no_pressure_cta";
  if (touchNumber === 3) return "value_cta";
  if (touchNumber === 2 && baseCta === "soft_meeting_cta") return "reply_cta";
  return baseCta;
}

function objectivesForType(sequenceType: SequenceType): Array<{ objective: string; subjectHint: string }> {
  switch (sequenceType) {
    case "warm_followup":
      return [
        { objective: "re-open warm conversation", subjectHint: "Quick follow-up" },
        { objective: "gently confirm interest", subjectHint: "Wanted to circle back" },
        { objective: "reinforce practical value", subjectHint: "One more thought" },
        { objective: "close the loop respectfully", subjectHint: "Should I close the loop?" },
      ];
    case "reengagement":
      return [
        { objective: "re-open conversation softly", subjectHint: "Checking back in" },
        { objective: "share a lighter reminder", subjectHint: "Still relevant?" },
        { objective: "restate value with low pressure", subjectHint: "Quick value point" },
        { objective: "final low-pressure breakup", subjectHint: "Happy to close the loop" },
      ];
    case "founder_outreach":
      return [
        { objective: "open peer-style conversation", subjectHint: "Founder to founder" },
        { objective: "follow up briefly", subjectHint: "Wanted to follow up" },
        { objective: "share one concrete example", subjectHint: "One practical example" },
        { objective: "final founder-style close", subjectHint: "Last note from me" },
      ];
    case "cold_outreach":
    default:
      return [
        { objective: "open conversation", subjectHint: "Quick question" },
        { objective: "gentle follow-up", subjectHint: "Quick follow-up" },
        { objective: "value reinforcement", subjectHint: "One idea for you" },
        { objective: "breakup / final attempt", subjectHint: "Should I close the loop?" },
      ];
  }
}

export function outreachApproachForType(type: SequenceType): string {
  switch (type) {
    case "warm_followup":
      return "gentle follow-up";
    case "reengagement":
      return "soft reengagement";
    case "founder_outreach":
      return "peer-to-peer founder outreach";
    case "cold_outreach":
    default:
      return "value-first cold outreach";
  }
}

export function generateSequencePlan(input: SequenceStrategyInput): SequencePlan {
  const includeBreakupEmail = input.includeBreakupEmail !== false;
  const sequenceLength = input.sequenceLength ?? (includeBreakupEmail ? 4 : 3);
  const tone = selectBestTone(input);
  const cta = selectBestCTA(input);
  const sequence = selectBestSequenceType(input);
  const objectives = objectivesForType(sequence.sequenceType);
  const delays = [0, 3, 7, 14];

  const touches = objectives
    .slice(0, sequenceLength)
    .filter((_, index) => includeBreakupEmail || index < 3)
    .map((meta, index, arr) => {
      const touchNumber = index + 1;
      const touchCtaType = ctaForTouch(cta.ctaType, touchNumber, includeBreakupEmail);
      const delayDays = delays[index] ?? delays[delays.length - 1] ?? 0;
      return {
        touchNumber,
        delayDays,
        objective: meta.objective,
        subjectHint: meta.subjectHint,
        tone: tone.tone,
        ctaType: touchCtaType,
        ctaText: ctaTextForType(touchCtaType),
        previousTouchSummary:
          index > 0
            ? `${arr[index - 1]?.objective ?? "previous touch"} using ${ctaForTouch(cta.ctaType, index, includeBreakupEmail).replace(/_/g, " ")}`
            : undefined,
      } satisfies SequenceTouchPlan;
    });

  return {
    tone: tone.tone,
    toneReasoning: tone.reasoning,
    ctaType: cta.ctaType,
    ctaText: cta.ctaText,
    ctaReasoning: cta.reasoning,
    sequenceType: sequence.sequenceType,
    outreachApproach: sequence.outreachApproach,
    sequenceReasoning: sequence.reasoning,
    touches,
  };
}
