/**
 * src/graph/__tests__/routing.test.ts
 *
 * Isolated unit tests for the graph routing functions.
 *
 * Tests the `routeToAgent` conditional-edge function from manager.node.ts
 * directly — without invoking the full compiled graph. This keeps the tests
 * fast and deterministic, and makes routing regressions immediately obvious
 * without having to trace through a full graph execution.
 *
 * Key invariants verified:
 *   - "settings" domain routes to "campaign" (CampaignAgent owns SMTP intents)
 *   - "general" domain routes to "formatResponse" (no tool execution)
 *   - undefined/unknown domain routes to "formatResponse" (defensive fallback)
 *   - Every domain that maps to a real agent node routes to exactly one destination
 */

import { describe, it, expect } from "vitest";
import { routeToAgent, managerNode } from "../nodes/manager.node.js";
import { INTENT_DOMAIN } from "../../config/intents.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { Intent } from "../../config/intents.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal state stub with only agentDomain set. */
function stateWithDomain(
  agentDomain: AgentGraphStateType["agentDomain"],
): AgentGraphStateType {
  return {
    messages:         [],
    userMessage:      "",
    sessionId:        "s" as AgentGraphStateType["sessionId"],
    userId:           "u" as AgentGraphStateType["userId"],
    rawToken:         "tok",
    intent:           "general_help",
    confidence:       1,
    agentDomain,
    toolName:         undefined,
    toolArgs:         undefined,
    toolResult:       undefined,
    requiresApproval: false,
    pendingActionId:  undefined,
    formatResponse:    undefined,
    error:            undefined,
    activeCampaignId: undefined,
    llmExtractedArgs: undefined,
    plan:             undefined,
    planIndex:        0,
    planResults:      [],
  };
}

/** Build a minimal state stub for managerNode tests. */
function makeManagerState(
  partial: Partial<AgentGraphStateType>,
): AgentGraphStateType {
  return {
    messages:              [],
    userMessage:           "",
    sessionId:             "s" as AgentGraphStateType["sessionId"],
    userId:                "u" as AgentGraphStateType["userId"],
    rawToken:              "tok",
    intent:                "general_help",
    confidence:            1,
    agentDomain:           undefined,
    toolName:              undefined,
    toolArgs:              {},
    toolResult:            undefined,
    requiresApproval:      false,
    pendingActionId:       undefined,
    finalResponse:         undefined,
    error:                 undefined,
    activeCampaignId:      undefined,
    senderDefaults:        undefined,
    pendingCampaignDraft:  undefined,
    pendingCampaignStep:   undefined,
    pendingCampaignAction: undefined,
    campaignSelectionList: undefined,
    pendingScheduledAt:    undefined,
    pendingAiCampaignStep: undefined,
    pendingAiCampaignData: undefined,
    llmExtractedArgs:      undefined,
    plan:                  undefined,
    planIndex:             0,
    planResults:           [],
    ...partial,
  } as AgentGraphStateType;
}

// ── routeToAgent ──────────────────────────────────────────────────────────────

