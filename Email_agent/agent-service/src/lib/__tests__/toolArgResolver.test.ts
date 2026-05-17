/**
 * src/lib/__tests__/toolArgResolver.test.ts
 *
 * Unit tests for the toolArgResolver module.
 *
 * Covers:
 *   1. campaignId resolution — LLM extraction vs. session fallback vs. absent
 *   2. Per-tool argument population — each MCP tool gets the right fields
 *   3. limit / query extraction for inbox tools
 *   4. Security boundary — forbidden identity/auth keys are never forwarded
 *   5. filters sanitisation — safe filter keys pass through; forbidden ones are stripped
 *   6. Agent integration — CampaignAgent, AnalyticsAgent, InboxAgent consume
 *      state.llmExtractedArgs via the resolver (no direct mock required;
 *      tested through the public resolveToolArgs() function)
 *
 * The resolver is a pure synchronous function — no mocks required.
 */

import { describe, it, expect } from "vitest";
import { resolveToolArgs } from "../toolArgResolver.js";
import type { ResolverInput } from "../toolArgResolver.js";
import type { LLMIntentArguments } from "../../schemas/llmIntent.schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function input(
  extractedArgs?: LLMIntentArguments,
  activeCampaignId?: string,
): ResolverInput {
  return { extractedArgs, activeCampaignId };
}

// ── campaignId resolution ─────────────────────────────────────────────────────

describe("campaignId resolution", () => {
  it("uses LLM-extracted campaignId when present", () => {
    const args = resolveToolArgs("start_campaign", input({ campaignId: "llm-id" }, "session-id"));
    expect(args.campaignId).toBe("llm-id");
  });

  it("falls back to activeCampaignId when LLM did not extract one", () => {
    const args = resolveToolArgs("start_campaign", input({}, "session-id"));
    expect(args.campaignId).toBe("session-id");
  });

  it("LLM campaignId takes priority over activeCampaignId", () => {
    const args = resolveToolArgs("pause_campaign", input({ campaignId: "llm-id" }, "session-id"));
    expect(args.campaignId).toBe("llm-id");
  });

  it("returns no campaignId key when neither LLM nor session provides one", () => {
    const args = resolveToolArgs("resume_campaign", input());
    expect(args).not.toHaveProperty("campaignId");
    expect(args).toEqual({});
  });

  it("ignores an empty-string LLM campaignId and falls back to session", () => {
    // LLM returned campaignId: "" — invalid, should fall through to session
    // Note: LLMIntentArgumentsSchema uses z.string().min(1), so empty strings
    // are stripped before reaching the resolver. Verify the resolver also guards.
    const args = resolveToolArgs("start_campaign", input({ campaignId: "" }, "session-fallback"));
    expect(args.campaignId).toBe("session-fallback");
  });
});

// ── Campaign tool args ────────────────────────────────────────────────────────

