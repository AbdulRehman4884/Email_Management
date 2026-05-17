/**
 * src/tests/tools/generatePersonalizedEmails.tool.test.ts
 *
 * Tests the generatePersonalizedEmailsTool handler in isolation.
 *
 * Covers:
 *   1. No existing emails → calls generatePersonalizedEmails and returns result
 *   2. Existing emails (no overwrite) → returns alreadyExists: true, skips generation
 *   3. Existing emails + overwrite: true → skips check, generates normally
 *   4. getPersonalizedEmails throws → propagates as toolFailure
 *   5. generatePersonalizedEmails throws → propagates as toolFailure
 *   6. Tool name matches TOOL_NAMES.GENERATE_PERSONALIZED_EMAILS constant
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { generatePersonalizedEmailsTool } from "../../mcp/tools/campaign/generatePersonalizedEmails.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";
import { MailFlowApiError } from "../../lib/errors.js";
import { TOOL_NAMES } from "../../config/constants.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = "42";

const GENERATION_RESULT = {
  message:         "Personalized email generation complete",
  campaignId:      42,
  totalRecipients: 3,
  generatedCount:  3,
  failedCount:     0,
};

const NO_EXISTING = { campaignId: 42, total: 0, emails: [] };
const HAS_EXISTING = {
  campaignId: 42,
  total:      5,
  emails:     [{ id: 1, recipientId: 10, personalizedSubject: null, personalizedBody: "<p>Hi</p>", generationStatus: "generated", recipientEmail: "a@b.com", recipientName: "A" }],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("generatePersonalizedEmailsTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── 1. No existing emails → generate ─────────────────────────────────────

  it("generates emails when no existing emails are found", async () => {
    const generatePersonalizedEmails = vi.fn().mockResolvedValue(GENERATION_RESULT);
    const getPersonalizedEmails      = vi.fn().mockResolvedValue(NO_EXISTING);
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({ generatePersonalizedEmails, getPersonalizedEmails }),
    });

    const result = await generatePersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, ctx);

    expect(getPersonalizedEmails).toHaveBeenCalledOnce();
    expect(generatePersonalizedEmails).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generatedCount).toBe(3);
      expect(result.data.alreadyExists).toBeFalsy();
    }
  });

  // ── 2. Existing emails without overwrite → guard fires ────────────────────

  it("returns alreadyExists: true and skips generation when emails exist", async () => {
    const generatePersonalizedEmails = vi.fn();
    const getPersonalizedEmails      = vi.fn().mockResolvedValue(HAS_EXISTING);
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({ generatePersonalizedEmails, getPersonalizedEmails }),
    });

    const result = await generatePersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, ctx);

    expect(getPersonalizedEmails).toHaveBeenCalledOnce();
    expect(generatePersonalizedEmails).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alreadyExists).toBe(true);
      expect(result.data.existingCount).toBe(5);
      expect(result.data.generatedCount).toBe(0);
    }
  });

  it("existing email message includes the count", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails:      vi.fn().mockResolvedValue(HAS_EXISTING),
        generatePersonalizedEmails: vi.fn(),
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toMatch(/5/);
    }
  });

  // ── 3. Existing emails + overwrite: true → bypasses guard ────────────────

  it("skips the existing-email check and generates when overwrite is true", async () => {
    const generatePersonalizedEmails = vi.fn().mockResolvedValue(GENERATION_RESULT);
    const getPersonalizedEmails      = vi.fn().mockResolvedValue(HAS_EXISTING);
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({ generatePersonalizedEmails, getPersonalizedEmails }),
    });

    const result = await generatePersonalizedEmailsTool.handler(
      { campaignId: CAMPAIGN_ID, overwrite: true },
      ctx,
    );

    expect(getPersonalizedEmails).not.toHaveBeenCalled();
    expect(generatePersonalizedEmails).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alreadyExists).toBeFalsy();
      expect(result.data.generatedCount).toBe(3);
    }
  });

  // ── 4. getPersonalizedEmails throws → toolFailure ─────────────────────────

  it("returns toolFailure when getPersonalizedEmails throws", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails:      vi.fn().mockRejectedValue(
          new MailFlowApiError(500, "Internal server error", {}),
        ),
        generatePersonalizedEmails: vi.fn(),
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, ctx);

    expect(result.success).toBe(false);
  });

  // ── 5. generatePersonalizedEmails throws → toolFailure ───────────────────

  it("returns toolFailure when generatePersonalizedEmails throws", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        getPersonalizedEmails:      vi.fn().mockResolvedValue(NO_EXISTING),
        generatePersonalizedEmails: vi.fn().mockRejectedValue(
          new MailFlowApiError(422, "No recipients", {}),
        ),
      }),
    });

    const result = await generatePersonalizedEmailsTool.handler({ campaignId: CAMPAIGN_ID }, ctx);

    expect(result.success).toBe(false);
  });

  // ── 6. Tool metadata ──────────────────────────────────────────────────────

  it("tool name matches TOOL_NAMES.GENERATE_PERSONALIZED_EMAILS", () => {
    expect(generatePersonalizedEmailsTool.name).toBe(TOOL_NAMES.GENERATE_PERSONALIZED_EMAILS);
  });
});
