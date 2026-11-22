/**
 * summarize_replies — QA 15 Nov 2026: the summary used the quoted mail header ("On Fri, Oct 16, 2026 …
 * testing wrote") as keywords, and the agent invented themes from them. Keywords come only from what
 * people wrote, and the samples (their own words) go with the summary.
 */
import { describe, expect, it, vi } from "vitest";
import { summarizeRepliesTool } from "../../mcp/tools/inbox/summarizeReplies.tool.js";
import { createMockMailflowClient, createMockToolContext } from "../helpers.js";

describe("summarize_replies", () => {
  it("keywords and samples are what people wrote, with the campaign name", async () => {
    const listReplies = vi.fn().mockResolvedValue({
      items: [
        { id: "1", campaignId: "434", campaignName: "DRY RUN", fromEmail: "a@x.com", fromName: null, subject: "Re: HELLO", bodyText: "Yes", bodyHtml: null, status: "read", receivedAt: "2026-10-16T02:32:00Z" },
        { id: "2", campaignId: "434", campaignName: "DRY RUN", fromEmail: "b@x.com", fromName: null, subject: "Re: HELLO", bodyText: "YES BUDDY", bodyHtml: null, status: "read", receivedAt: "2026-10-16T02:32:00Z" },
      ],
      total: 2, page: 1, pageSize: 50, hasNextPage: false,
    });
    const ctx = createMockToolContext({ mailflow: createMockMailflowClient({ listReplies }) });
    const result = await summarizeRepliesTool.handler({ campaignId: "434", maxSample: 50 }, ctx);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(data.totalReplies).toBe(2);
    expect(data.campaignName).toBe("DRY RUN");
    expect(data.topKeywords).toEqual(["yes", "buddy"]);
    expect(data.samples).toEqual([
      expect.objectContaining({ from: "a@x.com", text: "Yes", campaign: "DRY RUN" }),
      expect.objectContaining({ from: "b@x.com", text: "YES BUDDY" }),
    ]);
  });

  it("dates and numbers are never keywords", async () => {
    const listReplies = vi.fn().mockResolvedValue({
      items: [{ id: "1", campaignId: "434", fromEmail: "a@x.com", fromName: null, subject: "", bodyText: "Fri Oct 16 2026 sounds good", bodyHtml: null, status: "read", receivedAt: "" }],
      total: 1, page: 1, pageSize: 50, hasNextPage: false,
    });
    const ctx = createMockToolContext({ mailflow: createMockMailflowClient({ listReplies }) });
    const result = await summarizeRepliesTool.handler({ campaignId: "434", maxSample: 50 }, ctx);
    expect((result as { data: { topKeywords: string[] } }).data.topKeywords).toEqual(["sounds", "good"]);
  });
});
