/**
 * src/lib/mailflowApiClient.ts
 *
 * The single Axios-based HTTP client for all MailFlow backend API calls.
 *
 * Design rules:
 *  - One shared Axios base instance (connection pool, no auth)
 *  - Auth header injected per request via private `request()` — never stored globally
 *  - All responses unwrapped from the `{ data: T }` MailFlow envelope
 *  - All errors mapped to typed domain errors (MailFlowApiError, MailFlowTimeoutError)
 *  - SMTP password is never logged, never returned in method outputs
 *  - Bearer token is never logged
 *  - Tools must not import Axios directly — use this client exclusively
 */

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  isAxiosError,
} from "axios";
import { env } from "../config/env.js";
import {
  MAILFLOW_PATHS,
  MASKED_VALUE,
} from "../config/constants.js";
import { createLogger } from "./logger.js";
import {
  MailFlowApiError,
  MailFlowTimeoutError,
} from "./errors.js";
import type { ApiResponse } from "../types/common.js";
import type { BearerToken } from "../types/auth.js";
import type {
  Campaign,
  CampaignStats,
  CreateCampaignRequest,
  ListRepliesParams,
  ListRepliesResult,
  SmtpSettings,
  UpdateCampaignRequest,
  UpdateSmtpSettingsRequest,
} from "../types/mailflow.js";
import type { CampaignId } from "../types/common.js";

const log = createLogger("mailflowApiClient");

// ── IMailFlowApiClient ────────────────────────────────────────────────────────
//
// Exported interface used by ToolContext. Defined here (not in toolContext.ts)
// so it lives next to its implementation and can evolve together with it.

export interface IMailFlowApiClient {
  createCampaign(data: CreateCampaignRequest): Promise<Campaign>;
  updateCampaign(id: CampaignId, data: UpdateCampaignRequest): Promise<Campaign>;
  startCampaign(id: CampaignId): Promise<Campaign>;
  pauseCampaign(id: CampaignId): Promise<Campaign>;
  resumeCampaign(id: CampaignId): Promise<Campaign>;
  getCampaignStats(id: CampaignId): Promise<CampaignStats>;
  listReplies(params: ListRepliesParams): Promise<ListRepliesResult>;
  getSmtpSettings(): Promise<SmtpSettings>;
  updateSmtpSettings(data: UpdateSmtpSettingsRequest): Promise<SmtpSettings>;
}

// ── Shared Axios base instance ────────────────────────────────────────────────
//
// One instance per process lifetime. No auth headers here — auth is injected
// per request via the `request()` private method. This preserves connection
// pooling while ensuring tokens are scoped to individual client instances.

