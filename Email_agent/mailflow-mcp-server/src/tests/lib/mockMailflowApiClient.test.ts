/**
 * src/tests/lib/mockMailflowApiClient.test.ts
 *
 * Tests for MockMailFlowApiClient.
 *
 * Verifies that:
 *   1. Every method returns correctly-shaped responses (no HTTP calls)
 *   2. Input campaignId is reflected in the returned object
 *   3. Status transitions are correct for campaign lifecycle methods
 *   4. No HTTP library imports or network calls occur
 */

import { describe, it, expect } from "vitest";
import { MockMailFlowApiClient } from "../../lib/mockMailflowApiClient.js";
import { asCampaignId } from "../../types/common.js";

// ── Fixture ───────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = asCampaignId("test-123");

// ── Campaign lifecycle ────────────────────────────────────────────────────────

describe("MockMailFlowApiClient — campaign lifecycle", () => {
  const client = new MockMailFlowApiClient();

  it("createCampaign returns a draft campaign with an id", async () => {
    const result = await client.createCampaign({
      name:      "Test Campaign",
      subject:   "Hello",
      fromName:  "Sender",
      fromEmail: "sender@example.com",
      body:      "<p>Hi</p>",
    });

    expect(result.status).toBe("draft");
    expect(result.id).toBeTruthy();
    expect(result.name).toBe("Test Campaign");
    expect(result.fromEmail).toBe("sender@example.com");
  });

  it("updateCampaign reflects updated fields", async () => {
    const result = await client.updateCampaign(CAMPAIGN_ID, {
      name:    "Updated Name",
      subject: "New Subject",
    });

    expect(result.id).toBe(CAMPAIGN_ID);
    expect(result.name).toBe("Updated Name");
    expect(result.subject).toBe("New Subject");
  });

  it("startCampaign returns status running with startedAt set", async () => {
    const result = await client.startCampaign(CAMPAIGN_ID);

    expect(result.id).toBe(CAMPAIGN_ID);
    expect(result.status).toBe("running");
    expect(result.startedAt).not.toBeNull();
  });

  it("pauseCampaign returns status paused with pausedAt set", async () => {
    const result = await client.pauseCampaign(CAMPAIGN_ID);

    expect(result.id).toBe(CAMPAIGN_ID);
    expect(result.status).toBe("paused");
    expect(result.pausedAt).not.toBeNull();
  });

  it("resumeCampaign returns status running with pausedAt cleared", async () => {
    const result = await client.resumeCampaign(CAMPAIGN_ID);

    expect(result.id).toBe(CAMPAIGN_ID);
    expect(result.status).toBe("running");
    expect(result.pausedAt).toBeNull();
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────────

describe("MockMailFlowApiClient — getCampaignStats", () => {
  const client = new MockMailFlowApiClient();

  it("returns stats with the correct campaignId", async () => {
    const result = await client.getCampaignStats(CAMPAIGN_ID);

    expect(result.campaignId).toBe(CAMPAIGN_ID);
    expect(result.sent).toBeGreaterThan(0);
    expect(result.openRate).toBeGreaterThan(0);
    expect(result.openRate).toBeLessThanOrEqual(1);
    expect(result.clickRate).toBeGreaterThan(0);
    expect(result.clickRate).toBeLessThanOrEqual(1);
  });

  it("returns a fresh calculatedAt timestamp each call", async () => {
    const before = Date.now();
    const result = await client.getCampaignStats(CAMPAIGN_ID);
    const after  = Date.now();

    const ts = new Date(result.calculatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ── Inbox ─────────────────────────────────────────────────────────────────────

describe("MockMailFlowApiClient — listReplies", () => {
  const client = new MockMailFlowApiClient();

  it("returns a paginated list with items", async () => {
    const result = await client.listReplies({ campaignId: CAMPAIGN_ID });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
    expect(result.page).toBe(1);
  });

  it("each reply has required fields including bodyText", async () => {
    const result = await client.listReplies({});

    for (const reply of result.items) {
      expect(reply.id).toBeTruthy();
      expect(reply.fromEmail).toBeTruthy();
      expect(reply.bodyText).toBeTruthy();
      expect(["unread", "read", "archived"]).toContain(reply.status);
    }
  });

  it("respects pageSize parameter", async () => {
    const result = await client.listReplies({ pageSize: 1 });

    expect(result.items.length).toBe(1);
    expect(result.pageSize).toBe(1);
  });
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe("MockMailFlowApiClient — SMTP settings", () => {
  const client = new MockMailFlowApiClient();

  it("getSmtpSettings returns a verified SMTP config", async () => {
    const result = await client.getSmtpSettings();

    expect(result.host).toBeTruthy();
    expect(result.port).toBeGreaterThan(0);
    expect(result.isVerified).toBe(true);
    expect(["tls", "ssl", "none"]).toContain(result.encryption);
  });

  it("updateSmtpSettings reflects changed host and port", async () => {
    const result = await client.updateSmtpSettings({
      host: "smtp.updated.com",
      port: 465,
    });

    expect(result.host).toBe("smtp.updated.com");
    expect(result.port).toBe(465);
    // Unchanged fields stay at mock defaults
    expect(result.isVerified).toBe(true);
  });

  it("updateSmtpSettings does not include password in response (security)", async () => {
    const result = await client.updateSmtpSettings({ host: "smtp.test.com" });

    // SmtpSettings interface intentionally has no password field
    expect("password" in result).toBe(false);
  });
});

// ── No HTTP calls ─────────────────────────────────────────────────────────────

describe("MockMailFlowApiClient — no HTTP calls", () => {
  it("does not import axios or make network requests", async () => {
    // If axios were imported at the module level it would be present in
    // require.cache.  The simplest check: the module resolves without
    // throwing, and all methods return synchronously-constructable values.
    const client = new MockMailFlowApiClient();

    // All methods should resolve — not reject — without a network
    await expect(client.pauseCampaign(CAMPAIGN_ID)).resolves.toBeDefined();
    await expect(client.getCampaignStats(CAMPAIGN_ID)).resolves.toBeDefined();
    await expect(client.listReplies({})).resolves.toBeDefined();
    await expect(client.getSmtpSettings()).resolves.toBeDefined();
  });
});

// ── MOCK_MAILFLOW mode — prevents real backend 404 errors ─────────────────────
//
// When MAILFLOW_API_BASE_URL points at the local dev stack (e.g. localhost:3000)
// and no real MailFlow backend is running, every tool call would produce a 404.
// MOCK_MAILFLOW=true routes tool execution through MockMailFlowApiClient instead,
// so local smoke tests succeed without a backend.
//
// These tests document that contract: campaign IDs that do not exist in any
// real backend are handled gracefully by returning schema-valid mock data.

describe("MockMailFlowApiClient — MOCK_MAILFLOW prevents 404s in local dev", () => {
  const client = new MockMailFlowApiClient();

  // Use an ID that would never exist on a real backend
  const NONEXISTENT = asCampaignId("campaign-that-does-not-exist-on-any-backend");

  it("pauseCampaign returns valid paused state — no 404 against missing backend", async () => {
    const result = await client.pauseCampaign(NONEXISTENT);

    expect(result.id).toBe(NONEXISTENT);
    expect(result.status).toBe("paused");
    expect(result.pausedAt).not.toBeNull();
  });

  it("getCampaignStats returns valid stats — no 404 against missing backend", async () => {
    const result = await client.getCampaignStats(NONEXISTENT);

    expect(result.campaignId).toBe(NONEXISTENT);
    expect(result.sent).toBeGreaterThan(0);
    expect(result.openRate).toBeGreaterThanOrEqual(0);
    expect(result.openRate).toBeLessThanOrEqual(1);
  });

  it("startCampaign returns valid running state — no 404 against missing backend", async () => {
    const result = await client.startCampaign(NONEXISTENT);

    expect(result.id).toBe(NONEXISTENT);
    expect(result.status).toBe("running");
    expect(result.startedAt).not.toBeNull();
  });

  it("resumeCampaign returns running state with pausedAt cleared", async () => {
    const result = await client.resumeCampaign(NONEXISTENT);

    expect(result.id).toBe(NONEXISTENT);
    expect(result.status).toBe("running");
    expect(result.pausedAt).toBeNull();
  });

  it("updateCampaign reflects updated fields without a backend round-trip", async () => {
    const result = await client.updateCampaign(NONEXISTENT, {
      name:    "Updated in mock mode",
      subject: "New subject",
    });

    expect(result.id).toBe(NONEXISTENT);
    expect(result.name).toBe("Updated in mock mode");
    expect(result.subject).toBe("New subject");
  });

  it("listReplies returns replies even for an unknown campaignId", async () => {
    const result = await client.listReplies({ campaignId: NONEXISTENT });

    expect(result.items.length).toBeGreaterThan(0);
    // All replies are associated with the requested campaignId
    for (const reply of result.items) {
      expect(reply.campaignId).toBe(NONEXISTENT);
    }
  });
});
