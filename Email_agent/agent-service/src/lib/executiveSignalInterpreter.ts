import { mapIndustryNarrative } from "./industryNarrativeMapper.js";
import { humanizeOutreachText } from "./outreachHumanizationEngine.js";
import { diversifyStrategicText, type LanguageVariationContext } from "./strategicLanguageVariation.js";

export interface InterpretedSignal {
  raw: string;
  interpretation: string;
  confidence: number;
}

export function interpretExecutiveSignal(
  rawSignal: string,
  context: LanguageVariationContext = {},
): string {
  const raw = rawSignal.trim().replace(/\s+/g, " ");
  if (!raw) return "Public signal is limited and should be verified before outreach.";

  const lower = raw.toLowerCase();
  const industryNarrative = mapIndustryNarrative({
    companyName: context.companyName,
    industry: context.industry,
    signals: [raw],
  });
  let interpreted: string;

  if (/operational website signal:\s*support/i.test(raw) || /\bsupport\b/.test(lower)) {
    interpreted = "Customer support and operational continuity appear strategically important in the company's positioning.";
  } else if (/\berp\b/.test(lower)) {
    interpreted = "The company appears to be investing in enterprise systems modernization, which usually raises the bar for integration planning and change management.";
  } else if (/\brelease|launch|product\b/.test(lower)) {
    interpreted = "Product activity creates a practical opening around launch readiness, buyer education, and customer follow-up.";
  } else if (/\bpartner|alliance|ecosystem\b/.test(lower)) {
    interpreted = "Partnership activity points to a broader go-to-market motion where account coordination and clear value messaging matter.";
  } else if (/\bcareer|hiring|open role|job\b/.test(lower)) {
    interpreted = "Visible hiring activity usually means the team is adding capacity and needs cleaner ways to keep work coordinated.";
  } else if (/\bai|machine learning|automation|intelligence\b/.test(lower)) {
    interpreted = "AI-related positioning is stronger when framed around adoption, governance, and measurable buyer value.";
  } else if (/\bfinance|billing|reconciliation|invoice|revenue cycle\b/.test(lower)) {
    interpreted = "Finance-facing language points to visibility, control, and exception handling as commercially relevant themes.";
  } else if (/\bcloud|devops|digital transformation|modernization\b/.test(lower)) {
    interpreted = "Modernization themes make integration effort, implementation planning, and cross-functional alignment commercially relevant.";
  } else if (/\benterprise|global|scale|scaling\b/.test(lower)) {
    interpreted = "Enterprise positioning increases the need for management visibility, buyer education, and consistent delivery across accounts.";
  } else {
    interpreted = `The public context around ${cleanSignalTopic(raw)} supports a careful executive conversation about ${industryNarrative.pressures[0] ?? "buyer relevance"} and ${industryNarrative.pressures[1] ?? "execution clarity"}.`;
  }

  return sanitizeSignalLanguage(humanizeOutreachText(diversifyStrategicText(interpreted, context), context));
}

export function interpretSignalList(
  rawSignals: string[],
  context: LanguageVariationContext = {},
  limit = 5,
): string[] {
  return unique(rawSignals)
    .slice(0, limit)
    .map((signal) => interpretExecutiveSignal(signal, context));
}

export function interpretSignalsWithConfidence(
  rawSignals: string[],
  context: LanguageVariationContext = {},
  baseConfidence = 66,
): InterpretedSignal[] {
  return unique(rawSignals).map((raw, index) => ({
    raw,
    interpretation: interpretExecutiveSignal(raw, { ...context, trigger: `${context.trigger ?? ""}:${index}` }),
    confidence: Math.min(92, baseConfidence + index * 3),
  }));
}

export function sanitizeSignalLanguage(value: string): string {
  return value
    .replace(/Operational website signal:\s*/gi, "")
    .replace(/\blanguage suggests\b/gi, "indicates")
    .replace(/\bsignals suggest\b/gi, "signals indicate")
    .replace(/\bsuggests\b/gi, "indicates")
    .replace(/\bexecution rhythm and context discipline\b/gi, "delivery coordination and buyer handoff clarity")
    .replace(/\bcampaign intelligence and operational readiness\b/gi, "account intelligence and campaign review quality")
    .replace(/\bcredible outreach angle\b/gi, "practical way into the conversation")
    .replace(/\bread-only view\b/gi, "short perspective")
    .replace(/\bpressure-testing\b/gi, "comparing notes")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSignalTopic(value: string): string {
  return value
    .replace(/^[A-Z][a-z]+ website signal:\s*/i, "")
    .replace(/[.:;]+$/g, "")
    .toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
