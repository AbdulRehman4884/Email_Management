import { describe, expect, it } from "vitest";
import { managerNode, routeToAgent } from "../manager.node.js";
import { isStandaloneCommand } from "../../../lib/busyWorkflow.js";
import type { AgentGraphStateType } from "../../state/agentGraph.state.js";

function state(overrides: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userMessage: "",
    sessionId: "s1",
    userId: "u1",
    messages: [],
    confidence: 1,
    toolArgs: {},
    requiresApproval: false,
    planIndex: 0,
    planResults: [],
    pendingPhase3ContinueExecute: false,
    ...overrides,
  } as AgentGraphStateType;
}

describe("manager busy guard", () => {
  it("does not let a chip command become the AI wizard's answer", async () => {
    const s = state({ intent: "list_campaigns", userMessage: "Show all campaigns", pendingAiCampaignStep: "name" as never });

    const patch = await managerNode(s);
    const body = JSON.parse(patch.formattedResponse!);

    expect(body.status).toBe("busy");
    expect(body.message).toContain("AI campaign setup");
    expect(body.message).toContain("cancel");
    // Flow state is left untouched and the reply goes straight to the user.
    expect(patch.pendingAiCampaignStep).toBeUndefined();
    expect(routeToAgent({ ...s, ...patch })).toBe("formatResponse");
  });

  it.each([
    ["contact enrichment review", { pendingEnrichmentStep: "confirm" }, "show inbox replies"],
    ["bulk campaign workflow", { bulkWorkflow: { jobId: 1, currentStep: "x" } }, "Campaign stats"],
  ])("blocks other commands during %s", async (label, flow, message) => {
    const patch = await managerNode(state({ intent: "general_help", userMessage: message, ...(flow as object) }));
    expect(JSON.parse(patch.formattedResponse!).message).toContain(label);
  });

  it("still accepts real wizard answers", async () => {
    for (const answer of ["Summer Sale 2024", "Exclusive 30% off this weekend", "yes", "cancel"]) {
      const patch = await managerNode(state({ intent: "create_ai_campaign", userMessage: answer, pendingAiCampaignStep: "name" as never }));
      expect(patch.formattedResponse).toBeUndefined();
      expect(patch.agentDomain).toBe("campaign");
    }
  });

  it("does nothing when no flow is in progress", async () => {
    const patch = await managerNode(state({ intent: "list_campaigns", userMessage: "Show all campaigns" }));
    expect(patch.formattedResponse).toBeUndefined();
  });
});

describe("a new question while a campaign list is open (bugs A-05, A-19)", () => {
  const okList = Array.from({ length: 8 }, (_, i) => ({ id: String(430 + i), name: "ok", status: "completed" }));
  const pausedList = [
    { id: "1", name: "ALL", status: "paused" },
    { id: "2", name: "QA-TEST Daily limit 1 - do not use", status: "paused" },
    { id: "3", name: "ok", status: "paused" },
  ];

  it("routes help to the help response instead of treating it as a campaign selection", async () => {
    const patch = await managerNode(state({
      intent: "general_help", userMessage: "What can you help me with?", campaignSelectionList: pausedList,
    }));
    expect(patch.agentDomain).toBe("general");
    expect(routeToAgent({ intent: "general_help", ...patch } as AgentGraphStateType)).toBe("formatResponse");
  });

  it("'How many draft campaigns do I have?' after 'which ok campaign?' drops the list and answers it", async () => {
    const s = state({
      intent: "list_campaigns",
      userMessage: "How many draft campaigns do I have?",
      pendingCampaignAction: "get_campaign_stats",
      campaignSelectionList: okList,
    });
    const patch = await managerNode(s);
    expect(patch.formattedResponse).toBeUndefined();
    expect(patch.agentDomain).toBe("campaign");
    expect("pendingCampaignAction" in patch && patch.pendingCampaignAction).toBeFalsy();
    expect("campaignSelectionList" in patch && patch.campaignSelectionList).toBeFalsy();
    expect("campaignSelectionList" in patch).toBe(true);
  });

  it("a recipient-count question after a status-filtered list goes to its own answer, not the campaign agent", async () => {
    const s = state({ intent: "recipient_status_help", userMessage: "How many recipients does DRY RUN have?", campaignSelectionList: pausedList });
    const patch = await managerNode(s);
    expect(patch.campaignSelectionList).toBeUndefined();
    expect("campaignSelectionList" in patch).toBe(true);
    expect(routeToAgent({ ...s, ...patch })).toBe("formatResponse");
  });

  it("a recipient-count question after looking at one campaign is answered, not turned into the campaign menu", async () => {
    const s = state({ intent: "recipient_status_help", userMessage: "How many recipients does Test Campaign 1 have?", activeCampaignId: "434" });
    const patch = await managerNode(s);
    expect(routeToAgent({ ...s, ...patch })).toBe("formatResponse");
  });

  it("a chip command no longer gets a 'busy' popup — the list is dropped", async () => {
    const s = state({ intent: "check_smtp", userMessage: "Check SMTP configuration", pendingCampaignAction: "pause_campaign", campaignSelectionList: pausedList });
    const patch = await managerNode(s);
    expect(patch.formattedResponse).toBeUndefined();
    expect("pendingCampaignAction" in patch).toBe(true);
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it.each([
    ["a number", "3", "general_help"],
    ["an id", "#431", "general_help"],
    ["the exact name", "ok", "out_of_domain"],
    ["cancel", "cancel", "pause_campaign"],
    ["the same action with a name", "show stats for ok", "get_campaign_stats"],
  ])("keeps the list for a real answer: %s", async (_label, userMessage, intent) => {
    const s = state({ intent: intent as never, userMessage, pendingCampaignAction: "get_campaign_stats", campaignSelectionList: [...okList, { id: "431", name: "Campaign 3", status: "draft" }] });
    const patch = await managerNode(s);
    expect("campaignSelectionList" in patch).toBe(false);
    expect("pendingCampaignAction" in patch).toBe(false);
  });
});

describe("isStandaloneCommand", () => {
  it("matches whole command messages only", () => {
    expect(isStandaloneCommand("Show all campaigns")).toBe(true);
    expect(isStandaloneCommand("  check SMTP configuration! ")).toBe(true);
    expect(isStandaloneCommand("Show all campaigns from last summer sale")).toBe(false);
    expect(isStandaloneCommand("Summer campaign")).toBe(false);
  });
});

describe("chat campaign creation", () => {
  it("the uploaded file goes to the campaign creation flow, not to contact enrichment", async () => {
    const s = state({
      intent: "create_campaign",
      userMessage: "here is my file",
      campaignCreation: { step: "file", name: "Test_compain", atIso: new Date().toISOString() },
      pendingCsvFile: { filename: "Email_Campaign_Example_links.xlsx", fileContent: "eA==" },
    });
    const patch = await managerNode(s);
    expect(patch.agentDomain).toBe("campaign");
    expect(routeToAgent({ ...s, ...patch })).toBe("campaign");
  });

  it("without the flow, an attached file still goes to enrichment as before", async () => {
    const s = state({ intent: "upload_csv", userMessage: "", pendingCsvFile: { filename: "a.csv", fileContent: "eA==" } });
    const patch = await managerNode(s);
    expect(patch.agentDomain).toBe("enrichment");
  });
});
