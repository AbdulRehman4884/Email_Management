/**
 * src/lib/mailflowApiClient.ts
 *
 * The single Axios-based HTTP client for all MailFlow backend API calls.
 *
 * Design rules:
 *  - One shared Axios base instance (connection pool, no auth)
 *  - Auth header injected per request via private `request()` — never stored globally
 *  - All campaign responses normalised via normalizeCampaign() at the boundary
 *  - All errors mapped to typed domain errors (MailFlowApiError, MailFlowTimeoutError)
 *  - SMTP password is never logged, never returned in method outputs
 *  - Bearer token is never logged
 *  - Tools must not import Axios directly — use this client exclusively
 *
 * Backend ↔ MCP type mismatches handled at the boundary:
 *  Campaign (normalizeCampaign):
 *   - id:          integer  → CampaignId (string)
 *   - emailContent → body
 *   - in_progress  → running (status normalisation)
 *   - createdAt date-only str → ISO timestamp
 *   - missing fields filled as null/"html"
 *  Action responses (start/pause/resume): backend returns {status, message}
 *   - synthesize Campaign from known id + status
 *  CampaignStats (normalizeCampaignStats):
 *   - sentCount/delieveredCount/openedCount/repliedCount/bouncedCount → MCP names
 *   - rates calculated from counts
 *  SmtpSettings (normalizeSmtpSettings):
 *   - user → username, secure(bool) → encryption(string), hasPassword → isVerified
 *  ListReplies (normalizeListReplies):
 *   - replies[] → PaginatedResult<Reply> with items/total/page/pageSize/hasNextPage
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
import type { BearerToken } from "../types/auth.js";
import type {
  Campaign,
  CampaignStats,
  CampaignStatus,
  CreateCampaignRequest,
  ListRepliesParams,
  ListRepliesResult,
  Reply,
  ReplyIntelligenceSummary,
  ReplyLeadListResult,
  ReplySuggestionResult,
  AutonomousRecommendationResult,
  CampaignAutonomousRecommendationsResult,
  CampaignAutonomousSummaryResult,
  SequenceAdaptationPreviewResult,
  ReplyStatus,
  SmtpSettings,
  UpdateCampaignRequest,
  UpdateSmtpSettingsRequest,
  RecipientCountResult,
  AiPromptSaveResult,
  PersonalizedEmailGenerationResult,
  PersonalizedEmailsResult,
  SaveAiPromptRequest,
  GeneratePersonalizedEmailsRequest,
  CsvSaveResult,
  BulkSaveResult,
  BulkRejectedEntry,
  SequenceProgressResult,
  PendingFollowUpsResult,
  RecipientSequenceHistoryResult,
  RecipientSequenceLookupRequest,
} from "../types/mailflow.js";
import type { CampaignId, ISODateString, ReplyId, SmtpSettingsId } from "../types/common.js";

const log = createLogger("mailflowApiClient");

// ── IMailFlowApiClient ────────────────────────────────────────────────────────

export interface IMailFlowApiClient {
  getAllCampaigns(): Promise<Campaign[]>;
  createCampaign(data: CreateCampaignRequest): Promise<Campaign>;
  updateCampaign(id: CampaignId, data: UpdateCampaignRequest): Promise<Campaign>;
  startCampaign(id: CampaignId): Promise<Campaign>;
  pauseCampaign(id: CampaignId): Promise<Campaign>;
  resumeCampaign(id: CampaignId): Promise<Campaign>;
  getCampaignStats(id: CampaignId): Promise<CampaignStats>;
  getSequenceProgress(id: CampaignId): Promise<SequenceProgressResult>;
  getPendingFollowUps(id: CampaignId, limit?: number): Promise<PendingFollowUpsResult>;
  getRecipientTouchHistory(input: RecipientSequenceLookupRequest): Promise<RecipientSequenceHistoryResult>;
  markRecipientReplied(input: RecipientSequenceLookupRequest): Promise<{ message: string }>;
  markRecipientBounced(input: RecipientSequenceLookupRequest): Promise<{ message: string }>;
  listReplies(params: ListRepliesParams): Promise<ListRepliesResult>;
  getReplyIntelligenceSummary(params: { campaignId?: CampaignId }): Promise<ReplyIntelligenceSummary>;
  listHotLeads(params: { campaignId?: CampaignId; limit?: number }): Promise<ReplyLeadListResult>;
  listMeetingReadyLeads(params: { campaignId?: CampaignId; limit?: number }): Promise<ReplyLeadListResult>;
  draftReplySuggestion(replyId: string): Promise<ReplySuggestionResult>;
  markReplyHumanReview(input: { replyId: string; reason?: string }): Promise<{ message: string; replyId: number }>;
  getAutonomousRecommendation(input: { recipientId: string }): Promise<AutonomousRecommendationResult>;
  getCampaignAutonomousRecommendations(input: { campaignId: CampaignId }): Promise<CampaignAutonomousRecommendationsResult>;
  getCampaignAutonomousSummary(input: { campaignId: CampaignId }): Promise<CampaignAutonomousSummaryResult>;
  previewSequenceAdaptation(input: {
    recipientId: string;
    campaignId: CampaignId;
    replyText?: string;
    scenario?: string;
  }): Promise<SequenceAdaptationPreviewResult>;
  getSmtpSettings(): Promise<SmtpSettings>;
  updateSmtpSettings(data: UpdateSmtpSettingsRequest): Promise<SmtpSettings>;
  // Phase 1: AI Campaign
  getRecipientCount(id: CampaignId): Promise<RecipientCountResult>;
  saveAiPrompt(data: SaveAiPromptRequest): Promise<AiPromptSaveResult>;
  generatePersonalizedEmails(
    id: CampaignId,
    options?: Omit<GeneratePersonalizedEmailsRequest, "campaignId" | "overwrite">,
  ): Promise<PersonalizedEmailGenerationResult>;
  getPersonalizedEmails(id: CampaignId, limit?: number): Promise<PersonalizedEmailsResult>;
  // CSV file ingestion
  saveRecipientsCsv(id: CampaignId, rows: Array<Record<string, string>>): Promise<CsvSaveResult>;
  // Bulk JSON recipient save (used by save_enriched_contacts)
  saveRecipientsBulk(id: CampaignId, recipients: Array<Record<string, unknown>>): Promise<BulkSaveResult>;
}

// ── Shared Axios base instance ────────────────────────────────────────────────

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
    const body   = err.response?.data as unknown;

    log.warn(
      { path, httpStatus: status },
      "MailFlow API request failed",
    );

    throw new MailFlowApiError(status, `MailFlow API error on ${path}`, body, err);
  }

  log.error({ path, err }, "Unexpected error calling MailFlow API");
  throw new MailFlowApiError(0, `Unexpected error calling MailFlow API on ${path}`, undefined, err);
}

// ── Log helpers ───────────────────────────────────────────────────────────────

function maskSmtpRequest(data: UpdateSmtpSettingsRequest): Record<string, unknown> {
  return {
    ...data,
    ...(data.password !== undefined ? { password: MASKED_VALUE } : {}),
    ...(data.username !== undefined ? { username: MASKED_VALUE } : {}),
  };
}

// ── Backend → MCP response normalisation ─────────────────────────────────────

function normalizeTimestamp(raw: unknown): ISODateString {
  if (typeof raw !== "string" || !raw) {
    return new Date().toISOString() as ISODateString;
  }
  // Date-only "YYYY-MM-DD" → pad to midnight UTC ISO string
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z` as ISODateString;
  }
  return raw as ISODateString;
}

function normalizeCampaignStatus(raw: unknown): CampaignStatus {
  if (typeof raw !== "string") return "draft";
  // Backend uses "in_progress"; MCP type uses "running"
  if (raw === "in_progress") return "running";
  const valid: CampaignStatus[] = ["draft", "scheduled", "running", "paused", "completed", "cancelled"];
  return valid.includes(raw as CampaignStatus) ? (raw as CampaignStatus) : "draft";
}

/**
 * Normalises a raw backend campaign object to the MCP Campaign type.
 * Safe to call on any unknown payload — unknown/missing fields get safe defaults.
 */
