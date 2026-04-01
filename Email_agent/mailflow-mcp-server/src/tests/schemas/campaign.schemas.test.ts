/**
 * src/tests/schemas/campaign.schemas.test.ts
 *
 * Validates Zod schema behaviour for campaign tools.
 * No env mocking needed — schemas have no runtime dependency on env.ts.
 */

import { describe, it, expect } from "vitest";
import {
  CreateCampaignSchema,
  UpdateCampaignSchema,
  StartCampaignSchema,
  GetCampaignStatsSchema,
} from "../../schemas/campaign.schemas.js";

// ── createCampaign ────────────────────────────────────────────────────────────

describe("CreateCampaignSchema", () => {
  const valid = {
    name: "Q4 Outreach",
    subject: "Hello from MailFlow",
    fromName: "Acme Sales",
    fromEmail: "sales@acme.com",
    body: "<p>Hello</p>",
  };

  it("accepts a minimal valid payload", () => {
    const result = CreateCampaignSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("defaults bodyFormat to html", () => {
    const result = CreateCampaignSchema.safeParse(valid);
    expect(result.success && result.data.bodyFormat).toBe("html");
  });

  it("accepts plain body format", () => {
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      bodyFormat: "plain",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid fromEmail", () => {
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      fromEmail: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { name: _omit, ...withoutName } = valid;
    const result = CreateCampaignSchema.safeParse(withoutName);
    expect(result.success).toBe(false);
  });

  it("rejects a name longer than 255 characters", () => {
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      name: "x".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a subject longer than 998 characters", () => {
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      subject: "x".repeat(999),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid scheduledAt (not ISO datetime)", () => {
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      scheduledAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid ISO datetime for scheduledAt", () => {
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      scheduledAt: "2025-06-01T09:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("does not allow a userId field", () => {
    // userId must be silently ignored (stripped by Zod strict mode would reject;
    // default mode strips unknown keys — either way it never reaches the handler)
    const result = CreateCampaignSchema.safeParse({
      ...valid,
      userId: "should-not-be-here",
    });
    // Zod strips unknown keys by default; result should succeed but userId is absent
    if (result.success) {
      expect((result.data as Record<string, unknown>).userId).toBeUndefined();
    }
  });
});

// ── updateCampaign ────────────────────────────────────────────────────────────

describe("UpdateCampaignSchema", () => {
  it("accepts a valid partial update", () => {
    const result = UpdateCampaignSchema.safeParse({
      campaignId: "camp-123",
      name: "Updated Name",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when only campaignId is provided (no update fields)", () => {
    const result = UpdateCampaignSchema.safeParse({ campaignId: "camp-123" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one field/i);
    }
  });

  it("rejects an empty campaignId", () => {
    const result = UpdateCampaignSchema.safeParse({
      campaignId: "",
      name: "New Name",
    });
    expect(result.success).toBe(false);
  });

  it("accepts null for replyToEmail (clear the value)", () => {
    const result = UpdateCampaignSchema.safeParse({
      campaignId: "camp-123",
      replyToEmail: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts null for scheduledAt (unschedule)", () => {
    const result = UpdateCampaignSchema.safeParse({
      campaignId: "camp-123",
      scheduledAt: null,
    });
    expect(result.success).toBe(true);
  });
});

// ── startCampaign ─────────────────────────────────────────────────────────────

describe("StartCampaignSchema", () => {
  it("accepts a valid campaignId", () => {
    expect(StartCampaignSchema.safeParse({ campaignId: "abc" }).success).toBe(true);
  });

  it("rejects an empty campaignId", () => {
    expect(StartCampaignSchema.safeParse({ campaignId: "" }).success).toBe(false);
  });

  it("rejects a missing campaignId", () => {
    expect(StartCampaignSchema.safeParse({}).success).toBe(false);
  });
});

// ── getCampaignStats ──────────────────────────────────────────────────────────

describe("GetCampaignStatsSchema", () => {
  it("accepts a valid campaignId", () => {
    expect(GetCampaignStatsSchema.safeParse({ campaignId: "abc" }).success).toBe(true);
  });

  it("rejects a missing campaignId", () => {
    expect(GetCampaignStatsSchema.safeParse({}).success).toBe(false);
  });
});
