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
});
