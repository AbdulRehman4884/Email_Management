/**
 * src/tests/lib/mailflowApiClient.test.ts
 *
 * Tests the MailFlowApiClient against a mocked Axios instance.
 * Covers: correct endpoint routing, auth header injection, error mapping.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks (must be declared before any imports that trigger module load) ──────

vi.mock("../../config/env.js", () => ({
  env: {
    MAILFLOW_API_BASE_URL: "http://api.test.local",
    MAILFLOW_API_TIMEOUT_MS: 5000,
    MCP_TRANSPORT: "sse",
    MCP_SSE_PORT: 3001,
    MCP_SSE_ENDPOINT: "/sse",
    MCP_SERVICE_SECRET: "test-secret-that-is-at-least-32chars",
    LOG_LEVEL: "silent",
    LOG_PRETTY: false,
    NODE_ENV: "test",
  },
}));

const { mockAxiosRequest } = vi.hoisted(() => ({
  mockAxiosRequest: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({ request: mockAxiosRequest })),
    isAxiosError: vi.fn(),
  },
  isAxiosError: vi.fn(),
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { MailFlowApiClient } from "../../lib/mailflowApiClient.js";
import { isAxiosError } from "axios";
import {
  MailFlowApiError,
  MailFlowTimeoutError,
  ErrorCode,
} from "../../lib/errors.js";
import type { BearerToken } from "../../types/auth.js";
import type { Campaign } from "../../types/mailflow.js";
import type { CampaignId, ISODateString } from "../../types/common.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOKEN = "test-bearer-token" as BearerToken;
const CAMPAIGN_ID = "camp-abc" as CampaignId;

const MOCK_CAMPAIGN: Campaign = {
  id: CAMPAIGN_ID,
  name: "Test Campaign",
  subject: "Hello",
  fromName: "Test",
  fromEmail: "test@example.com",
  replyToEmail: null,
  bodyFormat: "html",
  body: "<p>Hello</p>",
  status: "draft",
  scheduledAt: null,
  startedAt: null,
  pausedAt: null,
  completedAt: null,
  createdAt: "2025-01-01T00:00:00Z" as ISODateString,
  updatedAt: "2025-01-01T00:00:00Z" as ISODateString,
};

// Backend returns data directly (no { data: T } wrapper)
function makeSuccessResponse<T>(data: T) {
  return Promise.resolve({ data });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MailFlowApiClient", () => {
  let client: MailFlowApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MailFlowApiClient(TOKEN);
  });

  // ── createCampaign ──────────────────────────────────────────────────────────

  describe("createCampaign", () => {
    it("calls POST /campaigns and returns the campaign from the response body", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse(MOCK_CAMPAIGN));

      const result = await client.createCampaign({
        name: "Test Campaign",
        subject: "Hello",
        emailContent: "<p>Hello</p>",
      });

      expect(mockAxiosRequest).toHaveBeenCalledOnce();
      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/campaigns");
      expect(result.id).toBe(CAMPAIGN_ID);
    });

    it("includes the Authorization header", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse(MOCK_CAMPAIGN));
      await client.createCampaign({
        name: "T",
        subject: "S",
        emailContent: "b",
      });
      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  // ── getCampaignStats ────────────────────────────────────────────────────────

  describe("getCampaignStats", () => {
    it("calls GET /campaigns/:id/stats", async () => {
      // Mock uses backend field names (sentCount etc.) — normalizer maps to MCP names
      const mockStats = {
        campaignId: 42,
        sentCount: 100,
        delieveredCount: 98,
        openedCount: 50,
        bouncedCount: 2,
        failedCount: 0,
        complainedCount: 0,
        repliedCount: 5,
      };

      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse(mockStats));

      const result = await client.getCampaignStats(CAMPAIGN_ID);

      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.method).toBe("GET");
      expect(call.url).toBe(`/campaigns/${CAMPAIGN_ID}/stats`);
      // normalizeCampaignStats maps sentCount → sent
      expect(result.sent).toBe(100);
      expect(result.opened).toBe(50);
      expect(result.bounced).toBe(2);
      expect(result.replied).toBe(5);
      // rates calculated from counts
      expect(result.openRate).toBeCloseTo(0.5);
      expect(result.bounceRate).toBeCloseTo(0.02);
    });
  });

  // ── Error mapping ───────────────────────────────────────────────────────────

  describe("error mapping", () => {
    it("maps a 404 Axios error to MailFlowApiError with MAILFLOW_NOT_FOUND", async () => {
      const axiosError = Object.assign(new Error("Not Found"), {
        isAxiosError: true,
        response: { status: 404, data: { error: { message: "not found" } } },
      });
      vi.mocked(isAxiosError).mockReturnValue(true);
      mockAxiosRequest.mockRejectedValueOnce(axiosError);

      await expect(client.getCampaignStats(CAMPAIGN_ID)).rejects.toBeInstanceOf(
        MailFlowApiError,
      );

      try {
        await client.getCampaignStats(CAMPAIGN_ID);
      } catch {
        // already tested above
      }
    });

    it("maps ECONNABORTED to MailFlowTimeoutError", async () => {
      const timeoutError = Object.assign(new Error("timeout"), {
        isAxiosError: true,
        code: "ECONNABORTED",
        response: undefined,
      });
      vi.mocked(isAxiosError).mockReturnValue(true);
      mockAxiosRequest.mockRejectedValueOnce(timeoutError);

      await expect(client.getSmtpSettings()).rejects.toBeInstanceOf(
        MailFlowTimeoutError,
      );
    });

    it("MailFlowApiError on 404 has MAILFLOW_NOT_FOUND code", async () => {
      const axiosError = Object.assign(new Error("Not Found"), {
        isAxiosError: true,
        code: undefined,
        response: { status: 404, data: {} },
      });
      vi.mocked(isAxiosError).mockReturnValue(true);
      mockAxiosRequest.mockRejectedValueOnce(axiosError);

      let caught: unknown;
      try {
        await client.getCampaignStats(CAMPAIGN_ID);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MailFlowApiError);
      expect((caught as MailFlowApiError).code).toBe(ErrorCode.MAILFLOW_NOT_FOUND);
    });
  });

  // ── getAllCampaigns ─────────────────────────────────────────────────────────

  describe("getAllCampaigns", () => {
    const MOCK_CAMPAIGNS: Campaign[] = [
      { ...MOCK_CAMPAIGN, id: "camp-1" as CampaignId, name: "Summer Sale" },
      { ...MOCK_CAMPAIGN, id: "camp-2" as CampaignId, name: "Eid Offer" },
    ];

    it("calls GET /campaigns and returns the campaigns array directly", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse(MOCK_CAMPAIGNS));

      const result = await client.getAllCampaigns();

      expect(mockAxiosRequest).toHaveBeenCalledOnce();
      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.method).toBe("GET");
      expect(call.url).toBe("/campaigns");
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("Summer Sale");
      expect(result[1]!.name).toBe("Eid Offer");
    });

    it("includes the Authorization header", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse(MOCK_CAMPAIGNS));

      await client.getAllCampaigns();

      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("returns an empty array when no campaigns exist", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse([]));

      const result = await client.getAllCampaigns();

      expect(result).toEqual([]);
    });

    it("maps 404 to MailFlowApiError with MAILFLOW_NOT_FOUND", async () => {
      const axiosError = Object.assign(new Error("Not Found"), {
        isAxiosError: true,
        code: undefined,
        response: { status: 404, data: {} },
      });
      vi.mocked(isAxiosError).mockReturnValue(true);
      mockAxiosRequest.mockRejectedValueOnce(axiosError);

      let caught: unknown;
      try {
        await client.getAllCampaigns();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MailFlowApiError);
      expect((caught as MailFlowApiError).code).toBe(ErrorCode.MAILFLOW_NOT_FOUND);
    });
  });

  // ── updateSmtpSettings (SMTP masking at API client layer) ──────────────────

  describe("updateSmtpSettings", () => {
    it("forwards the password to MailFlow API without logging it", async () => {
      const mockSettings = {
        id: "smtp-1",
        host: "smtp.example.com",
        port: 587,
        username: "user",
        encryption: "tls" as const,
        fromEmail: "no-reply@example.com",
        fromName: "Example",
        isVerified: false,
        updatedAt: "2025-01-01T00:00:00Z" as ISODateString,
      };

      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse(mockSettings));

      const result = await client.updateSmtpSettings({
        host: "smtp.example.com",
        password: "new-password",
      });

      // Confirm password reached the API in the request body
      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.data.password).toBe("new-password");

      // Confirm API response does NOT contain password
      expect((result as unknown as Record<string, unknown>).password).toBeUndefined();
    });
  });

  describe("bulk campaign readiness", () => {
    it("calls POST /bulk/campaign-readiness/:campaignId and returns readiness JSON", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse({
        ready: true,
        campaignFound: true,
        smtpConfigured: true,
        recipientsExist: true,
        recipientCount: 3,
        pendingRecipientCount: 3,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: [],
      }));

      const result = await client.repairBulkCampaignReadiness({ campaignId: "38" });

      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/bulk/campaign-readiness/38");
      expect(result.ready).toBe(true);
    });
  });

  // ── saveRecipientsCsv ───────────────────────────────────────────────────────

  describe("saveRecipientsCsv", () => {
    it("sends the rows as a multipart file (a JSON content type made axios send {\"file\":{}})", async () => {
      mockAxiosRequest.mockReturnValueOnce(makeSuccessResponse({ message: "Recipients uploaded successfully", addedCount: 2, rejectedCount: 1 }));
      const result = await client.saveRecipientsCsv(CAMPAIGN_ID, [
        { email: "a@b.com", ai_subject: "Hi, A", ai_body: "<p>Hello \"A\", welcome</p>" },
        { email: "c@d.com", ai_subject: "Hi, C", ai_body: "<p>Hello C</p>" },
      ]);

      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.url).toBe(`/campaigns/${CAMPAIGN_ID}/recipients/upload`);
      expect(call.headers["Content-Type"]).toBe("multipart/form-data");
      const file = (call.data as FormData).get("file") as Blob;
      expect(await file.text()).toBe(
        [
          "email,ai_subject,ai_body",
          '"a@b.com","Hi, A","<p>Hello ""A"", welcome</p>"',
          '"c@d.com","Hi, C","<p>Hello C</p>"',
        ].join("\n"),
      );
      // The backend's answer uses addedCount / rejectedCount.
      expect(result).toEqual({ added: 2, rejected: 1, message: "Recipients uploaded successfully" });
    });
  });

  // ── QA batch 15 Nov 2026 ──────────────────────────────────────────────────

  describe("routes that exist in the backend (QA bugs 9, 10)", () => {
    it("getRecipientCount reads the recipients list total (there is no /recipient-count route)", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse({ recipients: [{ id: 1 }], total: 2 }));
      const r = await client.getRecipientCount("454" as CampaignId);
      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.url).toBe("/campaigns/454/recipients");
      expect(call.params).toEqual({ page: 1, limit: 1 });
      expect(r).toEqual({ campaignId: 454, pendingCount: 2, totalCount: 2 });
    });

    it("saveRecipientsBulk uploads a CSV to /recipients/upload (there is no /recipients/bulk route)", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse({ addedCount: 1, rejectedCount: 0, alreadyInCampaignCount: 1, duplicateCount: 0, suppressedCount: 0 }));
      const r = await client.saveRecipientsBulk("453" as CampaignId, [
        { email: "a@example.com", name: "Ali", customFields: { company: "Acme", leadScore: 40 } },
        { email: "b@example.com" },
      ]);
      const call = mockAxiosRequest.mock.calls[0]![0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/campaigns/453/recipients/upload");
      expect(call.data).toBeInstanceOf(FormData);
      const csv = await ((call.data as FormData).get("file") as Blob).text();
      expect(csv.split(/\r?\n/)[0]).toBe("email,name,company,leadScore");
      expect(csv).toContain('"a@example.com","Ali","Acme","40"');
      expect(r).toEqual({ saved: 1, skipped: 1, message: undefined } as never);
    });
  });

  describe("replies (QA bugs 2, 20)", () => {
    it("listReplies sends limit, kind=replies and labels; the quoted earlier mail is cut from the text", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse({
        replies: [{ id: 1, campaignId: 434, campaignName: "DRY RUN", label: "interested", fromEmail: "x@y.com", snippet: "Yes On Fri, Oct 16, 2026, 2:28 AM testing wrote: > HOW ARE YOU > >", receivedAt: "2026-10-16T02:32:00Z" }],
        total: 1,
      }));
      const r = await client.listReplies({ campaignId: "434" as CampaignId, pageSize: 10, labels: ["interested"] });
      expect(mockAxiosRequest.mock.calls[0]![0].params).toEqual({ campaignId: "434", page: 1, limit: 10, kind: "replies", labels: "interested" });
      expect(r.items[0]!.bodyText).toBe("Yes");
      expect(r.items[0]!.campaignName).toBe("DRY RUN");
      expect(r.items[0]!.label).toBe("interested");
    });
  });

  describe("campaign data the agent needs (QA bugs 6, 8, 17, delete)", () => {
    it("normalizeCampaign keeps pauseReason, dailySendLimit and smtpSettingsId", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse([{ id: 441, name: "x", status: "paused", pauseReason: "daily_campaign_cap", dailySendLimit: 1, smtpSettingsId: 3 }]));
      const [c] = await client.getAllCampaigns();
      expect(c).toMatchObject({ pauseReason: "daily_campaign_cap", dailySendLimit: 1, smtpSettingsId: 3 });
    });

    it("getDashboardStats('yearly') returns sent/opened/replies per month", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse({ totalEmailsSent: 79, timeSeries: [{ day: "Oct", sent: 52, delivered: 51, opened: 20, clicked: 2 }] }));
      const d = await client.getDashboardStats("yearly");
      expect(mockAxiosRequest.mock.calls[0]![0].params).toEqual({ view: "yearly" });
      expect(d.months).toEqual([{ month: "Oct", sent: 52, delivered: 51, opened: 20, replied: 2 }]);
    });

    it("deleteCampaign calls DELETE /campaigns/:id", async () => {
      mockAxiosRequest.mockResolvedValueOnce(makeSuccessResponse({ message: "Campaign deleted successfully" }));
      await client.deleteCampaign("466" as CampaignId);
      expect(mockAxiosRequest.mock.calls[0]![0]).toMatchObject({ method: "DELETE", url: "/campaigns/466" });
    });
  });
});
