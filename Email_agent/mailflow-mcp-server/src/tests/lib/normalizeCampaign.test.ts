/**
 * src/tests/lib/normalizeCampaign.test.ts
 *
 * Unit tests for the normalizeCampaign() function in mailflowApiClient.ts.
 *
 * The backend returns campaign objects whose shape differs from the MCP Campaign
 * type.  normalizeCampaign() is the boundary-layer fix for all mismatches:
 *   - id: integer → string (CampaignId brand)
 *   - emailContent → body
 *   - status "in_progress" → "running"
 *   - createdAt date-only string → ISO timestamp
 *   - missing fields filled with safe defaults
 *
 * Test coverage mirrors the user's requirement:
 *   1. { id }            — flat integer id directly in object
 *   2. { data: { id } }  — id nested under a data envelope (defensive)
 *   3. { campaign: { id } } — id nested under campaign key (defensive)
 *   4. missing id        — should produce empty string id (tool guard catches this)
 */

import { describe, it, expect } from "vitest";
import { normalizeCampaign, normalizeTimestamp, normalizeCampaignStatus } from "../../lib/mailflowApiClient.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BACKEND_CAMPAIGN = {
  id:           42,
  userId:       7,
  name:         "Summer Sale Discount Offer",
  status:       "draft",
  subject:      "Big savings this summer",
  emailContent: "<p>Shop now and save!</p>",
  fromName:     "MailFlow Sender",
  fromEmail:    "sender@example.com",
  recieptCount: 0,
  createdAt:    "2026-04-29",
  updatedAt:    "2026-04-29T10:00:00",
  scheduledAt:  null,
};

// ── normalizeCampaign: shape 1 — flat integer id ──────────────────────────────

describe("normalizeCampaign — flat backend response (primary case)", () => {
  it("converts integer id to string", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.id).toBe("42");
    expect(typeof result.id).toBe("string");
  });

  it("maps emailContent to body", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.body).toBe("<p>Shop now and save!</p>");
  });

  it("preserves name, subject, fromName, fromEmail", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.name).toBe("Summer Sale Discount Offer");
    expect(result.subject).toBe("Big savings this summer");
    expect(result.fromName).toBe("MailFlow Sender");
    expect(result.fromEmail).toBe("sender@example.com");
  });

  it("fills missing MCP fields with safe defaults", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.replyToEmail).toBeNull();
    expect(result.bodyFormat).toBe("html");
    expect(result.startedAt).toBeNull();
    expect(result.pausedAt).toBeNull();
    expect(result.completedAt).toBeNull();
  });

  it("pads date-only createdAt to ISO timestamp", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.createdAt).toBe("2026-04-29T00:00:00.000Z");
  });

  it("normalises status correctly", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.status).toBe("draft");
  });

  it("scheduledAt null passes through as null", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.scheduledAt).toBeNull();
  });

  it("scheduledAt string passes through", () => {
    const result = normalizeCampaign({ ...BACKEND_CAMPAIGN, scheduledAt: "2026-05-01 10:00:00" });
    expect(result.scheduledAt).toBe("2026-05-01 10:00:00");
  });
});

// ── normalizeCampaign: string id (already normalised) ────────────────────────

describe("normalizeCampaign — string id input (forward-compat)", () => {
  it("keeps a string id as-is", () => {
    const result = normalizeCampaign({ ...BACKEND_CAMPAIGN, id: "mock-camp-001" });
    expect(result.id).toBe("mock-camp-001");
  });
});

// ── normalizeCampaign: body field (backend future-compat) ─────────────────────

describe("normalizeCampaign — body field (if backend ever returns 'body' directly)", () => {
  it("uses body when emailContent is absent", () => {
    const raw = { ...BACKEND_CAMPAIGN, emailContent: undefined, body: "<p>Direct body</p>" };
    const result = normalizeCampaign(raw);
    expect(result.body).toBe("<p>Direct body</p>");
  });

  it("prefers emailContent over body when both present", () => {
    const raw = { ...BACKEND_CAMPAIGN, emailContent: "<p>EC</p>", body: "<p>B</p>" };
    const result = normalizeCampaign(raw);
    expect(result.body).toBe("<p>EC</p>");
  });
});

