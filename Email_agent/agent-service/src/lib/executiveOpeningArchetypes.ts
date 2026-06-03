export interface OpeningArchetypeContext {
  companyName: string;
  persona: string;
  industry?: string;
  signals?: string[];
  offset?: number;
}

type OpeningArchetype =
  | "observation-led"
  | "growth-pressure-led"
  | "operational-friction-led"
  | "executive-risk-led"
  | "delivery-scale-led"
  | "engineering-coordination-led"
  | "finance-visibility-led"
  | "compliance-pressure-led"
  | "transformation-led"
  | "buyer-experience-led";

const ARCHETYPES: OpeningArchetype[] = [
  "observation-led",
  "growth-pressure-led",
  "operational-friction-led",
  "executive-risk-led",
  "delivery-scale-led",
  "engineering-coordination-led",
  "finance-visibility-led",
  "compliance-pressure-led",
  "transformation-led",
  "buyer-experience-led",
];

export function buildExecutiveOpening(input: OpeningArchetypeContext): string {
  const archetype = chooseArchetype(input);
  const company = input.companyName;
  const persona = input.persona;
  const industry = (input.industry ?? "").toLowerCase();

  if (archetype === "finance-visibility-led" || /\b(finance|lending|leasing|fintech|banking)\b/.test(industry)) {
    return `${company} appears to sit in a market where ${persona} has to keep financial workflow complexity, compliance expectations, and buyer clarity moving together.`;
  }

  if (archetype === "engineering-coordination-led" || /\b(product engineering|software|innovation|engineering)\b/.test(industry)) {
    return `For ${company}, the sharper outreach path is likely around how product and engineering teams keep delivery priorities clear as client expectations expand.`;
  }

  if (archetype === "compliance-pressure-led" || /\b(healthcare|compliance|revenue cycle)\b/.test(industry)) {
    return `${company} looks like a company where buyer conversations need to respect implementation detail, compliance pressure, and the realities of support after the sale.`;
  }

  if (archetype === "transformation-led" || /\b(transformation|cloud|erp|enterprise it|managed services)\b/.test(industry)) {
    return `What stood out about ${company} is the need to connect transformation messaging with delivery visibility and governance that senior buyers can recognize quickly.`;
  }

  if (archetype === "growth-pressure-led") {
    return `As ${company} scales, the first outreach problem is usually not volume; it is making the buyer feel the note reflects the business they are actually running.`;
  }

  if (archetype === "operational-friction-led") {
    return `One thing that often shows up for companies like ${company} is friction between the story sales tells and the work operations has to deliver.`;
  }

  if (archetype === "executive-risk-led") {
    return `For ${persona}, the risk is usually a message that sounds polished but misses the operational concern sitting behind the buying decision.`;
  }

  if (archetype === "delivery-scale-led") {
    return `${company} seems to have enough delivery complexity that outreach should speak to coordination, handoff clarity, and practical outcomes rather than broad automation language.`;
  }

  if (archetype === "buyer-experience-led") {
    return `The buyer experience around ${company} likely depends on whether the first conversation makes the operational value clear without forcing prospects to connect the dots themselves.`;
  }

  return `Reviewing ${company}, the stronger opening is a grounded business note for ${persona}, tied to visible operating priorities rather than a generic campaign message.`;
}

function chooseArchetype(input: OpeningArchetypeContext): OpeningArchetype {
  const index = stableSeed([
    input.companyName,
    input.persona,
    input.industry,
    ...(input.signals ?? []),
    String(input.offset ?? 0),
  ]) % ARCHETYPES.length;
  return ARCHETYPES[index] ?? "observation-led";
}

function stableSeed(parts: Array<string | undefined>): number {
  const text = parts.filter(Boolean).join("|");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 43 + text.charCodeAt(i)) % 15401;
  return Math.abs(hash);
}