function normalizeCampaign(raw: unknown): Campaign {
  if (!raw || typeof raw !== "object") {
    log.error({ raw }, "normalizeCampaign: received non-object — cannot normalise");
    throw new MailFlowApiError(0, "Backend returned an unexpected campaign shape");
  }

  const d = raw as Record<string, unknown>;

  // id: backend returns integer → convert to string; accept pre-normalised string
  const rawId = d.id;
  const id = (
    typeof rawId === "string" ? rawId :
    typeof rawId === "number" ? String(rawId) :
    ""
  ) as CampaignId;

  // body: backend stores as emailContent
  const body =
    typeof d.emailContent === "string" ? d.emailContent :
    typeof d.body         === "string" ? d.body :
    "";

  return {
    id,
    name:         typeof d.name      === "string" ? d.name      : "",
    subject:      typeof d.subject   === "string" ? d.subject   : "",
    fromName:     typeof d.fromName  === "string" ? d.fromName  : "",
    fromEmail:    typeof d.fromEmail === "string" ? d.fromEmail : "",
    replyToEmail: null,
    bodyFormat:   "html",
    body,
    status:       normalizeCampaignStatus(d.status),
    scheduledAt:  (typeof d.scheduledAt === "string" ? d.scheduledAt : null) as ISODateString | null,
    startedAt:    null,
    pausedAt:     null,
    completedAt:  null,
    createdAt:    normalizeTimestamp(d.createdAt),
    updatedAt:    normalizeTimestamp(d.updatedAt),
  };
}

/**
 * Normalises the backend campaign stats response to the MCP CampaignStats type.
 *
 * Backend field names (with typo):
 *   sentCount, delieveredCount, openedCount, repliedCount, bouncedCount,
 *   failedCount, complainedCount, campaignId (integer)
 *
 * MCP CampaignStats expects:
 *   campaignId(string), sent, delivered, opened, clicked, bounced,
 *   unsubscribed, replied, openRate, clickRate, bounceRate, replyRate, calculatedAt
 */
function normalizeCampaignStats(raw: unknown, campaignId: CampaignId): CampaignStats {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const sent        = typeof d.sentCount        === "number" ? d.sentCount        : 0;
  const delivered   = typeof d.delieveredCount  === "number" ? d.delieveredCount  : 0;
  const opened      = typeof d.openedCount      === "number" ? d.openedCount      : 0;
  const clicked     = 0; // backend does not track click-throughs separately
  const bounced     = typeof d.bouncedCount     === "number" ? d.bouncedCount     : 0;
  const unsubscribed = 0; // not tracked separately by backend
  const replied     = typeof d.repliedCount     === "number" ? d.repliedCount     : 0;

  const openRate    = sent > 0 ? opened    / sent : 0;
  const clickRate   = sent > 0 ? clicked   / sent : 0;
  const bounceRate  = sent > 0 ? bounced   / sent : 0;
  const replyRate   = sent > 0 ? replied   / sent : 0;

  return {
    campaignId,
    sent,
    delivered,
    opened,
    clicked,
    bounced,
    unsubscribed,
    replied,
    openRate,
    clickRate,
    bounceRate,
    replyRate,
    calculatedAt: new Date().toISOString() as ISODateString,
    ...(d.sequence && typeof d.sequence === "object"
      ? { sequence: normalizeSequenceProgress(d.sequence, campaignId) }
      : {}),
  };
}

