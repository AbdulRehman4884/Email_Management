/**
 * src/mcp/tools/enrichment/selectOfficialWebsite.tool.ts
 *
 * Scores a list of candidate websites and identifies which is most likely
 * to be the official company website.
 *
 * Intended to be called after search_company_web with its returned candidates.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SelectOfficialWebsiteSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import { scoreAndSelect } from "../../../services/enrichment/officialWebsiteSelector.service.js";
import type { ScoredCandidate } from "../../../services/enrichment/officialWebsiteSelector.service.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export interface SelectOfficialWebsiteResult {
  companyName:    string;
  selected:       ScoredCandidate | null;
  allCandidates:  ScoredCandidate[];
  selectionMade:  boolean;
}

export const selectOfficialWebsiteTool: McpToolDefinition<
  typeof SelectOfficialWebsiteSchema,
  SelectOfficialWebsiteResult
> = {
  name: TOOL_NAMES.SELECT_OFFICIAL_WEBSITE,

  description:
    "Scores a list of candidate website URLs and selects the most likely official website " +
    "for the given company. Uses domain similarity, title matching, HTTPS, location match, " +
    "and social-domain filtering. Returns the top-scored URL and the full ranked list.",

  inputSchema: SelectOfficialWebsiteSchema,

  handler: async (input, context) => {
    const { companyName, candidates, location, country } = input;
    context.log.debug({ companyName, candidateCount: candidates.length }, "select_official_website: starting");

    const scored   = scoreAndSelect(companyName, candidates, {
      ...(location !== undefined && { location }),
      ...(country  !== undefined && { country }),
    });
    const selected = scored.find((c) => c.selected) ?? null;

    context.log.info(
      { companyName, selected: selected?.url ?? "none", topScore: scored[0]?.score },
      "select_official_website: complete",
    );

    return toolSuccess({
      companyName,
      selected,
      allCandidates: scored,
      selectionMade: selected !== null,
    });
  },
};
