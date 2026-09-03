/**
 * src/tests/tools/addRecipients.tool.test.ts
 *
 * Tests the addRecipientsTool handler in isolation.
 *
 * Covers:
 *  1. Single email → calls saveRecipientsBulk with correct payload
 *  2. Multiple emails → all passed through
 *  3. Email + optional name → name forwarded in recipient entry
 *  4. Returns toolSuccess with saved/skipped counts from backend
 *  5. Returns toolFailure on MailFlowApiError
 *  6. Tool name matches TOOL_NAMES.ADD_RECIPIENTS constant
 *  7. Does NOT hardcode any specific email address
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { addRecipientsTool } from "../../mcp/tools/campaign/addRecipients.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";
import { MailFlowApiError } from "../../lib/errors.js";
import { TOOL_NAMES } from "../../config/constants.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = "99";

function makeContext(bulkResult = { saved: 1, skipped: 0, rejected: [] }) {
  return createMockToolContext({
    mailflow: createMockMailflowClient({
      saveRecipientsBulk: vi.fn().mockResolvedValue(bulkResult),
    }),
  });
}

function getBulkArgs(ctx: ReturnType<typeof makeContext>) {
  const fn = ctx.mailflow.saveRecipientsBulk as ReturnType<typeof vi.fn>;
  return {
    campaignId: fn.mock.calls[0]?.[0] as string,
    recipients: (fn.mock.calls[0]?.[1] ?? []) as Array<Record<string, unknown>>,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addRecipientsTool", () => {

  it("tool name matches TOOL_NAMES.ADD_RECIPIENTS", () => {
    expect(addRecipientsTool.name).toBe(TOOL_NAMES.ADD_RECIPIENTS);
    expect(addRecipientsTool.name).toBe("add_recipients");
  });

  it("single email — calls saveRecipientsBulk with email payload", async () => {
    const ctx = makeContext();
    const result = await addRecipientsTool.handler(
      { campaignId: CAMPAIGN_ID, recipients: [{ email: "alice@example.com" }] },
      ctx,
    );

    expect(result).toMatchObject({ success: true });

    const { campaignId, recipients } = getBulkArgs(ctx);
    expect(campaignId).toBe(CAMPAIGN_ID);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ email: "alice@example.com" });
  });

  it("multiple emails — all passed to saveRecipientsBulk", async () => {
    const ctx = makeContext({ saved: 3, skipped: 0, rejected: [] });
    await addRecipientsTool.handler(
      {
        campaignId: CAMPAIGN_ID,
        recipients: [
          { email: "alpha@example.com" },
          { email: "beta@example.com" },
          { email: "gamma@example.com" },
        ],
      },
      ctx,
    );

    const { recipients } = getBulkArgs(ctx);
    expect(recipients).toHaveLength(3);
    expect(recipients.map((r) => r.email)).toEqual([
      "alpha@example.com",
      "beta@example.com",
      "gamma@example.com",
    ]);
  });

  it("email + name — name forwarded in recipient entry", async () => {
    const ctx = makeContext();
    await addRecipientsTool.handler(
      {
        campaignId: CAMPAIGN_ID,
        recipients: [{ email: "bob@example.com", name: "Bob Smith" }],
      },
      ctx,
    );

    const { recipients } = getBulkArgs(ctx);
    expect(recipients[0]).toMatchObject({ email: "bob@example.com", name: "Bob Smith" });
  });

  it("returns toolSuccess with saved and skipped counts from backend", async () => {
    const ctx = makeContext({ saved: 2, skipped: 1, rejected: [] });
    const result = await addRecipientsTool.handler(
      {
        campaignId: CAMPAIGN_ID,
        recipients: [
          { email: "a@example.com" },
          { email: "b@example.com" },
          { email: "a@example.com" },  // duplicate — backend skips this
        ],
      },
      ctx,
    );

    expect(result).toMatchObject({
      success: true,
      data: { saved: 2, skipped: 1 },
    });
  });

  it("returns toolFailure when backend throws MailFlowApiError", async () => {
    const ctx = createMockToolContext({
      mailflow: createMockMailflowClient({
        saveRecipientsBulk: vi.fn().mockRejectedValue(
          new MailFlowApiError(404, "Campaign not found"),
        ),
      }),
    });

    const result = await addRecipientsTool.handler(
      { campaignId: CAMPAIGN_ID, recipients: [{ email: "x@example.com" }] },
      ctx,
    );

    expect(result).toMatchObject({ success: false });
    expect((result as { error: { code: string } }).error.code).toMatch(/^MAILFLOW_/);
  });

  it("does not hardcode any specific email address", () => {
    const toolCode = addRecipientsTool.handler.toString();
    // No hardcoded email should appear in the handler source
    expect(toolCode).not.toMatch(/saadhaider/i);
    expect(toolCode).not.toMatch(/gmail\.com/i);
  });
});