describe("routeToAgent", () => {
  // ── Domain → node mappings ───────────────────────────────────────────────

  it("routes 'campaign' domain to 'campaign' node", () => {
    expect(routeToAgent(stateWithDomain("campaign"))).toBe("campaign");
  });

  it("routes 'analytics' domain to 'analytics' node", () => {
    expect(routeToAgent(stateWithDomain("analytics"))).toBe("analytics");
  });

  it("routes 'inbox' domain to 'inbox' node", () => {
    expect(routeToAgent(stateWithDomain("inbox"))).toBe("inbox");
  });

  // ── Settings → campaign aliasing ─────────────────────────────────────────

  it("routes 'settings' domain to 'campaign' node (CampaignAgent owns SMTP intents)", () => {
    // This is a critical routing rule: update_smtp and check_smtp both live
    // under INTENT_DOMAIN as "settings", but CampaignAgent handles them.
    // Any change to this mapping must be intentional.
    expect(routeToAgent(stateWithDomain("settings"))).toBe("campaign");
  });

  // ── General / fallback paths ─────────────────────────────────────────────

  it("routes 'general' domain to 'formatResponse' (no tool execution for general_help)", () => {
    expect(routeToAgent(stateWithDomain("general"))).toBe("formatResponse");
  });

  it("routes undefined domain to 'formatResponse' (defensive fallback)", () => {
    expect(routeToAgent(stateWithDomain(undefined))).toBe("formatResponse");
  });

  it("routes unknown domain string to 'formatResponse' (defensive fallback)", () => {
    // Cast through unknown to simulate a future domain not yet in the switch
    const unknownDomain = "future_domain" as AgentGraphStateType["agentDomain"];
    expect(routeToAgent(stateWithDomain(unknownDomain))).toBe("formatResponse");
  });

  // ── INTENT_DOMAIN consistency ─────────────────────────────────────────────
  // Ensure every intent in the config maps to a domain that routeToAgent handles.

  it("every campaign-domain intent maps to 'campaign' route via INTENT_DOMAIN", () => {
    const campaignIntents: Intent[] = [
      "create_campaign",
      "update_campaign",
      "start_campaign",
      "pause_campaign",
      "resume_campaign",
    ];
    for (const intent of campaignIntents) {
      const domain = INTENT_DOMAIN[intent];
      expect(domain).toBe("campaign");
      expect(routeToAgent(stateWithDomain(domain))).toBe("campaign");
    }
  });

  it("check_smtp and update_smtp map to 'settings' domain which routes to 'campaign'", () => {
    for (const intent of ["check_smtp", "update_smtp"] as Intent[]) {
      const domain = INTENT_DOMAIN[intent];
      expect(domain).toBe("settings");
      // This is the key test: settings → campaign node
      expect(routeToAgent(stateWithDomain(domain))).toBe("campaign");
    }
  });

  it("get_campaign_stats maps to 'analytics' domain which routes to 'analytics'", () => {
    const domain = INTENT_DOMAIN["get_campaign_stats"];
    expect(domain).toBe("analytics");
    expect(routeToAgent(stateWithDomain(domain))).toBe("analytics");
  });

  it("list_replies and summarize_replies map to 'inbox' domain which routes to 'inbox'", () => {
    for (const intent of ["list_replies", "summarize_replies"] as Intent[]) {
      const domain = INTENT_DOMAIN[intent];
      expect(domain).toBe("inbox");
      expect(routeToAgent(stateWithDomain(domain))).toBe("inbox");
    }
  });

  it("general_help maps to 'general' domain which routes to 'formatResponse'", () => {
    const domain = INTENT_DOMAIN["general_help"];
    expect(domain).toBe("general");
    expect(routeToAgent(stateWithDomain(domain))).toBe("formatResponse");
  });

  // ── Return values are one of the four valid AgentRoute destinations ───────

  it("only ever returns one of the four valid AgentRoute values", () => {
    const validRoutes = new Set(["campaign", "analytics", "inbox", "formatResponse"]);
    const testDomains: AgentGraphStateType["agentDomain"][] = [
      "campaign", "analytics", "inbox", "settings", "general", undefined,
    ];
    for (const domain of testDomains) {
      const route = routeToAgent(stateWithDomain(domain));
      expect(validRoutes.has(route)).toBe(true);
    }
  });
});

// ── managerNode context-based routing overrides ───────────────────────────────