const sharedAxios: AxiosInstance = axios.create({
  baseURL: env.MAILFLOW_API_BASE_URL,
  timeout: env.MAILFLOW_API_TIMEOUT_MS,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ── Error mapping ─────────────────────────────────────────────────────────────

function mapAxiosError(path: string, err: unknown): never {
  if (isAxiosError(err)) {
    if (err.code === "ECONNABORTED" || err.code === "ERR_CANCELED") {
      throw new MailFlowTimeoutError(path, err);
    }

    const status = err.response?.status ?? 0;
    const body = err.response?.data as unknown;

    // Log without leaking response body secrets; status and path are safe
    log.warn(
      { path, httpStatus: status },
      "MailFlow API request failed",
    );

    throw new MailFlowApiError(status, `MailFlow API error on ${path}`, body, err);
  }

  // Non-Axios error (e.g. network tear-down)
  log.error({ path, err }, "Unexpected error calling MailFlow API");
  throw new MailFlowApiError(0, `Unexpected error calling MailFlow API on ${path}`, undefined, err);
}

// ── Log helpers ───────────────────────────────────────────────────────────────

/** Sanitize UpdateSmtpSettingsRequest for safe logging — mask password */
function maskSmtpRequest(data: UpdateSmtpSettingsRequest): Record<string, unknown> {
  return {
    ...data,
    ...(data.password !== undefined ? { password: MASKED_VALUE } : {}),
    ...(data.username !== undefined ? { username: MASKED_VALUE } : {}),
  };
}

// ── MailFlowApiClient ─────────────────────────────────────────────────────────

export class MailFlowApiClient implements IMailFlowApiClient {
  constructor(private readonly bearerToken: BearerToken) {}

  // ── Core request wrapper ────────────────────────────────────────────────────

  private async request<T>(
    config: AxiosRequestConfig & { url: string },
  ): Promise<T> {
    const startMs = Date.now();

    try {
      const response = await sharedAxios.request<ApiResponse<T>>({
        ...config,
        headers: {
          ...config.headers,
          // Bearer token injected here — never stored on the shared instance
          Authorization: `Bearer ${this.bearerToken}`,
        },
      });

      log.debug(
        { method: config.method, url: config.url, durationMs: Date.now() - startMs },
        "MailFlow API request succeeded",
      );

      return response.data.data;
    } catch (err) {
      mapAxiosError(config.url, err);
    }
  }

  // ── Campaign ────────────────────────────────────────────────────────────────

  async createCampaign(data: CreateCampaignRequest): Promise<Campaign> {
    log.info({ name: data.name, fromEmail: data.fromEmail }, "createCampaign");
    return this.request<Campaign>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGNS,
      data,
    });
  }

  async updateCampaign(
    id: CampaignId,
    data: UpdateCampaignRequest,
  ): Promise<Campaign> {
    log.info({ campaignId: id }, "updateCampaign");
    return this.request<Campaign>({
      method: "PATCH",
      url: MAILFLOW_PATHS.CAMPAIGN_BY_ID(id),
      data,
    });
  }

  async startCampaign(id: CampaignId): Promise<Campaign> {
    log.info({ campaignId: id }, "startCampaign");
    return this.request<Campaign>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGN_START(id),
    });
  }

  async pauseCampaign(id: CampaignId): Promise<Campaign> {
    log.info({ campaignId: id }, "pauseCampaign");
    return this.request<Campaign>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGN_PAUSE(id),
    });
  }

  async resumeCampaign(id: CampaignId): Promise<Campaign> {
    log.info({ campaignId: id }, "resumeCampaign");
    return this.request<Campaign>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGN_RESUME(id),
    });
  }

  async getCampaignStats(id: CampaignId): Promise<CampaignStats> {
    log.info({ campaignId: id }, "getCampaignStats");
    return this.request<CampaignStats>({
      method: "GET",
      url: MAILFLOW_PATHS.CAMPAIGN_STATS(id),
    });
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  async listReplies(params: ListRepliesParams): Promise<ListRepliesResult> {
    log.info(
      { campaignId: params.campaignId, status: params.status, page: params.page },
      "listReplies",
    );
    return this.request<ListRepliesResult>({
      method: "GET",
      url: MAILFLOW_PATHS.REPLIES,
      params,
    });
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getSmtpSettings(): Promise<SmtpSettings> {
    log.info("getSmtpSettings");
    return this.request<SmtpSettings>({
      method: "GET",
      url: MAILFLOW_PATHS.SMTP_SETTINGS,
    });
  }

  async updateSmtpSettings(
    data: UpdateSmtpSettingsRequest,
  ): Promise<SmtpSettings> {
    // Mask sensitive fields before logging
    log.info({ update: maskSmtpRequest(data) }, "updateSmtpSettings");
    return this.request<SmtpSettings>({
      method: "PATCH",
      url: MAILFLOW_PATHS.SMTP_SETTINGS,
      data,
    });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Instantiates a MailFlowApiClient authenticated with the given bearer token.
 * Call this once per tool invocation — clients are lightweight (no Axios instance created).
 */
export function createMailFlowApiClient(
  bearerToken: BearerToken,
): MailFlowApiClient {
  return new MailFlowApiClient(bearerToken);
}
