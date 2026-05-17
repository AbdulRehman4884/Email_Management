/**
 * src/tests/tools/saveEnrichedContacts.tool.test.ts
 *
 * Tests the saveEnrichedContactsTool handler in isolation.
 *
 * Covers:
 *   1. Normalization — email extracted and lowercased
 *   2. Normalization — name resolved from fullName / firstName variants
 *   3. Normalization — enrichment fields (score, company, etc.) moved to customFields
 *   4. Normalization — nested customFields object merged, not double-wrapped
 *   5. gmail.com and personal-domain emails are accepted (not rejected)
 *   6. Contact with missing/blank email is dropped pre-backend, returned as rejected
 *   7. Calls saveRecipientsBulk (JSON bulk endpoint) — never saveRecipientsCsv
 *   8. Returns toolSuccess with saved/skipped counts from backend
 *   9. Backend rejected array is forwarded in the result
 *  10. Returns toolFailure on MailFlowApiError
 *  11. Tool name matches TOOL_NAMES.SAVE_ENRICHED_CONTACTS constant
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { saveEnrichedContactsTool } from "../../mcp/tools/enrichment/saveEnrichedContacts.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";
import { MailFlowApiError, ErrorCode } from "../../lib/errors.js";
import { TOOL_NAMES } from "../../config/constants.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = "42";

/** Typical enriched contact from the CSV + enrichment flow */
const RAW_CONTACT = {
  email:             "Alice@Acme.com",
  name:              "Alice Smith",
  company:           "Acme Corp",
  industry:          "SaaS",
  score:             85,
  priority:          "high",
  domain:            "acme.com",
  enrichmentSource:  "clearbit",
};

const validInput = {
  campaignId: CAMPAIGN_ID,
  contacts: [RAW_CONTACT],
};

function makeContext(bulkResult = { saved: 1, skipped: 0 }) {
  return createMockToolContext({
    mailflow: createMockMailflowClient({
      saveRecipientsBulk: vi.fn().mockResolvedValue(bulkResult),
    }),
  });
}