describe("managerNode — context-based routing overrides", () => {
  it("general_help with no context → agentDomain stays 'general'", async () => {
    const patch = await managerNode(makeManagerState({ intent: "general_help" }));
    expect(patch.agentDomain).toBe("general");
  });

  it("general_help + activeCampaignId → agentDomain overridden to 'campaign'", async () => {
    const patch = await managerNode(makeManagerState({
      intent:           "general_help",
      activeCampaignId: "6",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("out_of_domain + activeCampaignId → overridden to 'campaign'", async () => {
    const patch = await managerNode(makeManagerState({
      intent:           "out_of_domain",
      activeCampaignId: "6",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("next_step_help + activeCampaignId → overridden to 'campaign'", async () => {
    const patch = await managerNode(makeManagerState({
      intent:           "next_step_help",
      activeCampaignId: "6",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("activeCampaignId does NOT override analytics/inbox intents", async () => {
    const analyticsPatch = await managerNode(makeManagerState({
      intent:           "get_campaign_stats",
      activeCampaignId: "6",
    }));
    expect(analyticsPatch.agentDomain).toBe("analytics");

    const inboxPatch = await managerNode(makeManagerState({
      intent:           "list_replies",
      activeCampaignId: "6",
    }));
    expect(inboxPatch.agentDomain).toBe("inbox");
  });

  it("campaignSelectionList (no pendingCampaignAction) + general_help → overridden to 'campaign'", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "general_help",
      campaignSelectionList: [{ id: "10", name: "Summer Sale", status: "draft" }],
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("campaignSelectionList WITH pendingCampaignAction → handled by existing selectionActive branch", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "general_help",
      pendingCampaignAction: "start_campaign",
      campaignSelectionList: [{ id: "10", name: "Summer Sale", status: "draft" }],
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("aiWizardActive takes priority over activeCampaignId override", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "general_help",
      pendingAiCampaignStep: "recipient_source",
      activeCampaignId:      "6",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  // ── Strengthened selectionActive — domain-based (issue 4) ────────────────────

  it("pendingCampaignAction + next_step_help (general domain) → routes to campaign", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "next_step_help",
      pendingCampaignAction: "start_campaign",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("pendingCampaignAction + template_help (general domain) → routes to campaign", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "template_help",
      pendingCampaignAction: "start_campaign",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("pendingCampaignAction + out_of_domain (general domain) → routes to campaign", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "out_of_domain",
      pendingCampaignAction: "pause_campaign",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("pendingCampaignAction does NOT override analytics intent", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "get_campaign_stats",
      pendingCampaignAction: "start_campaign",
    }));
    expect(patch.agentDomain).toBe("analytics");
  });

  it("pendingCampaignAction does NOT override inbox intent", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "list_replies",
      pendingCampaignAction: "start_campaign",
    }));
    expect(patch.agentDomain).toBe("inbox");
  });

  // ── Scheduling intelligence (issue 5) ────────────────────────────────────────
  // Scheduling phrases ("tomorrow", "10 am") classify as general domain.
  // activeCampaignId override ensures they reach CampaignAgent.

  it("activeCampaignId + schedule-like general intent → routes to campaign (not formatResponse)", async () => {
    // Simulates: user says "tomorrow 10 AM" which LLM classifies as general_help
    const patch = await managerNode(makeManagerState({
      intent:           "general_help",
      activeCampaignId: "6",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("general_help NEVER falls through to formatResponse when activeCampaignId is set", async () => {
    const patch = await managerNode(makeManagerState({
      intent:           "general_help",
      activeCampaignId: "42",
    }));
    expect(patch.agentDomain).not.toBe("general");
    expect(patch.agentDomain).toBe("campaign");
  });
});

// ── Bug 2: cross-domain context cleanup ──────────────────────────────────────
// When the resolved domain is "enrichment", stale campaign workflow state
// (pendingCampaignAction, campaignSelectionList) must be cleared so it cannot
// hijack enrichment routing on the next turn.

describe("managerNode — cross-domain context cleanup (Bug 2)", () => {
  it("enrichment intent + stale pendingCampaignAction → routes to enrichment", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "fetch_company_website",
      pendingCampaignAction: "get_campaign_stats",
    }));
    expect(patch.agentDomain).toBe("enrichment");
  });

  it("enrichment intent + stale pendingCampaignAction → clears pendingCampaignAction in patch", async () => {
    const patch = await managerNode(makeManagerState({
      intent:                "enrich_contacts",
      pendingCampaignAction: "start_campaign",
    })) as Record<string, unknown>;
    expect(patch.pendingCampaignAction).toBeUndefined();
  });

  it("campaign number reply (pendingCampaignAction present, general domain) still routes to campaign", async () => {
    // Simulates: user says "2" to pick a campaign from a list shown earlier.
    // pendingCampaignAction is present, intent is general_help (LLM sees no
    // campaign keywords in a bare digit), so selectionActive branch fires → campaign.
    const patch = await managerNode(makeManagerState({
      intent:                "general_help",
      pendingCampaignAction: "start_campaign",
    }));
    expect(patch.agentDomain).toBe("campaign");
  });

  it("enrichment continuation (pendingEnrichmentStep present) preserves pendingEnrichmentStep", async () => {
    const patch = await managerNode(makeManagerState({
      intent:               "confirm_enrichment",
      pendingEnrichmentStep: "preview",
    })) as Record<string, unknown>;
    // The manager patch should NOT include pendingEnrichmentStep (not cleared, not touched)
    expect("pendingEnrichmentStep" in patch).toBe(false);
    expect(patch.agentDomain).toBe("enrichment");
  });
});
