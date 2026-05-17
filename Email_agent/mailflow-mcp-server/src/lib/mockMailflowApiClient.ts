/**
 * src/lib/mockMailflowApiClient.ts
 *
 * In-process mock implementation of IMailFlowApiClient.
 *
 * Used exclusively when MOCK_MAILFLOW=true (development only).
 * Returns realistic, schema-conformant data without making any HTTP calls.
 *
 * This lets the full agent → MCP → tool handler → API client path execute
 * successfully in local development without a running MailFlow backend.
 *
 * Design rules:
 *  - Never import Axios or any HTTP library.
 *  - All returned objects must satisfy the exact TypeScript types from
 *    src/types/mailflow.ts — the TypeScript compiler enforces this.
 *  - The input campaignId is reflected back in responses that would normally
 *    contain it, so downstream assertions on the returned object work.
 *  - Timestamps are always fresh (new Date().toISOString()) so TTL-sensitive
 *    tests do not flake.
 *  - Never instantiate this class in production (MOCK_MAILFLOW guard in
 *    toolRegistry.ts is the enforcement point).
 */

import { createLogger } from "./logger.js";
import {
  asCampaignId,
  type CampaignId,
  type ISODateString,
  type ReplyId,
  type SmtpSettingsId,
} from "../types/common.js";
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
import type { IMailFlowApiClient } from "./mailflowApiClient.js";

const log = createLogger("mockMailflowApiClient");

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): ISODateString {
  return new Date().toISOString() as ISODateString;
}

function asReplyId(id: string): ReplyId {
  return id as ReplyId;
}

function asSmtpId(id: string): SmtpSettingsId {
  return id as SmtpSettingsId;
}

// ── Mock base objects ─────────────────────────────────────────────────────────

function mockCampaign(
  id: CampaignId,
  overrides: Partial<Campaign> = {},
): Campaign {
  const ts = now();
  return {
    id,
    name:          `Mock Campaign (${id})`,
    subject:       "Mock subject line",
    fromName:      "Mock Sender",
    fromEmail:     "mock@example.com",
    replyToEmail:  null,
    bodyFormat:    "html",
    body:          "<p>Mock campaign body.</p>",
    status:        "draft",
    scheduledAt:   null,
    startedAt:     null,
    pausedAt:      null,
    completedAt:   null,
    createdAt:     ts,
    updatedAt:     ts,
    ...overrides,
  };
}

function mockStats(id: CampaignId): CampaignStats {
  return {
    campaignId:    id,
    sent:          1_000,
    delivered:     980,
    opened:        441,
    clicked:       120,
    bounced:       20,
    unsubscribed:  5,
    replied:       32,
    openRate:      0.45,
    clickRate:     0.12,
    bounceRate:    0.02,
    replyRate:     0.033,
    calculatedAt:  now(),
  };
}

const BASE_SMTP: SmtpSettings = {
  id:          asSmtpId("smtp-mock-001"),
  host:        "smtp.example.com",
  port:        587,
  username:    "mock-user@example.com",
  encryption:  "tls",
  fromEmail:   "noreply@example.com",
  fromName:    "Mock Mailer",
  isVerified:  true,
  updatedAt:   new Date().toISOString() as ISODateString,
};

// ── MockMailFlowApiClient ─────────────────────────────────────────────────────

export class MockMailFlowApiClient implements IMailFlowApiClient {

  // ── Campaign ────────────────────────────────────────────────────────────────

  async createCampaign(data: CreateCampaignRequest): Promise<Campaign> {
    const id = asCampaignId(`mock-${Date.now()}`);
    log.debug({ campaignId: id }, "mock createCampaign");
    return mockCampaign(id, {
      name:       data.name,
      subject:    data.subject,
      fromName:   data.fromName,
      fromEmail:  data.fromEmail,
      body:       data.body,
      bodyFormat: data.bodyFormat ?? "html",
    });
  }

