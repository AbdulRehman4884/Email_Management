import { describe, expect, it, vi } from "vitest";
import { getAllCampaignsTool } from "../../mcp/tools/campaign/getAllCampaigns.tool.js";
import { GetAllCampaignsSchema } from "../../schemas/campaign.schemas.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";

// QA P4 bug 18: "Show campaigns tagged QA-Auto" listed every campaign.
const campaigns = [
  { id: "1", name: "A", status: "draft" },
  { id: "2", name: "B", status: "paused" },
  { id: "3", name: "C", status: "completed" },
];
const tagMap = {
  tags: [
    { id: 7, name: "QA-E2E", color: "#000", scope: "campaign", contactCount: 0, campaignCount: 2, createdAt: "" },
    { id: 8, name: "QA-Auto", color: "#000", scope: "both", contactCount: 0, campaignCount: 0, createdAt: "" },
  ],
  campaigns: { "1": [7], "3": [7] },
};

function ctx() {
  return createMockToolContext({
    mailflow: createMockMailflowClient({
      getAllCampaigns: vi.fn().mockResolvedValue(campaigns),
      getCampaignTagMap: vi.fn().mockResolvedValue(tagMap),
    }),
  });
}

describe("get_all_campaigns — tag filter", () => {
  it("'qa e2e' keeps only the tagged campaigns", async () => {
    const result = await getAllCampaignsTool.handler(GetAllCampaignsSchema.parse({ tag: "qa e2e" }), ctx());
    expect(result).toMatchObject({ success: true, data: [{ id: "1" }, { id: "3" }] });
  });

  it("a tag no campaign has (QA-Auto) → empty list", async () => {
    const result = await getAllCampaignsTool.handler({ tag: "QA-Auto" }, ctx());
    expect(result).toMatchObject({ success: true, data: [] });
  });

  it("no tag → every campaign, tag map not read", async () => {
    const c = ctx();
    const result = await getAllCampaignsTool.handler({}, c);
    expect(result).toMatchObject({ success: true, data: campaigns });
    expect(c.mailflow.getCampaignTagMap).not.toHaveBeenCalled();
  });
});