function normalizeSequenceProgress(raw: unknown, campaignId: CampaignId): SequenceProgressResult {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const touchPerformance = Array.isArray(d.touchPerformance)
    ? (d.touchPerformance as Array<Record<string, unknown>>).map((item) => ({
        touchNumber: typeof item.touchNumber === "number" ? item.touchNumber : Number(item.touchNumber ?? 0),
        planned: typeof item.planned === "number" ? item.planned : Number(item.planned ?? 0),
        sent: typeof item.sent === "number" ? item.sent : Number(item.sent ?? 0),
        replied: typeof item.replied === "number" ? item.replied : Number(item.replied ?? 0),
        bounced: typeof item.bounced === "number" ? item.bounced : Number(item.bounced ?? 0),
        unsubscribed: typeof item.unsubscribed === "number" ? item.unsubscribed : Number(item.unsubscribed ?? 0),
      }))
    : [];
  return {
    campaignId: typeof d.campaignId === "number" ? d.campaignId : Number(campaignId),
    totalRecipients: typeof d.totalRecipients === "number" ? d.totalRecipients : 0,
    activeRecipients: typeof d.activeRecipients === "number" ? d.activeRecipients : 0,
    pausedRecipients: typeof d.pausedRecipients === "number" ? d.pausedRecipients : 0,
    completedRecipients: typeof d.completedRecipients === "number" ? d.completedRecipients : 0,
    stoppedRecipients: typeof d.stoppedRecipients === "number" ? d.stoppedRecipients : 0,
    repliedRecipients: typeof d.repliedRecipients === "number" ? d.repliedRecipients : 0,
    bouncedRecipients: typeof d.bouncedRecipients === "number" ? d.bouncedRecipients : 0,
    unsubscribedRecipients: typeof d.unsubscribedRecipients === "number" ? d.unsubscribedRecipients : 0,
    pendingFollowUps: typeof d.pendingFollowUps === "number" ? d.pendingFollowUps : 0,
    dueFollowUps: typeof d.dueFollowUps === "number" ? d.dueFollowUps : 0,
    touchSendCount: typeof d.touchSendCount === "number" ? d.touchSendCount : 0,
    replyCount: typeof d.replyCount === "number" ? d.replyCount : 0,
    unsubscribeCount: typeof d.unsubscribeCount === "number" ? d.unsubscribeCount : 0,
    bounceCount: typeof d.bounceCount === "number" ? d.bounceCount : 0,
    completionRate: typeof d.completionRate === "number" ? d.completionRate : 0,
    stopReasonBreakdown: d.stopReasonBreakdown && typeof d.stopReasonBreakdown === "object"
      ? d.stopReasonBreakdown as Record<string, number>
      : {},
    touchPerformance,
  };
}

/**
 * Normalises the backend SMTP settings response to the MCP SmtpSettings type.
 *
 * Backend fields: id, provider, host, port, secure(bool), user, password,
 *                 fromName, fromEmail, replyToEmail, trackingBaseUrl, updatedAt, hasPassword
 *
 * MCP SmtpSettings: id, host, port, username, encryption, fromEmail, fromName,
 *                   isVerified, updatedAt
 */
function normalizeSmtpSettings(raw: unknown): SmtpSettings {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const port       = typeof d.port === "number" ? d.port : 587;
  const secure     = d.secure === true;
  const encryption = secure || port === 465 ? "ssl" : port === 587 ? "tls" : "none";

  return {
    id:          (typeof d.id === "number" ? String(d.id) : typeof d.id === "string" ? d.id : "") as SmtpSettingsId,
    host:        typeof d.host      === "string" ? d.host      : "",
    port,
    username:    typeof d.user      === "string" ? d.user      : "",
    encryption:  encryption as "tls" | "ssl" | "none",
    fromEmail:   typeof d.fromEmail === "string" ? d.fromEmail : "",
    fromName:    typeof d.fromName  === "string" ? d.fromName  : "",
    isVerified:  d.hasPassword === true,
    updatedAt:   normalizeTimestamp(d.updatedAt),
  };
}

/**
 * Normalises the backend list-replies response to the MCP ListRepliesResult type.
 *
 * Backend returns: { replies: [...], total: number }
 * MCP expects: PaginatedResult<Reply> = { items, total, page, pageSize, hasNextPage }
 *
 * Backend reply shape: { id, campaignId, fromEmail, subject, snippet,
 *                        direction, isUnread, receivedAt, ... }
 * MCP Reply shape: { id, campaignId, fromEmail, fromName, subject,
 *                    bodyText, bodyHtml, status, receivedAt }
 */
