/**
 * Deterministic MCP tool order after fetch_website_content for Phase 3 intents.
 */

import type { KnownToolName } from "../types/tools.js";

export type Phase3EnrichmentAction =
  | "analyze_company"
  | "detect_pain_points"
  | "generate_outreach"
  | "enrich_company";

export const PHASE3_TOOL_QUEUE: Record<Phase3EnrichmentAction, KnownToolName[]> = {
  analyze_company:    ["extract_company_profile"],
  detect_pain_points: ["detect_pain_points"],
  generate_outreach:  ["detect_pain_points", "generate_outreach_draft"],
  enrich_company:     [
    "extract_company_profile",
    "classify_industry",
    "detect_pain_points",
    "score_lead",
    "generate_outreach_draft",
  ],
};