describe("campaign tools", () => {
  it("create_campaign: returns empty args when no filters provided", () => {
    // campaignId and query are not create_campaign fields — resolver ignores them.
    // CampaignAgent will detect missing required fields and return a clarification.
    const args = resolveToolArgs("create_campaign", input({ campaignId: "c1", query: "Summer" }, "active"));
    expect(args).toEqual({});
  });

  it("create_campaign: extracts all required fields from filters", () => {
    const args = resolveToolArgs("create_campaign", input({
      filters: {
        name: "Summer Sale",
        subject: "Big Deals Inside",
        fromName: "Marketing Team",
        fromEmail: "marketing@example.com",
        body: "Check out our latest offers.",
      },
    }));
    expect(args).toEqual({
      name: "Summer Sale",
      subject: "Big Deals Inside",
      fromName: "Marketing Team",
      fromEmail: "marketing@example.com",
      body: "Check out our latest offers.",
    });
  });

  it("create_campaign: extracts only present fields from partial filters", () => {
    const args = resolveToolArgs("create_campaign", input({
      filters: { name: "Winter Campaign", subject: "Holiday Deals" },
    }));
    expect(args).toEqual({ name: "Winter Campaign", subject: "Holiday Deals" });
    expect(args).not.toHaveProperty("fromName");
    expect(args).not.toHaveProperty("fromEmail");
    expect(args).not.toHaveProperty("body");
  });

  it("create_campaign: ignores empty-string field values in filters", () => {
    const args = resolveToolArgs("create_campaign", input({
      filters: { name: "Test", subject: "", fromEmail: "a@b.com" },
    }));
    expect(args).toEqual({ name: "Test", fromEmail: "a@b.com" });
    expect(args).not.toHaveProperty("subject");
  });

  it("create_campaign: ignores non-string field values in filters", () => {
    const args = resolveToolArgs("create_campaign", input({
      filters: { name: "Test", subject: 123, fromEmail: null },
    }));
    expect(args).toEqual({ name: "Test" });
  });

  it("create_campaign: extracts all required fields from top-level extractedArgs (Gemini top-level path)", () => {
    // Some Gemini versions return fields at the top level of arguments rather
    // than inside filters.  LLMIntentArgumentsSchema now declares these fields
    // so .strip() preserves them, and resolveCreateCampaign falls back to them.
    const args = resolveToolArgs("create_campaign", input({
      name:      "Winter Campaign",
      subject:   "Holiday Deals",
      fromName:  "Sales Team",
      fromEmail: "sales@example.com",
      body:      "Happy holidays from us!",
    }));
    expect(args).toEqual({
      name:      "Winter Campaign",
      subject:   "Holiday Deals",
      fromName:  "Sales Team",
      fromEmail: "sales@example.com",
      body:      "Happy holidays from us!",
    });
  });

  it("create_campaign: filters path takes priority over top-level extractedArgs", () => {
    // Both filters and top-level have a 'name' key — filters wins.
    const args = resolveToolArgs("create_campaign", input({
      name:    "Top-level Name",    // top-level (lower priority)
      filters: { name: "Filter Name", subject: "Sub", fromName: "F", fromEmail: "f@e.com", body: "B" },
    }));
    expect(args.name).toBe("Filter Name");
  });

  it("create_campaign: merges filters and top-level extractedArgs to fill gaps", () => {
    // Some fields in filters, some at top level — resolver fills from both.
    const args = resolveToolArgs("create_campaign", input({
      name:      "Top Name",   // top-level (fills gap because not in filters)
      subject:   "Top Subject",
      filters: {
        fromName:  "Filter Sender",
        fromEmail: "filter@example.com",
        body:      "Email body from filters",
      },
    }));
    expect(args).toMatchObject({
      name:      "Top Name",
      subject:   "Top Subject",
      fromName:  "Filter Sender",
      fromEmail: "filter@example.com",
      body:      "Email body from filters",
    });
  });

  it("update_campaign: resolves campaignId from LLM extraction", () => {
    const args = resolveToolArgs("update_campaign", input({ campaignId: "c1" }));
    expect(args).toEqual({ campaignId: "c1" });
  });

  it("update_campaign: resolves campaignId from session fallback", () => {
    const args = resolveToolArgs("update_campaign", input(undefined, "sess-c2"));
    expect(args).toEqual({ campaignId: "sess-c2" });
  });

  it("update_campaign: returns {} when campaignId is unavailable", () => {
    expect(resolveToolArgs("update_campaign", input())).toEqual({});
  });

  it("start_campaign: resolves campaignId", () => {
    expect(resolveToolArgs("start_campaign", input({ campaignId: "c3" }))).toEqual({ campaignId: "c3" });
  });

  it("pause_campaign: resolves campaignId", () => {
    expect(resolveToolArgs("pause_campaign", input({ campaignId: "c4" }))).toEqual({ campaignId: "c4" });
  });

  it("resume_campaign: resolves campaignId", () => {
    expect(resolveToolArgs("resume_campaign", input(undefined, "c5"))).toEqual({ campaignId: "c5" });
  });

  it("get_smtp_settings: always returns empty args (no input required)", () => {
    expect(resolveToolArgs("get_smtp_settings", input({ campaignId: "c6" }, "c6"))).toEqual({});
  });

  it("update_smtp_settings: returns empty args when no filters present", () => {
    expect(resolveToolArgs("update_smtp_settings", input())).toEqual({});
  });

  it("update_smtp_settings: passes safe filter fields through", () => {
    const args = resolveToolArgs("update_smtp_settings", input({
      filters: { host: "smtp.example.com", port: 587, secure: true },
    }));
    expect(args).toEqual({ host: "smtp.example.com", port: 587, secure: true });
  });
});

// ── Analytics tool args ───────────────────────────────────────────────────────

describe("analytics tools", () => {
  it("get_campaign_stats: uses LLM-extracted campaignId", () => {
    expect(resolveToolArgs("get_campaign_stats", input({ campaignId: "stats-c1" }))).toEqual({
      campaignId: "stats-c1",
    });
  });

  it("get_campaign_stats: falls back to activeCampaignId", () => {
    expect(resolveToolArgs("get_campaign_stats", input(undefined, "sess-c1"))).toEqual({
      campaignId: "sess-c1",
    });
  });

  it("get_campaign_stats: returns {} when no campaignId available", () => {
    expect(resolveToolArgs("get_campaign_stats", input())).toEqual({});
  });
});

