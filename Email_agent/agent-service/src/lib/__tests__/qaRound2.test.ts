import { describe, expect, it, vi } from "vitest";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService:   () => undefined,
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { campaignStatusFilter, filterCampaignsByStatus } from "../accountStats.js";
import { recipientCountAnswer } from "../recipientCount.js";
import { approvalFactLines } from "../approvalFacts.js";
import { formatChatSuccess } from "../agentResponseFormatter.js";
import { finalResponseNode } from "../../graph/nodes/finalResponse.node.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

const ok = (data: unknown) => ({ data: { success: true, data }, isToolError: false, rawContent: [] });
const campaigns = [
  { id: "20", name: "Campaign 3", status: "completed", recipientCount: 25 },
  { id: "18", name: "Nothing", status: "draft", recipientCount: 0 },
  { id: "17", name: "Damo", status: "running", recipientCount: 4 },
];

describe("A-19 status filter on the campaign list", () => {
  it("reads the status the user asked for", () => {
    expect(campaignStatusFilter("Show completed campaigns only")).toEqual({ status: "completed", label: "completed" });
    expect(campaignStatusFilter("list my draft campaigns")).toEqual({ status: "draft", label: "draft" });
    expect(campaignStatusFilter("show active campaigns")).toEqual({ status: "running", label: "running" });
    expect(campaignStatusFilter("Show all campaigns")).toBeUndefined();
    expect(filterCampaignsByStatus([{ status: "in_progress" }, { status: "draft" }], "running")).toEqual([{ status: "in_progress" }]);
  });

  it("list shows only the asked status", async () => {
    const out = await finalResponseNode({
      intent: "list_campaigns", toolName: "get_all_campaigns", toolArgs: {}, userId: "2", rawToken: "t",
      userMessage: "Show completed campaigns only",
      toolResult: ok(campaigns),
    } as unknown as AgentGraphStateType);
    const text = String(out.finalResponse);
    expect(text).toContain("Here are your completed campaigns (1):");
    expect(text).toContain("Campaign 3");
    expect(text).not.toContain("Nothing");
  });
});

describe("A-19 recipient count by campaign name", () => {
  const base = { userId: "2", rawToken: "t" };

  it("'How many recipients does Campaign 3 have?' → its count", async () => {
    mockDispatch.mockResolvedValueOnce(ok(campaigns));
    expect(await recipientCountAnswer({ ...base, userMessage: "How many recipients does Campaign 3 have?" }))
      .toBe("**Campaign 3** (#20) has **25 recipients**.");
  });

  it("zero recipients says how to add them; id works too", async () => {
    mockDispatch.mockResolvedValueOnce(ok(campaigns));
    expect(await recipientCountAnswer({ ...base, userMessage: "how many recipients in campaign id 18?" }))
      .toContain("has **0 recipients**. Upload a CSV");
  });

  it("no campaign named and none active → undefined (keeps the old guidance)", async () => {
    expect(await recipientCountAnswer({ ...base, userMessage: "How many recipients do I have?" })).toBeUndefined();
  });

  it("unknown name → says so", async () => {
    mockDispatch.mockResolvedValueOnce(ok(campaigns));
    expect(await recipientCountAnswer({ ...base, userMessage: "How many recipients does Black Friday have?" }))
      .toContain("I couldn't find a campaign named **Black Friday**");
  });
});

describe("A-14 pause approval card", () => {
  it("names the campaign and skips the recipients warning", () => {
    expect(approvalFactLines({ campaignId: "17", name: "Damo", recipients: 0, pausing: true })).toEqual(["**Campaign:** Damo (#17)"]);
  });
});

describe("N-22 chat response does not carry campaign HTML", () => {
  it("strips body/emailContent from lists but keeps single objects", () => {
    const list = formatChatSuccess("s", "ok", { data: { success: true, data: [{ id: "1", name: "A", body: "<html>…</html>", emailContent: "<p>x</p>" }] }, isToolError: false });
    expect(JSON.stringify(list.toolResult)).not.toContain("<html>");
    expect(JSON.stringify(list.toolResult)).toContain('"name":"A"');

    const single = formatChatSuccess("s", "ok", { data: { success: true, data: { id: "1", body: "<p>keep</p>" } }, isToolError: false });
    expect(JSON.stringify(single.toolResult)).toContain("<p>keep</p>");
  });
});

describe("A-01 Roman Urdu name without the word campaign", () => {
  it("reads the name; account/pronouns are not names", async () => {
    const { campaignNameFrom } = await import("../campaignLookup.js");
    expect(campaignNameFrom(undefined, "Proving AI Services ke stats dikhao")).toBe("Proving AI Services");
    expect(campaignNameFrom(undefined, "account ke stats dikhao")).toBeUndefined();
    expect(campaignNameFrom(undefined, "meri campaign ki stats dikhao")).toBeUndefined();
  });
});

describe("A-14 card warns when the status doesn't fit the action", () => {
  it("pausing a paused campaign / resuming a running one", () => {
    expect(approvalFactLines({ campaignId: "17", name: "Damo", pausing: true, action: "pause_campaign", status: "paused" }).join("\n"))
      .toContain("is **paused**, not running");
    expect(approvalFactLines({ campaignId: "21", action: "resume_campaign", status: "running", recipients: 3 }).join("\n"))
      .toContain("can't be resumed");
    expect(approvalFactLines({ campaignId: "21", name: "Live", pausing: true, action: "pause_campaign", status: "running" }))
      .toEqual(["**Campaign:** Live (#21)"]);
  });
});
