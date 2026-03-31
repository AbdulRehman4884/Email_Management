/**
 * src/tests/tools/createCampaign.tool.test.ts
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { createCampaignTool } from "../../mcp/tools/campaign/createCampaign.tool.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";
import type { Campaign } from "../../types/mailflow.js";
import type { CampaignId } from "../../types/common.js";
import { MailFlowApiError } from "../../lib/errors.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const validInput = {
  name: "Q4 Campaign",
  subject: "Hello",
  fromName: "Acme",
  fromEmail: "acme@example.com",
  body: "<p>Hi</p>",
  bodyFormat: "html" as const,
};

const mockCampaign: Campaign = {
  id: "camp-1" as CampaignId,
  name: "Q4 Campaign",
  subject: "Hello",
  fromName: "Acme",
  fromEmail: "acme@example.com",
  replyToEmail: null,
  bodyFormat: "html",
  body: "<p>Hi</p>",
  status: "draft",
  scheduledAt: null,
  startedAt: null,
  pausedAt: null,
  completedAt: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createCampaignTool.handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns toolSuccess with the created campaign on success", async () => {
    const mailflow = createMockMailflowClient({
      createCampaign: vi.fn().mockResolvedValue(mockCampaign),
    });
    const context = createMockToolContext({ mailflow });

    const result = await createCampaignTool.handler(validInput, context);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("camp-1");
      expect(result.data.status).toBe("draft");
    }
  });

  it("calls mailflow.createCampaign with the correct payload", async () => {
    const createCampaign = vi.fn().mockResolvedValue(mockCampaign);
    const context = createMockToolContext({
      mailflow: createMockMailflowClient({ createCampaign }),
    });

    await createCampaignTool.handler(validInput, context);

    expect(createCampaign).toHaveBeenCalledOnce();
    const [payload] = createCampaign.mock.calls[0]!;
    expect(payload.name).toBe(validInput.name);
    expect(payload.fromEmail).toBe(validInput.fromEmail);
  });

  it("returns toolFailure when the MailFlow API returns a 409 conflict", async () => {
    const mailflow = createMockMailflowClient({
      createCampaign: vi.fn().mockRejectedValue(
        new MailFlowApiError(409, "Campaign name already exists"),
      ),
    });
    const context = createMockToolContext({ mailflow });

    const result = await createCampaignTool.handler(validInput, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MAILFLOW_CONFLICT");
    }
  });

  it("returns toolFailure when the API is unavailable (503)", async () => {
    const mailflow = createMockMailflowClient({
      createCampaign: vi.fn().mockRejectedValue(
        new MailFlowApiError(503, "Service unavailable"),
      ),
    });
    const context = createMockToolContext({ mailflow });

    const result = await createCampaignTool.handler(validInput, context);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MAILFLOW_UNAVAILABLE");
    }
  });

  it("has name matching TOOL_NAMES.CREATE_CAMPAIGN constant", () => {
    expect(createCampaignTool.name).toBe("create_campaign");
  });
});
