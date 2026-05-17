/**
 * src/mcp/tools/enrichment/scoreLead.tool.ts
 *
 * Deterministic lead scoring — no external API calls.
 * Combines email quality, role seniority, company completeness,
 * industry tier, and website presence into a 0–100 score.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ScoreLeadSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

const HIGH_VALUE_INDUSTRIES = new Set([
  "Technology", "Finance & Banking", "Insurance",
  "Healthcare", "Consulting", "Legal Services",
]);
const MEDIUM_VALUE_INDUSTRIES = new Set([
  "Real Estate", "Retail & E-commerce", "Media & Creative",
  "Energy", "Logistics & Supply Chain",
]);

const EXEC_KEYWORDS   = ["ceo", "coo", "cfo", "cto", "ciso", "president", "founder", "owner", "partner", "managing director"];
const SENIOR_KEYWORDS = ["vp", "vice president", "director", "head of", "principal", "chief"];
const MID_KEYWORDS    = ["manager", "lead", "senior", "sr.", "supervisor"];

function scoreRole(role: string | undefined): { points: number; reason: string } {
  if (!role?.trim()) return { points: 0, reason: "" };
  const r = role.toLowerCase();
  if (EXEC_KEYWORDS.some((k) => r.includes(k)))   return { points: 30, reason: `Executive role: ${role}` };
  if (SENIOR_KEYWORDS.some((k) => r.includes(k))) return { points: 20, reason: `Senior role: ${role}` };
  if (MID_KEYWORDS.some((k) => r.includes(k)))    return { points: 10, reason: `Mid-level role: ${role}` };
  return { points: 5, reason: `Role identified: ${role}` };
}

export interface ScoreLeadResult {
  score: number;
  priority: "hot" | "warm" | "cold";
  reasons: string[];
}

export const scoreLeadTool: McpToolDefinition<
  typeof ScoreLeadSchema,
  ScoreLeadResult
> = {
  name: TOOL_NAMES.SCORE_LEAD,

  description:
    "Scores a lead on a 0–100 scale using signals: email type, role seniority, " +
    "company presence, industry value, and website. No external API calls. " +
    "Returns score, priority (hot/warm/cold), and reasons.",

  inputSchema: ScoreLeadSchema,

  handler: async (input, context) => {
    const { name, email, company, role, industry, website, hasBusinessEmail } = input;
    let score = 0;
    const reasons: string[] = [];

    // Email quality — up to 25 pts
    if (email?.trim()) {
      if (hasBusinessEmail === true) {
        score += 25;
        reasons.push("Business email address");
      } else if (hasBusinessEmail === false) {
        score += 5;
        reasons.push("Personal email address (lower quality)");
      } else {
        score += 10;
        reasons.push("Email provided (type unknown)");
      }
    }

    // Name completeness — up to 5 pts
    if (name?.trim()) {
      const parts = name.trim().split(/\s+/);
      score += parts.length >= 2 ? 5 : 2;
      reasons.push(parts.length >= 2 ? "Full name available" : "Partial name available");
    }

    // Role seniority — up to 30 pts
    const roleScore = scoreRole(role);
    if (roleScore.points > 0) {
      score += roleScore.points;
      reasons.push(roleScore.reason);
    }

    // Industry value — up to 20 pts
    if (industry?.trim()) {
      if (HIGH_VALUE_INDUSTRIES.has(industry)) {
        score += 20;
        reasons.push(`High-value industry: ${industry}`);
      } else if (MEDIUM_VALUE_INDUSTRIES.has(industry)) {
        score += 10;
        reasons.push(`Medium-value industry: ${industry}`);
      } else {
        score += 5;
        reasons.push(`Industry: ${industry}`);
      }
    }

    // Company and website — up to 10 pts
    if (company?.trim()) { score += 5; reasons.push("Company name available"); }
    if (website?.trim()) { score += 5; reasons.push("Company website available"); }

    score = Math.min(100, Math.max(0, score));
    const priority: "hot" | "warm" | "cold" =
      score >= 60 ? "hot" : score >= 30 ? "warm" : "cold";

    context.log.debug({ score, priority }, "scoreLead: result");
    return toolSuccess<ScoreLeadResult>({ score, priority, reasons });
  },
};