  async updateCampaign(id: CampaignId, data: UpdateCampaignRequest): Promise<Campaign> {
    log.debug({ campaignId: id }, "mock updateCampaign");
    return mockCampaign(id, {
      ...(data.name       !== undefined ? { name:       data.name }       : {}),
      ...(data.subject    !== undefined ? { subject:    data.subject }    : {}),
      ...(data.fromName   !== undefined ? { fromName:   data.fromName }   : {}),
      ...(data.fromEmail  !== undefined ? { fromEmail:  data.fromEmail }  : {}),
      ...(data.body       !== undefined ? { body:       data.body }       : {}),
      ...(data.bodyFormat !== undefined ? { bodyFormat: data.bodyFormat } : {}),
      updatedAt: now(),
    });
  }

  async startCampaign(id: CampaignId): Promise<Campaign> {
    log.debug({ campaignId: id }, "mock startCampaign");
    return mockCampaign(id, { status: "running", startedAt: now() });
  }

  async pauseCampaign(id: CampaignId): Promise<Campaign> {
    log.debug({ campaignId: id }, "mock pauseCampaign");
    return mockCampaign(id, { status: "paused", pausedAt: now() });
  }

  async resumeCampaign(id: CampaignId): Promise<Campaign> {
    log.debug({ campaignId: id }, "mock resumeCampaign");
    return mockCampaign(id, { status: "running", pausedAt: null });
  }

  // ── Analytics ───────────────────────────────────────────────────────────────

  async getCampaignStats(id: CampaignId): Promise<CampaignStats> {
    log.debug({ campaignId: id }, "mock getCampaignStats");
    return mockStats(id);
  }

  // ── Inbox ───────────────────────────────────────────────────────────────────

  async listReplies(params: ListRepliesParams): Promise<ListRepliesResult> {
    const campaignId = params.campaignId ?? asCampaignId("all");
    log.debug({ campaignId }, "mock listReplies");

    const items = [
      {
        id:         asReplyId("reply-001"),
        campaignId,
        fromEmail:  "customer1@example.com",
        fromName:   "Alice Smith",
        subject:    "Re: Your newsletter",
        bodyText:   "Great content! Really enjoyed this edition.",
        bodyHtml:   "<p>Great content! Really enjoyed this edition.</p>",
        status:     "unread" as const,
        receivedAt: now(),
      },
      {
        id:         asReplyId("reply-002"),
        campaignId,
        fromEmail:  "customer2@example.com",
        fromName:   "Bob Jones",
        subject:    "Re: Your newsletter",
        bodyText:   "Please unsubscribe me from future emails.",
        bodyHtml:   "<p>Please unsubscribe me from future emails.</p>",
        status:     "unread" as const,
        receivedAt: now(),
      },
      {
        id:         asReplyId("reply-003"),
        campaignId,
        fromEmail:  "customer3@example.com",
        fromName:   null,
        subject:    "Re: Special offer",
        bodyText:   "When does this offer expire?",
        bodyHtml:   "<p>When does this offer expire?</p>",
        status:     "read" as const,
        receivedAt: now(),
      },
    ];

    const pageSize = params.pageSize ?? items.length;
    const page     = params.page     ?? 1;

    return {
      items:       items.slice(0, pageSize),
      total:       items.length,
      page,
      pageSize,
      hasNextPage: false,
    };
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getSmtpSettings(): Promise<SmtpSettings> {
    log.debug("mock getSmtpSettings");
    return { ...BASE_SMTP, updatedAt: now() };
  }

  async updateSmtpSettings(data: UpdateSmtpSettingsRequest): Promise<SmtpSettings> {
    log.debug("mock updateSmtpSettings");
    return {
      ...BASE_SMTP,
      ...(data.host       !== undefined ? { host:       data.host }       : {}),
      ...(data.port       !== undefined ? { port:       data.port }       : {}),
      ...(data.encryption !== undefined ? { encryption: data.encryption } : {}),
      ...(data.fromEmail  !== undefined ? { fromEmail:  data.fromEmail }  : {}),
      ...(data.fromName   !== undefined ? { fromName:   data.fromName }   : {}),
      updatedAt: now(),
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns a mock MailFlow API client for use in development / MOCK_MAILFLOW mode.
 * Never call this in production — enforce via MOCK_MAILFLOW guard at the call site.
 */
export function createMockMailFlowApiClient(): IMailFlowApiClient {
  return new MockMailFlowApiClient();
}
