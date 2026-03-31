/**
 * src/types/common.ts
 *
 * Shared primitive types used across the entire mailflow-mcp-server codebase.
 * These are building blocks — domain-specific types live in their own files.
 */

// ── Branded scalars ───────────────────────────────────────────────────────────

/** Nominal type for campaign identifiers */
export type CampaignId = string & { readonly __brand: "CampaignId" };

/** Nominal type for user identifiers (never accepted from tool input) */
export type UserId = string & { readonly __brand: "UserId" };

/** Nominal type for SMTP setting identifiers */
export type SmtpSettingsId = string & { readonly __brand: "SmtpSettingsId" };

/** Nominal type for reply identifiers */
export type ReplyId = string & { readonly __brand: "ReplyId" };

// ── Utility constructors for branded types ────────────────────────────────────

export const asCampaignId = (id: string): CampaignId => id as CampaignId;
export const asUserId = (id: string): UserId => id as UserId;
export const asReplyId = (id: string): ReplyId => id as ReplyId;

// ── Pagination ────────────────────────────────────────────────────────────────

export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

// ── API response envelope ─────────────────────────────────────────────────────

/**
 * Standard MailFlow API success response wrapper.
 * All MailFlow endpoints return `{ data: T }` on success.
 */
export interface ApiResponse<T> {
  data: T;
}

/**
 * Standard MailFlow API error response body.
 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ── Tool result ───────────────────────────────────────────────────────────────

/**
 * Discriminated union returned by every MCP tool handler.
 * FastMCP expects a plain string or object — callers must serialize this.
 */
export type ToolResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: unknown } };

export function toolSuccess<T>(data: T): ToolResult<T> {
  return { success: true, data };
}

export function toolFailure(
  code: string,
  message: string,
  details?: unknown,
): ToolResult<never> {
  return { success: false, error: { code, message, details } };
}

// ── ISO date string ───────────────────────────────────────────────────────────

/** String constrained to ISO-8601 date-time format (validated at schema layer) */
export type ISODateString = string & { readonly __brand: "ISODateString" };

// ── Nullable vs optional disambiguation ──────────────────────────────────────

/** A value that is present but may be null */
export type Nullable<T> = T | null;

/** A value that may be undefined (use sparingly — prefer explicit optionals) */
export type Maybe<T> = T | undefined;