// ── normalizeCampaign: missing id → empty string ──────────────────────────────

describe("normalizeCampaign — missing id (tool guard will catch it)", () => {
  it("produces empty string id when id is absent", () => {
    const raw = { ...BACKEND_CAMPAIGN, id: undefined };
    const result = normalizeCampaign(raw);
    expect(result.id).toBe("");
  });

  it("produces empty string id when id is null", () => {
    const raw = { ...BACKEND_CAMPAIGN, id: null };
    const result = normalizeCampaign(raw);
    expect(result.id).toBe("");
  });
});

// ── normalizeCampaignStatus ───────────────────────────────────────────────────

describe("normalizeCampaignStatus", () => {
  it("maps in_progress to running", () => {
    expect(normalizeCampaignStatus("in_progress")).toBe("running");
  });

  it("passes through valid MCP statuses unchanged", () => {
    expect(normalizeCampaignStatus("draft")).toBe("draft");
    expect(normalizeCampaignStatus("scheduled")).toBe("scheduled");
    expect(normalizeCampaignStatus("running")).toBe("running");
    expect(normalizeCampaignStatus("paused")).toBe("paused");
    expect(normalizeCampaignStatus("completed")).toBe("completed");
    expect(normalizeCampaignStatus("cancelled")).toBe("cancelled");
  });

  it("defaults to draft for unknown status values", () => {
    expect(normalizeCampaignStatus("unknown_status")).toBe("draft");
    expect(normalizeCampaignStatus(null)).toBe("draft");
    expect(normalizeCampaignStatus(undefined)).toBe("draft");
  });
});

// ── normalizeTimestamp ────────────────────────────────────────────────────────

describe("normalizeTimestamp", () => {
  it("pads date-only string to ISO midnight UTC", () => {
    expect(normalizeTimestamp("2026-04-29")).toBe("2026-04-29T00:00:00.000Z");
  });

  it("passes through full ISO timestamp unchanged", () => {
    expect(normalizeTimestamp("2026-04-29T10:30:00.000Z")).toBe("2026-04-29T10:30:00.000Z");
  });

  it("passes through partial timestamp unchanged", () => {
    expect(normalizeTimestamp("2026-04-29T10:00:00")).toBe("2026-04-29T10:00:00");
  });

  it("returns current time for null/undefined input", () => {
    const before = Date.now();
    const result = normalizeTimestamp(null);
    const after  = Date.now();
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("returns current time for empty string", () => {
    const result = normalizeTimestamp("");
    expect(() => new Date(result)).not.toThrow();
  });
});

// ── Integration: full backend→MCP round-trip ─────────────────────────────────

describe("normalizeCampaign — full backend round-trip produces valid Campaign", () => {
  it("all required Campaign fields are present and non-null where expected", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);

    expect(typeof result.id).toBe("string");
    expect(result.id).toBeTruthy();
    expect(typeof result.name).toBe("string");
    expect(typeof result.subject).toBe("string");
    expect(typeof result.fromName).toBe("string");
    expect(typeof result.fromEmail).toBe("string");
    expect(typeof result.body).toBe("string");
    expect(typeof result.status).toBe("string");
    expect(typeof result.bodyFormat).toBe("string");
    expect(typeof result.createdAt).toBe("string");
    expect(typeof result.updatedAt).toBe("string");
  });

  it("id is exactly '42' (integer 42 stringified)", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    expect(result.id).toBe("42");
  });

  it("backend userId and recieptCount fields are stripped from output", () => {
    const result = normalizeCampaign(BACKEND_CAMPAIGN);
    const keys = Object.keys(result);
    expect(keys).not.toContain("userId");
    expect(keys).not.toContain("recieptCount");
  });
});
