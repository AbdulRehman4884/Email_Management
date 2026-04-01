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
import { routeToAgent } from "../nodes/manager.node.js";
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
