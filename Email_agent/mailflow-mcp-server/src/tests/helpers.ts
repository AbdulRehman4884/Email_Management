/**
 * src/tests/helpers.ts
 *
 * Shared test helpers for building mock objects.
 * Import these in test files to avoid duplication.
 *
 * Design: helpers use only type-safe structural mocks to avoid transitive
 * imports of modules that depend on env.ts at module load time.
 */

import { vi } from "vitest";
import pino from "pino";
import type { IMailFlowApiClient } from "../lib/mailflowApiClient.js";
import type { AuthContext, BearerToken } from "../types/auth.js";
import type { McpSession } from "../types/mcp.js";
import type { ToolContext } from "../mcp/types/toolContext.js";

// ── Mock logger ───────────────────────────────────────────────────────────────

/** Silent pino logger for use in tests — suppresses all output */
export const silentLogger = pino({ level: "silent" });

// ── Mock MailFlow API client ──────────────────────────────────────────────────

/**
 * Creates a fully stubbed IMailFlowApiClient where every method is a vi.fn().
 * Provide overrides to set return values for specific methods in each test.
 */
export function createMockMailflowClient(
  overrides: Partial<IMailFlowApiClient> = {},
): IMailFlowApiClient {
  return {
    getAllCampaigns: vi.fn(),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    startCampaign: vi.fn(),
    pauseCampaign: vi.fn(),
    resumeCampaign: vi.fn(),
    getCampaignStats: vi.fn(),
    getSequenceProgress: vi.fn(),
    getPendingFollowUps: vi.fn(),
    getRecipientTouchHistory: vi.fn(),
    markRecipientReplied: vi.fn(),
    markRecipientBounced: vi.fn(),
    listReplies: vi.fn(),
    getReplyIntelligenceSummary: vi.fn(),
    listHotLeads: vi.fn(),
    listMeetingReadyLeads: vi.fn(),
    draftReplySuggestion: vi.fn(),
    markReplyHumanReview: vi.fn(),
    getAutonomousRecommendation: vi.fn(),
    getCampaignAutonomousRecommendations: vi.fn(),
    getCampaignAutonomousSummary: vi.fn(),
    previewSequenceAdaptation: vi.fn(),
    getSmtpSettings: vi.fn(),
    updateSmtpSettings: vi.fn(),
    getRecipientCount: vi.fn(),
    saveAiPrompt: vi.fn(),
    generatePersonalizedEmails: vi.fn(),
    getPersonalizedEmails: vi.fn(),
    saveRecipientsCsv: vi.fn(),
    saveRecipientsBulk: vi.fn(),
    ...overrides,
  };
}

// ── Mock auth context ─────────────────────────────────────────────────────────

export function createMockAuthContext(
  overrides: Partial<AuthContext> = {},
): AuthContext {
  return {
    mode: "service-account",
    bearerToken: "mock-bearer-token" as BearerToken,
    ...overrides,
  };
}

// ── Mock MCP session ──────────────────────────────────────────────────────────

export function createMockSession(
  overrides: Partial<McpSession> = {},
): McpSession {
  return {
    sessionId: "test-session-id",
    rawAuth: {},
    ...overrides,
  };
}

// ── Mock ToolContext ──────────────────────────────────────────────────────────

/**
 * Creates a complete ToolContext for use in tool handler tests.
 * The logger is silent; mailflow client methods are vi.fn() stubs.
 */
export function createMockToolContext(
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    auth: createMockAuthContext(),
    log: silentLogger,
    session: createMockSession(),
    mailflow: createMockMailflowClient(),
    ...overrides,
  };
}