// ── Inbox tool args ───────────────────────────────────────────────────────────

describe("inbox tools — list_replies", () => {
  it("includes campaignId when extracted by LLM", () => {
    const args = resolveToolArgs("list_replies", input({ campaignId: "inbox-c1" }));
    expect(args.campaignId).toBe("inbox-c1");
  });

  it("includes limit when extracted by LLM", () => {
    const args = resolveToolArgs("list_replies", input({ limit: 25 }));
    expect(args.limit).toBe(25);
  });

  it("includes both campaignId and limit together", () => {
    const args = resolveToolArgs("list_replies", input({ campaignId: "c1", limit: 10 }));
    expect(args).toMatchObject({ campaignId: "c1", limit: 10 });
  });

  it("does NOT include query for list_replies (only limit/campaignId apply)", () => {
    const args = resolveToolArgs("list_replies", input({ query: "interested" }));
    expect(args).not.toHaveProperty("query");
  });

  it("ignores non-positive limit values", () => {
    const args = resolveToolArgs("list_replies", input({ limit: 0 }));
    expect(args).not.toHaveProperty("limit");
  });

  it("returns {} when no args available", () => {
    expect(resolveToolArgs("list_replies", input())).toEqual({});
  });
});

describe("inbox tools — summarize_replies", () => {
  it("includes campaignId when present", () => {
    const args = resolveToolArgs("summarize_replies", input({ campaignId: "sum-c1" }));
    expect(args.campaignId).toBe("sum-c1");
  });

  it("includes query when extracted by LLM", () => {
    const args = resolveToolArgs("summarize_replies", input({ query: "interested in product" }));
    expect(args.query).toBe("interested in product");
  });

  it("includes both campaignId and query together", () => {
    const args = resolveToolArgs("summarize_replies", input({
      campaignId: "c1",
      query: "unsubscribe",
    }));
    expect(args).toMatchObject({ campaignId: "c1", query: "unsubscribe" });
  });

  it("returns {} when no args available", () => {
    expect(resolveToolArgs("summarize_replies", input())).toEqual({});
  });
});

// ── Security: forbidden identity/auth keys ────────────────────────────────────

describe("security — forbidden keys in filters", () => {
  it("strips userId from filters", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { userId: "attacker-id", from: "jan" },
    }));
    expect(args).not.toHaveProperty("userId");
    expect(args.from).toBe("jan");
  });

  it("strips accountId from filters", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { accountId: "other-account" },
    }));
    expect(args).not.toHaveProperty("accountId");
  });

  it("strips tenantId from filters", () => {
    const args = resolveToolArgs("summarize_replies", input({
      filters: { tenantId: "other-tenant", campaignFilter: "welcome" },
    }));
    expect(args).not.toHaveProperty("tenantId");
    expect(args.campaignFilter).toBe("welcome");
  });

  it("strips token from filters", () => {
    const args = resolveToolArgs("update_smtp_settings", input({
      filters: { token: "bearer-xyz", host: "mail.example.com" },
    }));
    expect(args).not.toHaveProperty("token");
    expect(args.host).toBe("mail.example.com");
  });

  it("strips apiKey from filters (case-insensitive normalisation)", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { apiKey: "secret-key", limit: 5 },
    }));
    expect(args).not.toHaveProperty("apiKey");
  });

  it("strips password from filters", () => {
    const args = resolveToolArgs("update_smtp_settings", input({
      filters: { password: "secret123", host: "smtp.example.com" },
    }));
    expect(args).not.toHaveProperty("password");
    expect(args.host).toBe("smtp.example.com");
  });

  it("strips auth from filters", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { auth: "basic-abc", status: "active" },
    }));
    expect(args).not.toHaveProperty("auth");
    expect(args.status).toBe("active");
  });

  it("strips secret from filters", () => {
    const args = resolveToolArgs("update_smtp_settings", input({
      filters: { secret: "my-secret", port: 465 },
    }));
    expect(args).not.toHaveProperty("secret");
    expect(args.port).toBe(465);
  });

  it("strips credential from filters", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { credential: "cred-value", from: "2024-01-01" },
    }));
    expect(args).not.toHaveProperty("credential");
    expect(args.from).toBe("2024-01-01");
  });

  it("handles underscore variants — user_id is stripped", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { user_id: "hacker", status: "replied" },
    }));
    expect(args).not.toHaveProperty("user_id");
    expect(args.status).toBe("replied");
  });

  it("handles camelCase variants — userId is stripped", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { userId: "hacker", status: "replied" },
    }));
    expect(args).not.toHaveProperty("userId");
  });

  it("preserves safe filter keys untouched", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { from: "2024-01-01", to: "2024-12-31", status: "replied" },
    }));
    expect(args).toMatchObject({
      from: "2024-01-01",
      to: "2024-12-31",
      status: "replied",
    });
  });

  it("returns {} when all filters are forbidden", () => {
    const args = resolveToolArgs("list_replies", input({
      filters: { userId: "x", accountId: "y", tenantId: "z" },
    }));
    // No safe keys remain, no campaignId or limit either
    expect(args).toEqual({});
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles undefined extractedArgs gracefully", () => {
    expect(() =>
      resolveToolArgs("get_campaign_stats", input(undefined, "c1")),
    ).not.toThrow();
  });

  it("handles empty extractedArgs object gracefully", () => {
    expect(() =>
      resolveToolArgs("list_replies", input({})),
    ).not.toThrow();
  });

  it("handles both undefined extractedArgs and undefined activeCampaignId", () => {
    const args = resolveToolArgs("start_campaign", input());
    expect(args).toEqual({});
  });

  it("each call returns a new object (no shared reference)", () => {
    const a = resolveToolArgs("list_replies", input({ campaignId: "c1" }));
    const b = resolveToolArgs("list_replies", input({ campaignId: "c1" }));
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("extractedArgs values are never mutated", () => {
    const extracted: LLMIntentArguments = {
      campaignId: "c1",
      filters: { status: "active", userId: "hacker" },
    };
    resolveToolArgs("list_replies", input(extracted));
    // Original filters object must be unchanged
    expect(extracted.filters).toEqual({ status: "active", userId: "hacker" });
  });
});