function normalizeListReplies(raw: unknown, params: ListRepliesParams): ListRepliesResult {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const page     = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;

  // Backend returns { replies, total }
  const rawItems: Array<Record<string, unknown>> = Array.isArray(d.replies)
    ? (d.replies as Array<Record<string, unknown>>)
    : Array.isArray(d.items)  // forward-compat: if backend ever returns items
    ? (d.items as Array<Record<string, unknown>>)
    : [];

  const total: number = typeof d.total === "number" ? d.total : rawItems.length;

  const items: Reply[] = rawItems.map((r) => {
    const isUnread   = r.isUnread === true;
    const status: ReplyStatus = isUnread ? "unread" : "read";

    return {
      id:          (typeof r.id === "number" ? String(r.id) : String(r.id ?? "")) as ReplyId,
      campaignId:  (typeof r.campaignId === "number" ? String(r.campaignId) : String(r.campaignId ?? "")) as CampaignId,
      fromEmail:   typeof r.fromEmail  === "string" ? r.fromEmail  : "",
      fromName:    typeof r.campaignName === "string" ? r.campaignName : null,
      subject:     typeof r.subject    === "string" ? r.subject    : "",
      bodyText:    typeof r.snippet    === "string" ? r.snippet    :
                   typeof r.bodyText   === "string" ? r.bodyText   : "",
      bodyHtml:    typeof r.bodyHtml   === "string" ? r.bodyHtml   : null,
      status,
      receivedAt:  normalizeTimestamp(r.receivedAt),
    };
  });

  return {
    items,
    total,
    page,
    pageSize,
    hasNextPage: page * pageSize < total,
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
    const method  = (config.method ?? "GET").toUpperCase();
    const fullUrl = `${env.MAILFLOW_API_BASE_URL}${config.url}`;

    log.info({ method, url: fullUrl }, "MailFlow API: request");

    try {
      const response = await sharedAxios.request<T>({
        ...config,
        headers: {
          ...config.headers,
          Authorization: `Bearer ${this.bearerToken}`,
        },
      });

      const durationMs = Date.now() - startMs;
      const body  = response.data;
      const shape = Array.isArray(body)
        ? `array[${(body as unknown[]).length}]`
        : body !== null && typeof body === "object"
        ? `object{${Object.keys(body as Record<string, unknown>).slice(0, 8).join(",")}}`
        : typeof body;

      log.info(
        { method, url: fullUrl, httpStatus: response.status, durationMs, responseShape: shape },
        "MailFlow API: response OK",
      );

      return body;
    } catch (err) {
      mapAxiosError(config.url, err);
    }
  }

  // ── Campaign ────────────────────────────────────────────────────────────────

  async getAllCampaigns(): Promise<Campaign[]> {
    log.info({ baseUrl: env.MAILFLOW_API_BASE_URL }, "getAllCampaigns: starting");

    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.CAMPAIGNS,
    });

    log.info({ rawResponse: raw }, "getAllCampaigns RAW RESPONSE");

    const rawArray = Array.isArray(raw) ? raw : [];
    const campaigns = rawArray.map(normalizeCampaign);

    log.info(
      { count: campaigns.length, ids: campaigns.map((c) => c.id) },
      "getAllCampaigns: done",
    );
    return campaigns;
  }

  async createCampaign(data: CreateCampaignRequest): Promise<Campaign> {
    log.info(
      { name: data.name, subject: data.subject, hasBody: !!data.emailContent, hasScheduledAt: !!data.scheduledAt },
      "createCampaign: starting",
    );

    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGNS,
      data,
    });

    log.info({ rawResponse: raw }, "createCampaign RAW RESPONSE");

    const campaign = normalizeCampaign(raw);

    log.info(
      { campaignId: campaign.id, name: campaign.name, status: campaign.status },
      "createCampaign: done",
    );
    return campaign;
  }

  async updateCampaign(
    id: CampaignId,
    data: UpdateCampaignRequest,
  ): Promise<Campaign> {
    log.info({ campaignId: id }, "updateCampaign: starting");

    // Remap MCP field `body` → backend field `emailContent`
    const { body, ...rest } = data;
    const payload: Record<string, unknown> = { ...rest };
    if (body !== undefined) payload.emailContent = body;

    const raw = await this.request<unknown>({
      method: "PUT",
      url: MAILFLOW_PATHS.CAMPAIGN_BY_ID(id),
      data: payload,
    });
    log.info({ rawResponse: raw }, "updateCampaign RAW RESPONSE");
    return normalizeCampaign(raw);
  }

  async startCampaign(id: CampaignId): Promise<Campaign> {
    log.info({ campaignId: id }, "startCampaign: starting");
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGN_START(id),
    });
    log.info({ rawResponse: raw }, "startCampaign RAW RESPONSE");
    // Backend returns { status: 'in_progress', message } — not a Campaign object.
    // Synthesize a minimal Campaign using the confirmed id and status.
    const r = raw as Record<string, unknown>;
    return normalizeCampaign({ id, status: r.status ?? "in_progress" });
  }

  async pauseCampaign(id: CampaignId): Promise<Campaign> {
    log.info({ campaignId: id }, "pauseCampaign: starting");
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGN_PAUSE(id),
    });
    log.info({ rawResponse: raw }, "pauseCampaign RAW RESPONSE");
    // Backend returns { message: 'Campaign paused successfully' } — not a Campaign object.
    return normalizeCampaign({ id, status: "paused" });
  }

  async resumeCampaign(id: CampaignId): Promise<Campaign> {
    log.info({ campaignId: id }, "resumeCampaign: starting");
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.CAMPAIGN_RESUME(id),
    });
    log.info({ rawResponse: raw }, "resumeCampaign RAW RESPONSE");
    // Backend returns { message: 'Campaign resumed successfully' } — not a Campaign object.
    return normalizeCampaign({ id, status: "in_progress" });
  }

  async getCampaignStats(id: CampaignId): Promise<CampaignStats> {
    log.info({ campaignId: id }, "getCampaignStats: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.CAMPAIGN_STATS(id),
    });
    log.info({ rawResponse: raw }, "getCampaignStats RAW RESPONSE");
    return normalizeCampaignStats(raw, id);
  }

  async getSequenceProgress(id: CampaignId): Promise<SequenceProgressResult> {
    log.info({ campaignId: id }, "getSequenceProgress: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.SEQUENCE_PROGRESS(id),
    });
    log.info({ rawResponse: raw }, "getSequenceProgress RAW RESPONSE");
    return normalizeSequenceProgress(raw, id);
  }

  async getPendingFollowUps(id: CampaignId, limit?: number): Promise<PendingFollowUpsResult> {
    log.info({ campaignId: id, limit }, "getPendingFollowUps: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.PENDING_FOLLOW_UPS(id),
      params: typeof limit === "number" ? { limit } : undefined,
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const items = Array.isArray(d.items)
      ? (d.items as Array<Record<string, unknown>>).map((item) => ({
          recipientId: typeof item.recipientId === "number" ? item.recipientId : Number(item.recipientId ?? 0),
          currentTouchNumber: typeof item.currentTouchNumber === "number" ? item.currentTouchNumber : Number(item.currentTouchNumber ?? 0),
          nextTouchNumber: typeof item.nextTouchNumber === "number" ? item.nextTouchNumber : Number(item.nextTouchNumber ?? 0),
          nextScheduledTouchAt: typeof item.nextScheduledTouchAt === "string" ? item.nextScheduledTouchAt : null,
          sequenceStatus: typeof item.sequenceStatus === "string" ? item.sequenceStatus : "unknown",
          email: typeof item.email === "string" ? item.email : "",
          name: typeof item.name === "string" ? item.name : null,
          touchSubject: typeof item.touchSubject === "string" ? item.touchSubject : null,
          touchObjective: typeof item.touchObjective === "string" ? item.touchObjective : null,
          touchCtaType: typeof item.touchCtaType === "string" ? item.touchCtaType : null,
        }))
      : [];
    return {
      campaignId: typeof d.campaignId === "number" ? d.campaignId : Number(id),
      total: typeof d.total === "number" ? d.total : items.length,
      items,
    };
  }

  async getRecipientTouchHistory(input: RecipientSequenceLookupRequest): Promise<RecipientSequenceHistoryResult> {
    const params = input.recipientEmail ? { recipientEmail: input.recipientEmail } : undefined;
    const recipientId = input.recipientId ?? "0";
    log.info({ campaignId: input.campaignId, recipientId: input.recipientId, recipientEmail: input.recipientEmail }, "getRecipientTouchHistory: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.RECIPIENT_TOUCH_HISTORY(input.campaignId, recipientId),
      params,
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      campaignId: typeof d.campaignId === "number" ? d.campaignId : Number(input.campaignId),
      recipientId: typeof d.recipientId === "number" ? d.recipientId : Number(input.recipientId ?? 0),
      recipientEmail: typeof d.recipientEmail === "string" ? d.recipientEmail : "",
      recipientName: typeof d.recipientName === "string" ? d.recipientName : null,
      sequenceState: d.sequenceState && typeof d.sequenceState === "object" ? d.sequenceState as Record<string, unknown> : null,
      touches: Array.isArray(d.touches) ? d.touches as Array<Record<string, unknown>> : [],
    };
  }

  async markRecipientReplied(input: RecipientSequenceLookupRequest): Promise<{ message: string }> {
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.MARK_RECIPIENT_REPLIED(input.campaignId),
      data: {
        recipientId: input.recipientId,
        recipientEmail: input.recipientEmail,
      },
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return { message: typeof d.message === "string" ? d.message : "Marked as replied" };
  }

  async markRecipientBounced(input: RecipientSequenceLookupRequest): Promise<{ message: string }> {
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.MARK_RECIPIENT_BOUNCED(input.campaignId),
      data: {
        recipientId: input.recipientId,
        recipientEmail: input.recipientEmail,
      },
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return { message: typeof d.message === "string" ? d.message : "Marked as bounced" };
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  async listReplies(params: ListRepliesParams): Promise<ListRepliesResult> {
    log.info(
      { campaignId: params.campaignId, status: params.status, page: params.page },
      "listReplies: starting",
    );
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.REPLIES,
      params,
    });
    log.info({ rawResponse: raw }, "listReplies RAW RESPONSE");
    return normalizeListReplies(raw, params);
  }

  async getReplyIntelligenceSummary(params: { campaignId?: CampaignId }): Promise<ReplyIntelligenceSummary> {
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.REPLY_INTELLIGENCE_SUMMARY,
      params: params.campaignId ? { campaignId: params.campaignId } : undefined,
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      totalReplies: Number(d.totalReplies ?? 0),
      positiveReplyRate: Number(d.positiveReplyRate ?? 0),
      meetingReadyCount: Number(d.meetingReadyCount ?? 0),
      unsubscribeCount: Number(d.unsubscribeCount ?? 0),
      sentimentDistribution: d.sentimentDistribution && typeof d.sentimentDistribution === "object" ? d.sentimentDistribution as Record<string, number> : {},
      objectionBreakdown: d.objectionBreakdown && typeof d.objectionBreakdown === "object" ? d.objectionBreakdown as Record<string, number> : {},
      hottestLeadScore: Number(d.hottestLeadScore ?? 0),
      averageResponseTimeMinutes: Number(d.averageResponseTimeMinutes ?? 0),
      sequenceToMeetingConversion: Number(d.sequenceToMeetingConversion ?? 0),
    };
  }

  async listHotLeads(params: { campaignId?: CampaignId; limit?: number }): Promise<ReplyLeadListResult> {
    return this.request<ReplyLeadListResult>({
      method: "GET",
      url: MAILFLOW_PATHS.HOT_LEADS,
      params,
    });
  }

  async listMeetingReadyLeads(params: { campaignId?: CampaignId; limit?: number }): Promise<ReplyLeadListResult> {
    return this.request<ReplyLeadListResult>({
      method: "GET",
      url: MAILFLOW_PATHS.MEETING_READY_LEADS,
      params,
    });
  }

  async draftReplySuggestion(replyId: string): Promise<ReplySuggestionResult> {
    return this.request<ReplySuggestionResult>({
      method: "GET",
      url: MAILFLOW_PATHS.REPLY_SUGGESTION(replyId),
    });
  }

  async markReplyHumanReview(input: { replyId: string; reason?: string }): Promise<{ message: string; replyId: number }> {
    return this.request<{ message: string; replyId: number }>({
      method: "POST",
      url: MAILFLOW_PATHS.REPLY_REVIEW(input.replyId),
      data: input.reason ? { reason: input.reason } : undefined,
    });
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getAutonomousRecommendation(input: { recipientId: string }): Promise<AutonomousRecommendationResult> {
    const raw = await this.request<{ success: boolean; data: AutonomousRecommendationResult }>({
      method: "POST",
      url: MAILFLOW_PATHS.AUTONOMOUS_RECOMMENDATION(input.recipientId),
    });
    return raw.data;
  }

  async getCampaignAutonomousRecommendations(input: { campaignId: CampaignId }): Promise<CampaignAutonomousRecommendationsResult> {
    const raw = await this.request<{ success: boolean; data: CampaignAutonomousRecommendationsResult }>({
      method: "GET",
      url: MAILFLOW_PATHS.CAMPAIGN_AUTONOMOUS_RECOMMENDATIONS(input.campaignId),
    });
    return raw.data;
  }

  async getCampaignAutonomousSummary(input: { campaignId: CampaignId }): Promise<CampaignAutonomousSummaryResult> {
    const raw = await this.request<{ success: boolean; data: CampaignAutonomousSummaryResult }>({
      method: "GET",
      url: MAILFLOW_PATHS.CAMPAIGN_AUTONOMOUS_SUMMARY(input.campaignId),
    });
    return raw.data;
  }

  async previewSequenceAdaptation(input: {
    recipientId: string;
    campaignId: CampaignId;
    replyText?: string;
    scenario?: string;
  }): Promise<SequenceAdaptationPreviewResult> {
    const raw = await this.request<{ success: boolean; data: AutonomousRecommendationResult }>({
      method: "POST",
      url: MAILFLOW_PATHS.AUTONOMOUS_RECOMMENDATION(input.recipientId),
      data: {
        campaignId: input.campaignId,
        ...(input.replyText ? { replyText: input.replyText } : {}),
        ...(input.scenario ? { scenario: input.scenario } : {}),
      },
    });
    return {
      recipientId: raw.data.recipientId,
      campaignId: raw.data.campaignId,
      safety: raw.data.safety,
      priority: raw.data.priority,
      recommendedAction: raw.data.recommendedAction,
      adaptationPreview: raw.data.adaptationPreview,
      humanEscalation: raw.data.humanEscalation,
      nextBestAction: raw.data.nextBestAction,
    };
  }

  async getSmtpSettings(): Promise<SmtpSettings> {
    log.info("getSmtpSettings: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.SMTP_SETTINGS,
    });
    log.info({ rawResponse: raw }, "getSmtpSettings RAW RESPONSE");
    return normalizeSmtpSettings(raw);
  }

  async updateSmtpSettings(
    data: UpdateSmtpSettingsRequest,
  ): Promise<SmtpSettings> {
    log.info({ update: maskSmtpRequest(data) }, "updateSmtpSettings: starting");

    // Map MCP field names → backend field names.
    // Backend requires: provider, host, port, secure, user(=email), fromEmail, password, fromName.
    // The username in MCP is the sender email address (same as fromEmail per backend validation).
    const username  = data.username ?? "";
    const fromEmail = data.fromEmail ?? username;
    const host      = data.host ?? "";
    const port      = data.port ?? 587;

    // Auto-detect provider from host for Gmail/Yahoo/Outlook; default to "custom"
    const hostLower = host.toLowerCase();
    const provider  =
      hostLower.includes("gmail")   ? "gmail"   :
      hostLower.includes("yahoo")   ? "yahoo"   :
      hostLower.includes("outlook") || hostLower.includes("hotmail") ? "outlook" :
      "custom";

    const payload: Record<string, unknown> = {
      provider,
      host,
      port,
      secure: port === 465,
      user:      username,
      password:  data.password ?? "",
      fromName:  data.fromName  ?? "",
      fromEmail,
      replyToEmail:    "",
      trackingBaseUrl: "",
    };

    await this.request<unknown>({
      method: "PUT",
      url: MAILFLOW_PATHS.SMTP_SETTINGS,
      data: payload,
    });

    // Backend returns { message: 'SMTP settings saved successfully' } — not SmtpSettings.
    // Return a synthetic SmtpSettings from the input data.
    return {
      id:          "" as SmtpSettingsId,
      host,
      port,
      username,
      encryption:  port === 465 ? "ssl" : "tls",
      fromEmail,
      fromName:    data.fromName ?? "",
      isVerified:  Boolean(data.password),
      updatedAt:   new Date().toISOString() as ISODateString,
    };
  }

  // ── Phase 1: AI Campaign ────────────────────────────────────────────────────

  async getRecipientCount(id: CampaignId): Promise<RecipientCountResult> {
    log.info({ campaignId: id }, "getRecipientCount: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.RECIPIENT_COUNT(id),
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      campaignId: typeof d.campaignId === "number" ? d.campaignId : Number(id),
      pendingCount: typeof d.pendingCount === "number" ? d.pendingCount : 0,
      totalCount: typeof d.totalCount === "number" ? d.totalCount : 0,
    };
  }

  async saveAiPrompt(data: SaveAiPromptRequest): Promise<AiPromptSaveResult> {
    log.info({ campaignId: data.campaignId }, "saveAiPrompt: starting");
    const { campaignId, ...body } = data;
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.AI_PROMPT(campaignId),
      data: body,
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      message: typeof d.message === "string" ? d.message : "AI prompt saved",
      campaignId: Number(campaignId),
    };
  }

  async generatePersonalizedEmails(
    id: CampaignId,
    options?: Omit<GeneratePersonalizedEmailsRequest, "campaignId" | "overwrite">,
  ): Promise<PersonalizedEmailGenerationResult> {
    log.info({ campaignId: id, ...options }, "generatePersonalizedEmails: starting");
    const raw = await this.request<unknown>({
      method:  "POST",
      url:     MAILFLOW_PATHS.GENERATE_PERSONALIZED(id),
      data:    options && Object.keys(options).length > 0 ? options : undefined,
      timeout: 30_000, // override global timeout — generation can take time for larger recipient lists
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      message: typeof d.message === "string" ? d.message : "Generation complete",
      campaignId: typeof d.campaignId === "number" ? d.campaignId : Number(id),
      totalRecipients: typeof d.totalRecipients === "number" ? d.totalRecipients : 0,
      generatedCount: typeof d.generatedCount === "number" ? d.generatedCount : 0,
      failedCount: typeof d.failedCount === "number" ? d.failedCount : 0,
      ...(typeof d.touchesPerLead === "number" ? { touchesPerLead: d.touchesPerLead } : {}),
      ...(typeof d.totalGeneratedTouches === "number" ? { totalGeneratedTouches: d.totalGeneratedTouches } : {}),
      ...(typeof d.modeUsed === "string" ? { modeUsed: d.modeUsed } : {}),
      ...(d.preview && typeof d.preview === "object"
        ? {
            preview: {
              recipientEmail: typeof (d.preview as Record<string, unknown>).recipientEmail === "string"
                ? (d.preview as Record<string, unknown>).recipientEmail as string
                : "",
              subject: typeof (d.preview as Record<string, unknown>).subject === "string"
                ? (d.preview as Record<string, unknown>).subject as string
                : "",
              bodyText: typeof (d.preview as Record<string, unknown>).bodyText === "string"
                ? (d.preview as Record<string, unknown>).bodyText as string
                : "",
            },
          }
        : {}),
      ...(d.strategy && typeof d.strategy === "object"
        ? {
            strategy: {
              tone: typeof (d.strategy as Record<string, unknown>).tone === "string"
                ? (d.strategy as Record<string, unknown>).tone as string
                : "",
              ctaType: typeof (d.strategy as Record<string, unknown>).ctaType === "string"
                ? (d.strategy as Record<string, unknown>).ctaType as string
                : "",
              ctaText: typeof (d.strategy as Record<string, unknown>).ctaText === "string"
                ? (d.strategy as Record<string, unknown>).ctaText as string
                : "",
              sequenceType: typeof (d.strategy as Record<string, unknown>).sequenceType === "string"
                ? (d.strategy as Record<string, unknown>).sequenceType as string
                : "",
              outreachApproach: typeof (d.strategy as Record<string, unknown>).outreachApproach === "string"
                ? (d.strategy as Record<string, unknown>).outreachApproach as string
                : "",
              reasoning: Array.isArray((d.strategy as Record<string, unknown>).reasoning)
                ? ((d.strategy as Record<string, unknown>).reasoning as unknown[]).filter((r): r is string => typeof r === "string")
                : [],
            },
          }
        : {}),
      ...(Array.isArray(d.touchSchedule)
        ? { touchSchedule: (d.touchSchedule as unknown[]).filter((n): n is number => typeof n === "number") }
        : {}),
      ...(Array.isArray(d.previewSequence)
        ? {
            previewSequence: (d.previewSequence as Array<Record<string, unknown>>).map((touch) => ({
              touchNumber: typeof touch.touchNumber === "number" ? touch.touchNumber : 0,
              subject: typeof touch.subject === "string" ? touch.subject : "",
              bodyText: typeof touch.bodyText === "string" ? touch.bodyText : "",
              ctaType: typeof touch.ctaType === "string" ? touch.ctaType : "",
              ctaText: typeof touch.ctaText === "string" ? touch.ctaText : "",
              delayDays: typeof touch.delayDays === "number" ? touch.delayDays : 0,
              tone: typeof touch.tone === "string" ? touch.tone : "",
              objective: typeof touch.objective === "string" ? touch.objective : "",
            })),
          }
        : {}),
      ...(d.deliverability && typeof d.deliverability === "object"
        ? {
            deliverability: {
              inboxRisk: ["low", "medium", "high"].includes(String((d.deliverability as Record<string, unknown>).inboxRisk))
                ? String((d.deliverability as Record<string, unknown>).inboxRisk) as "low" | "medium" | "high"
                : "medium",
              likelyTab: ["primary_possible", "promotions_likely", "spam_risk"].includes(String((d.deliverability as Record<string, unknown>).likelyTab))
                ? String((d.deliverability as Record<string, unknown>).likelyTab) as "primary_possible" | "promotions_likely" | "spam_risk"
                : "promotions_likely",
              reasons: Array.isArray((d.deliverability as Record<string, unknown>).reasons)
                ? ((d.deliverability as Record<string, unknown>).reasons as unknown[]).filter((r): r is string => typeof r === "string")
                : [],
              recommendations: Array.isArray((d.deliverability as Record<string, unknown>).recommendations)
                ? ((d.deliverability as Record<string, unknown>).recommendations as unknown[]).filter((r): r is string => typeof r === "string")
                : [],
              promotionalKeywordScore: typeof (d.deliverability as Record<string, unknown>).promotionalKeywordScore === "number"
                ? (d.deliverability as Record<string, unknown>).promotionalKeywordScore as number
                : 0,
              linkCount: typeof (d.deliverability as Record<string, unknown>).linkCount === "number"
                ? (d.deliverability as Record<string, unknown>).linkCount as number
                : 0,
              imageCount: typeof (d.deliverability as Record<string, unknown>).imageCount === "number"
                ? (d.deliverability as Record<string, unknown>).imageCount as number
                : 0,
              subjectSpamRiskScore: typeof (d.deliverability as Record<string, unknown>).subjectSpamRiskScore === "number"
                ? (d.deliverability as Record<string, unknown>).subjectSpamRiskScore as number
                : 0,
              bodySpamRiskScore: typeof (d.deliverability as Record<string, unknown>).bodySpamRiskScore === "number"
                ? (d.deliverability as Record<string, unknown>).bodySpamRiskScore as number
                : 0,
            },
          }
        : {}),
      ...(typeof d.alreadyExists === "boolean" ? { alreadyExists: d.alreadyExists } : {}),
      ...(typeof d.existingCount === "number" ? { existingCount: d.existingCount } : {}),
    };
  }

  async saveRecipientsCsv(id: CampaignId, rows: Array<Record<string, string>>): Promise<CsvSaveResult> {
    log.info({ campaignId: id, rowCount: rows.length }, "saveRecipientsCsv: starting");

    // Reconstruct a CSV from the parsed rows array so we can use the existing
    // multipart upload endpoint without requiring a new backend endpoint.
    const headers = [...new Set(rows.flatMap(Object.keys))];
    const csvLines = [
      headers.join(","),
      ...rows.map((row) =>
        headers
          .map((h) => `"${(row[h] ?? "").replace(/"/g, '""')}"`)
          .join(","),
      ),
    ];
    const csvBuffer = Buffer.from(csvLines.join("\n"), "utf-8");

    const formData = new FormData();
    formData.append("file", new Blob([csvBuffer], { type: "text/csv" }), "recipients.csv");

    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.RECIPIENT_UPLOAD(id),
      data: formData,
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const result: CsvSaveResult = {
      added:    typeof d.added    === "number" ? d.added    : 0,
      rejected: typeof d.rejected === "number" ? d.rejected : 0,
    };
    if (typeof d.message === "string") result.message = d.message;
    return result;
  }

  async saveRecipientsBulk(id: CampaignId, recipients: Array<Record<string, unknown>>): Promise<BulkSaveResult> {
    log.info({ campaignId: id, count: recipients.length }, "saveRecipientsBulk: starting");
    const raw = await this.request<unknown>({
      method: "POST",
      url: MAILFLOW_PATHS.RECIPIENT_BULK(id),
      data: { recipients },
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (d.success === false) {
      const msg = typeof d.message === "string" ? d.message : "Failed to save recipients";
      throw new MailFlowApiError(422, msg, d);
    }
    const rejectedRaw = Array.isArray(d.rejected) ? d.rejected : [];
    const rejected: BulkRejectedEntry[] = rejectedRaw
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map((r) => ({
        email:  typeof r.email  === "string" ? r.email  : "",
        reason: typeof r.reason === "string" ? r.reason : "unknown",
      }));

    return {
      saved:   typeof d.saved   === "number" ? d.saved   : 0,
      skipped: typeof d.skipped === "number" ? d.skipped : 0,
      ...(rejected.length > 0 ? { rejected } : {}),
      ...(typeof d.message === "string" ? { message: d.message } : {}),
    };
  }

  async getPersonalizedEmails(id: CampaignId, limit = 10): Promise<PersonalizedEmailsResult> {
    log.info({ campaignId: id, limit }, "getPersonalizedEmails: starting");
    const raw = await this.request<unknown>({
      method: "GET",
      url: MAILFLOW_PATHS.PERSONALIZED_EMAILS(id),
      params: { limit },
    });
    const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const emails = Array.isArray(d.emails) ? d.emails as Record<string, unknown>[] : [];
    return {
      campaignId: typeof d.campaignId === "number" ? d.campaignId : Number(id),
      total:      typeof d.total      === "number" ? d.total      : emails.length,
      emails: emails.map((e) => ({
        id:                   typeof e.id                   === "number" ? e.id                   : 0,
        recipientId:          typeof e.recipientId          === "number" ? e.recipientId          : 0,
        personalizedSubject:  typeof e.personalizedSubject  === "string" ? e.personalizedSubject  : null,
        personalizedBody:     typeof e.personalizedBody     === "string" ? e.personalizedBody     : "",
        toneUsed:             typeof e.toneUsed             === "string" ? e.toneUsed             : null,
        ctaType:              typeof e.ctaType              === "string" ? e.ctaType              : null,
        ctaText:              typeof e.ctaText              === "string" ? e.ctaText              : null,
        sequenceType:         typeof e.sequenceType         === "string" ? e.sequenceType         : null,
        touchNumber:          typeof e.touchNumber          === "number" ? e.touchNumber          : 1,
        deliverabilityRisk:   typeof e.deliverabilityRisk   === "string" ? e.deliverabilityRisk   : null,
        strategyReasoning:    typeof e.strategyReasoning    === "string" ? e.strategyReasoning    : null,
        generationStatus:     typeof e.generationStatus     === "string" ? e.generationStatus     : "generated",
        recipientEmail:       typeof e.recipientEmail       === "string" ? e.recipientEmail       : "",
        recipientName:        typeof e.recipientName        === "string" ? e.recipientName        : null,
        ...(e.deliverabilityDiagnostics && typeof e.deliverabilityDiagnostics === "object"
          ? {
              deliverabilityDiagnostics: {
                inboxRisk: ["low", "medium", "high"].includes(String((e.deliverabilityDiagnostics as Record<string, unknown>).inboxRisk))
                  ? String((e.deliverabilityDiagnostics as Record<string, unknown>).inboxRisk) as "low" | "medium" | "high"
                  : "medium",
                likelyTab: ["primary_possible", "promotions_likely", "spam_risk"].includes(String((e.deliverabilityDiagnostics as Record<string, unknown>).likelyTab))
                  ? String((e.deliverabilityDiagnostics as Record<string, unknown>).likelyTab) as "primary_possible" | "promotions_likely" | "spam_risk"
                  : "promotions_likely",
                reasons: Array.isArray((e.deliverabilityDiagnostics as Record<string, unknown>).reasons)
                  ? ((e.deliverabilityDiagnostics as Record<string, unknown>).reasons as unknown[]).filter((r): r is string => typeof r === "string")
                  : [],
                recommendations: Array.isArray((e.deliverabilityDiagnostics as Record<string, unknown>).recommendations)
                  ? ((e.deliverabilityDiagnostics as Record<string, unknown>).recommendations as unknown[]).filter((r): r is string => typeof r === "string")
                  : [],
              },
            }
          : {}),
        ...(Array.isArray(e.sequenceTouches)
          ? {
              sequenceTouches: (e.sequenceTouches as Array<Record<string, unknown>>).map((touch) => ({
                touchNumber: typeof touch.touchNumber === "number" ? touch.touchNumber : 0,
                sequenceType: typeof touch.sequenceType === "string" ? touch.sequenceType : "",
                objective: typeof touch.objective === "string" ? touch.objective : "",
                recommendedDelayDays: typeof touch.recommendedDelayDays === "number" ? touch.recommendedDelayDays : 0,
                toneUsed: typeof touch.toneUsed === "string" ? touch.toneUsed : null,
                ctaType: typeof touch.ctaType === "string" ? touch.ctaType : null,
                ctaText: typeof touch.ctaText === "string" ? touch.ctaText : null,
                personalizedSubject: typeof touch.personalizedSubject === "string" ? touch.personalizedSubject : null,
                personalizedBody: typeof touch.personalizedBody === "string" ? touch.personalizedBody : "",
                personalizedText: typeof touch.personalizedText === "string" ? touch.personalizedText : null,
                previousTouchSummary: typeof touch.previousTouchSummary === "string" ? touch.previousTouchSummary : null,
                deliverabilityRisk: typeof touch.deliverabilityRisk === "string" ? touch.deliverabilityRisk : null,
                strategyReasoning: typeof touch.strategyReasoning === "string" ? touch.strategyReasoning : null,
                ...(touch.deliverabilityDiagnostics && typeof touch.deliverabilityDiagnostics === "object"
                  ? {
                      deliverabilityDiagnostics: {
                        inboxRisk: ["low", "medium", "high"].includes(String((touch.deliverabilityDiagnostics as Record<string, unknown>).inboxRisk))
                          ? String((touch.deliverabilityDiagnostics as Record<string, unknown>).inboxRisk) as "low" | "medium" | "high"
                          : "medium",
                        likelyTab: ["primary_possible", "promotions_likely", "spam_risk"].includes(String((touch.deliverabilityDiagnostics as Record<string, unknown>).likelyTab))
                          ? String((touch.deliverabilityDiagnostics as Record<string, unknown>).likelyTab) as "primary_possible" | "promotions_likely" | "spam_risk"
                          : "promotions_likely",
                        reasons: Array.isArray((touch.deliverabilityDiagnostics as Record<string, unknown>).reasons)
                          ? ((touch.deliverabilityDiagnostics as Record<string, unknown>).reasons as unknown[]).filter((r): r is string => typeof r === "string")
                          : [],
                        recommendations: Array.isArray((touch.deliverabilityDiagnostics as Record<string, unknown>).recommendations)
                          ? ((touch.deliverabilityDiagnostics as Record<string, unknown>).recommendations as unknown[]).filter((r): r is string => typeof r === "string")
                          : [],
                      },
                    }
                  : {}),
              })),
            }
          : {}),
      })),
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMailFlowApiClient(
  bearerToken: BearerToken,
): MailFlowApiClient {
  return new MailFlowApiClient(bearerToken);
}

// ── Exported for tests ────────────────────────────────────────────────────────

export { normalizeCampaign, normalizeTimestamp, normalizeCampaignStatus };
