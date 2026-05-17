/**
 * src/tests/lib/campaignPersistence.test.ts
 *
 * Integration tests verifying that campaign creation is visible in subsequent
 * list calls — the core bug that appeared in browser QA where create_campaign
 * succeeded but get_all_campaigns returned "No campaigns found."
 *
 * Root cause: MockMailFlowApiClient previously created a fresh in-memory state
 * per instance; toolRegistry creates a new client per tool call, so create and
 * list could never see each other's data.
 *
 * Fix: module-level _campaignStore shared across all instances within a process.
 *
 * These tests run against the mock client (no backend required) but exercise
 * the same code path used in production MOCK_MAILFLOW mode.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MockMailFlowApiClient,
  resetMockCampaignStore,
} from "../../lib/mockMailflowApiClient.js";

beforeEach(() => {
  resetMockCampaignStore();
});

// ── Persistence: create → list ────────────────────────────────────────────────

describe("campaign persistence — create then list", () => {
  it("newly created campaign appears in getAllCampaigns (same instance)", async () => {
    const client  = new MockMailFlowApiClient();
    const created = await client.createCampaign({
      name:         "Summer Sale Discount Offer",
      subject:      "Big savings this summer",
      emailContent: "<p>Shop now</p>",
    });

    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Summer Sale Discount Offer");

    const campaigns = await client.getAllCampaigns();
    const ids = campaigns.map((c) => c.id);
    expect(ids).toContain(created.id);
  });

  it("newly created campaign appears in getAllCampaigns (separate instances — simulates toolRegistry)", async () => {
    // toolRegistry creates a fresh MockMailFlowApiClient on every MCP call.
    // The create call and the list call use different client instances.
    const createClient = new MockMailFlowApiClient();
    const listClient   = new MockMailFlowApiClient();

    const created = await createClient.createCampaign({
      name:         "Eid Special Offer",
      subject:      "Celebrate with us",
      emailContent: "<p>Exclusive deals</p>",
    });

    expect(created.id).toBeTruthy();

    const campaigns = await listClient.getAllCampaigns();
    const found = campaigns.find((c) => c.id === created.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Eid Special Offer");
  });

  it("multiple campaigns created across different instances are all visible", async () => {
    const a = await new MockMailFlowApiClient().createCampaign({ name: "Campaign A", subject: "Sub A", emailContent: "Body A" });
    const b = await new MockMailFlowApiClient().createCampaign({ name: "Campaign B", subject: "Sub B", emailContent: "Body B" });
    const c = await new MockMailFlowApiClient().createCampaign({ name: "Campaign C", subject: "Sub C", emailContent: "Body C" });

    const campaigns = await new MockMailFlowApiClient().getAllCampaigns();
    const ids = campaigns.map((camp) => camp.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
  });

  it("resetMockCampaignStore clears created campaigns", async () => {
    const created = await new MockMailFlowApiClient().createCampaign({
      name: "Temporary", subject: "Sub", emailContent: "Body",
    });

    resetMockCampaignStore();

    const campaigns = await new MockMailFlowApiClient().getAllCampaigns();
    expect(campaigns.find((c) => c.id === created.id)).toBeUndefined();
  });
});

// ── Default seed campaigns ────────────────────────────────────────────────────

describe("campaign persistence — default seed", () => {
  it("getAllCampaigns returns the 3 seed campaigns on a fresh store", async () => {
    const campaigns = await new MockMailFlowApiClient().getAllCampaigns();
    expect(campaigns.length).toBe(3);
    const names = campaigns.map((c) => c.name);
    expect(names).toContain("Summer Sale Campaign");
    expect(names).toContain("Eid Offer Campaign");
    expect(names).toContain("Product Launch Campaign");
  });

  it("created campaigns are added on top of the 3 seed campaigns", async () => {
    await new MockMailFlowApiClient().createCampaign({ name: "New One", subject: "Sub", emailContent: "Body" });
    const campaigns = await new MockMailFlowApiClient().getAllCampaigns();
    expect(campaigns.length).toBe(4);
  });
});

// ── Mutation lifecycle ────────────────────────────────────────────────────────

describe("campaign persistence — mutations persist across instances", () => {
  it("startCampaign status is visible from a different instance", async () => {
    const campaigns  = await new MockMailFlowApiClient().getAllCampaigns();
    const draft      = campaigns.find((c) => c.status === "draft");
    expect(draft).toBeDefined();

    await new MockMailFlowApiClient().startCampaign(draft!.id);

    const updated = await new MockMailFlowApiClient().getAllCampaigns();
    const found   = updated.find((c) => c.id === draft!.id);
    expect(found?.status).toBe("running");
  });
});