// ── Agent integration — llmExtractedArgs flows to toolArgs ────────────────────

describe("agent integration (resolver wiring)", () => {
  // These tests verify that all tools correctly route through the resolver.
  // They exercise the same logic that CampaignAgent, AnalyticsAgent, and
  // InboxAgent invoke, confirming the end-to-end arg flow without needing
  // a live graph.

  it("campaignId extracted by Gemini flows into start_campaign args", () => {
    const result = resolveToolArgs("start_campaign", {
      extractedArgs: { campaignId: "gemini-extracted-c1" },
      activeCampaignId: undefined,
    });
    expect(result).toEqual({ campaignId: "gemini-extracted-c1" });
  });

  it("campaignId extracted by Gemini flows into get_campaign_stats args", () => {
    const result = resolveToolArgs("get_campaign_stats", {
      extractedArgs: { campaignId: "analytics-c1" },
      activeCampaignId: undefined,
    });
    expect(result).toEqual({ campaignId: "analytics-c1" });
  });

  it("limit extracted by Gemini flows into list_replies args", () => {
    const result = resolveToolArgs("list_replies", {
      extractedArgs: { limit: 50 },
      activeCampaignId: undefined,
    });
    expect(result).toEqual({ limit: 50 });
  });

  it("query extracted by Gemini flows into summarize_replies args", () => {
    const result = resolveToolArgs("summarize_replies", {
      extractedArgs: { query: "customers who clicked" },
      activeCampaignId: undefined,
    });
    expect(result).toEqual({ query: "customers who clicked" });
  });

  it("session activeCampaignId used when Gemini extracted no campaignId", () => {
    const result = resolveToolArgs("pause_campaign", {
      extractedArgs: {},
      activeCampaignId: "session-campaign-99",
    });
    expect(result).toEqual({ campaignId: "session-campaign-99" });
  });

  it("LLM campaignId overrides session activeCampaignId for update_campaign", () => {
    const result = resolveToolArgs("update_campaign", {
      extractedArgs: { campaignId: "llm-wins" },
      activeCampaignId: "session-loses",
    });
    expect(result).toEqual({ campaignId: "llm-wins" });
  });

  it("invalid extracted args are silently ignored — no campaignId for update_campaign → {}", () => {
    const result = resolveToolArgs("update_campaign", {
      extractedArgs: { limit: 5 }, // limit is not meaningful for update_campaign
      activeCampaignId: undefined,
    });
    expect(result).toEqual({});
  });

  it("forbidden identifiers from llmExtractedArgs.filters never reach tool args", () => {
    const result = resolveToolArgs("list_replies", {
      extractedArgs: {
        filters: { userId: "inject-user", tenantId: "inject-tenant", status: "active" },
      },
      activeCampaignId: undefined,
    });
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("tenantId");
    expect(result.status).toBe("active");
  });
});