function getSentContacts(context: ReturnType<typeof makeContext>) {
  const fn = context.mailflow.saveRecipientsBulk as ReturnType<typeof vi.fn>;
  return (fn.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("saveEnrichedContactsTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── 1. Email normalization ────────────────────────────────────────────────

  it("lowercases the email before sending to backend", async () => {
    const ctx = makeContext();
    await saveEnrichedContactsTool.handler(validInput, ctx);
    const [sent] = getSentContacts(ctx);
    expect(sent!.email).toBe("alice@acme.com");
  });

  it("trims whitespace from email", async () => {
    const ctx = makeContext();
    const input = { campaignId: CAMPAIGN_ID, contacts: [{ email: "  bob@beta.io  ", name: "Bob" }] };
    await saveEnrichedContactsTool.handler(input, ctx);
    const [sent] = getSentContacts(ctx);
    expect(sent!.email).toBe("bob@beta.io");
  });

  // ── 2. Name resolution from field variants ────────────────────────────────

  it("resolves name from fullName when name is absent", async () => {
    const ctx = makeContext();
    const input = { campaignId: CAMPAIGN_ID, contacts: [{ email: "x@y.com", fullName: "Jane Doe" }] };
    await saveEnrichedContactsTool.handler(input, ctx);
    const [sent] = getSentContacts(ctx);
    expect(sent!.name).toBe("Jane Doe");
  });

  it("resolves name from firstName when name and fullName are absent", async () => {
    const ctx = makeContext();
    const input = { campaignId: CAMPAIGN_ID, contacts: [{ email: "x@y.com", firstName: "Jane" }] };
    await saveEnrichedContactsTool.handler(input, ctx);
    const [sent] = getSentContacts(ctx);
    expect(sent!.name).toBe("Jane");
  });

  // ── 3. Enrichment fields moved to customFields ────────────────────────────

  it("moves score to customFields.leadScore", async () => {
    const ctx = makeContext();
    await saveEnrichedContactsTool.handler(validInput, ctx);
    const [sent] = getSentContacts(ctx);
    const cf = sent!.customFields as Record<string, unknown>;
    expect(cf.leadScore).toBe(85);
    // score must NOT remain at top level
    expect("score" in sent!).toBe(false);
  });

  it("moves company to customFields.company", async () => {
    const ctx = makeContext();
    await saveEnrichedContactsTool.handler(validInput, ctx);
    const [sent] = getSentContacts(ctx);
    const cf = sent!.customFields as Record<string, unknown>;
    expect(cf.company).toBe("Acme Corp");
    expect("company" in sent!).toBe(false);
  });

  it("preserves enrichmentSource, industry, priority, domain in customFields", async () => {
    const ctx = makeContext();
    await saveEnrichedContactsTool.handler(validInput, ctx);
    const [sent] = getSentContacts(ctx);
    const cf = sent!.customFields as Record<string, unknown>;
    expect(cf.enrichmentSource).toBe("clearbit");
    expect(cf.industry).toBe("SaaS");
    expect(cf.priority).toBe("high");
    expect(cf.domain).toBe("acme.com");
  });

  // ── 4. Nested customFields merge ──────────────────────────────────────────

  it("merges a pre-existing customFields object instead of double-wrapping", async () => {
    const ctx = makeContext();
    const input = {
      campaignId: CAMPAIGN_ID,
      contacts: [{
        email: "x@y.com",
        name: "X",
        customFields: { existingKey: "existingVal" },
        industry: "Fintech",
      }],
    };
    await saveEnrichedContactsTool.handler(input, ctx);
    const [sent] = getSentContacts(ctx);
    const cf = sent!.customFields as Record<string, unknown>;
    // Both the nested key and the top-level enrichment key must be present
    expect(cf.existingKey).toBe("existingVal");
    expect(cf.industry).toBe("Fintech");
    // customFields must NOT be nested inside itself
    expect(typeof cf.customFields).not.toBe("object");
  });

  // ── 5. Personal / gmail.com emails accepted ───────────────────────────────

  it("accepts gmail.com email without rejection", async () => {
    const ctx = makeContext();
    const input = {
      campaignId: CAMPAIGN_ID,
      contacts: [{ email: "user@gmail.com", name: "Gmail User" }],
    };
    await saveEnrichedContactsTool.handler(input, ctx);
    // saveRecipientsBulk must have been called (contact was not dropped)
    expect(context_saveRecipientsBulkMock(ctx)).toHaveBeenCalled();
    const [sent] = getSentContacts(ctx);
    expect(sent!.email).toBe("user@gmail.com");
  });

  it("accepts example.com email (test / dev scenario)", async () => {
    const ctx = makeContext();
    const input = {
      campaignId: CAMPAIGN_ID,
      contacts: [{ email: "dev@example.com", name: "Dev" }],
    };
    await saveEnrichedContactsTool.handler(input, ctx);
    const [sent] = getSentContacts(ctx);
    expect(sent!.email).toBe("dev@example.com");
  });

  // ── 6. Missing email dropped pre-backend ──────────────────────────────────

  it("drops contacts with missing email and returns them as rejected with missing_email", async () => {
    const ctx = makeContext({ saved: 0, skipped: 0 });
    const input = {
      campaignId: CAMPAIGN_ID,
      contacts: [{ name: "No Email Contact", company: "Acme" }],
    };
    const result = await saveEnrichedContactsTool.handler(input, ctx);
    // saveRecipientsBulk must NOT be called when all contacts are pre-dropped
    expect(context_saveRecipientsBulkMock(ctx)).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.saved).toBe(0);
      expect(result.data.rejected.length).toBeGreaterThan(0);
      expect(result.data.rejected[0]!.reason).toBe("missing_email");
    }
  });

  it("saves valid contacts and drops only the invalid ones", async () => {
    const saveRecipientsBulk = vi.fn().mockResolvedValue({ saved: 1, skipped: 0, rejected: [] });
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({ saveRecipientsBulk }),
    });
    const input = {
      campaignId: CAMPAIGN_ID,
      contacts: [
        { email: "valid@acme.com", name: "Valid" },
        { name: "No Email" },                        // dropped
      ],
    };
    await saveEnrichedContactsTool.handler(input, ctx);
    // Only the valid contact should have been sent
    const [, sentContacts] = saveRecipientsBulk.mock.calls[0]! as [unknown, Array<Record<string, unknown>>];
    expect(sentContacts.length).toBe(1);
    expect(sentContacts[0]!.email).toBe("valid@acme.com");
  });

  // ── 7. Correct endpoint: bulk JSON, never CSV ─────────────────────────────

  it("calls saveRecipientsBulk not saveRecipientsCsv", async () => {
    const saveRecipientsCsv = vi.fn();
    const saveRecipientsBulk = vi.fn().mockResolvedValue({ saved: 1, skipped: 0 });
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({ saveRecipientsCsv, saveRecipientsBulk }),
    });
    await saveEnrichedContactsTool.handler(validInput, ctx);
    expect(saveRecipientsCsv).not.toHaveBeenCalled();
    expect(saveRecipientsBulk).toHaveBeenCalledOnce();
  });

  // ── 8. Correct result shape ───────────────────────────────────────────────

  it("returns toolSuccess with saved and skipped counts", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        saveRecipientsBulk: vi.fn().mockResolvedValue({ saved: 2, skipped: 1 }),
      }),
    });
    const input = {
      campaignId: CAMPAIGN_ID,
      contacts: [
        { email: "a@b.com", name: "A" },
        { email: "c@d.com", name: "C" },
        { email: "e@f.com", name: "E" },
      ],
    };
    const result = await saveEnrichedContactsTool.handler(input, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.saved).toBe(2);
      expect(result.data.skipped).toBe(1);
    }
  });

  // ── 9. Backend rejected array forwarded ──────────────────────────────────

  it("forwards the rejected array from the backend response", async () => {
    const backendRejected = [{ email: "dup@acme.com", reason: "duplicate" }];
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        saveRecipientsBulk: vi.fn().mockResolvedValue({
          saved: 1, skipped: 1, rejected: backendRejected,
        }),
      }),
    });
    const result = await saveEnrichedContactsTool.handler(validInput, ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rejected).toEqual(backendRejected);
    }
  });

  // ── 10. Error handling ────────────────────────────────────────────────────

  it("returns toolFailure when saveRecipientsBulk throws MailFlowApiError", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        saveRecipientsBulk: vi.fn().mockRejectedValue(
          new MailFlowApiError(422, "Failed to save recipients", { success: false }),
        ),
      }),
    });
    const result = await saveEnrichedContactsTool.handler(validInput, ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe(ErrorCode.MAILFLOW_API_ERROR);
    }
  });

  it("returns toolFailure on unexpected errors", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        saveRecipientsBulk: vi.fn().mockRejectedValue(new Error("Network error")),
      }),
    });
    const result = await saveEnrichedContactsTool.handler(validInput, ctx);
    expect(result.success).toBe(false);
  });

  // ── 11. Tool metadata ─────────────────────────────────────────────────────

  it("tool name matches TOOL_NAMES.SAVE_ENRICHED_CONTACTS", () => {
    expect(saveEnrichedContactsTool.name).toBe(TOOL_NAMES.SAVE_ENRICHED_CONTACTS);
  });
});

// ── Internal helper ───────────────────────────────────────────────────────────

function context_saveRecipientsBulkMock(ctx: ReturnType<typeof createMockToolContext>) {
  return ctx.mailflow.saveRecipientsBulk as ReturnType<typeof vi.fn>;
}
