/**
 * Centralized mapping from MCP / transport errors to user-safe messages.
 * Raw stack traces, hosts, and SDK internals must never reach the client.
 */

import { ErrorCode, McpError } from "./errors.js";

/** Default TTL-style workflows (enrichment confirm, campaign pick) — 30 minutes */
export const WORKFLOW_PENDING_TTL_MS = 30 * 60 * 1000;

export function computeWorkflowDeadlineIso(): string {
  return new Date(Date.now() + WORKFLOW_PENDING_TTL_MS).toISOString();
}

export function isWorkflowDeadlineExpired(iso: string | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() > t;
}

/**
 * True if the failure is worth automatic retry (transient network / service).
 */
export function isTransientMcpOrNetworkError(err: unknown): boolean {
  if (err instanceof McpError) {
    if (err.code === ErrorCode.MCP_TIMEOUT) return true;
    const d = err.details as { internalMessage?: string } | undefined;
    if (typeof d?.internalMessage === "string" && d.internalMessage.length > 0) {
      return isTransientMcpOrNetworkError(new Error(d.internalMessage));
    }
    return false;
  }
  const msg = normalizeErrText(err);
  if (!msg) return false;
  const low = msg.toLowerCase();
  return (
    low.includes("econnrefused") ||
    low.includes("econnreset") ||
    low.includes("etimedout") ||
    low.includes("enetunreach") ||
    low.includes("socket hang up") ||
    low.includes("fetch failed") ||
    low.includes("network") ||
    low.includes("timeout") ||
    low.includes("503") ||
    low.includes("502") ||
    low.includes("bad gateway") ||
    low.includes("service unavailable")
  );
}

function normalizeErrText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * User-facing message only — safe for JSON responses.
 */
export function toUserSafeMcpMessage(err: unknown): string {
  if (err instanceof McpError) {
    if (err.code === ErrorCode.MCP_TIMEOUT) {
      return "The MailFlow service took too long to respond. Please try again in a moment.";
    }
    const inner = normalizeErrText(err);
    return classifyTransportMessage(inner);
  }
  return classifyTransportMessage(normalizeErrText(err));
}

function classifyTransportMessage(raw: string): string {
  const low = raw.toLowerCase();

  if (
    low.includes("econnrefused") ||
    low.includes("getaddrinfo") ||
    (low.includes("enotfound") && low.includes("connect"))
  ) {
    return "Campaign service is temporarily unavailable. Please try again shortly.";
  }

  if (
    low.includes("fetch failed") ||
    low.includes("econnreset") ||
    low.includes("socket hang up") ||
    low.includes("network error")
  ) {
    return "We couldn’t reach the MailFlow service. Check your connection and try again.";
  }

  if (
    low.includes("etimedout") ||
    low.includes("timeout") ||
    low.includes("timed out")
  ) {
    return "The request timed out. Please try again.";
  }

  if (low.includes("502") || low.includes("503") || low.includes("bad gateway")) {
    return "MailFlow is briefly unavailable. Please try again in a few moments.";
  }

  // Strip obvious localhost / URL leakage from any residual message
  const sanitized = raw
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(/localhost(:\d+)?/gi, "")
    .replace(/\bat\s+[a-z0-9.:]+\b/gi, "")
    .trim();

  if (sanitized.length > 0 && sanitized.length < 120 && !/[{}[\]]/.test(sanitized)) {
    return `Something went wrong: ${sanitized}`;
  }

  return "Something went wrong while contacting MailFlow. Please try again.";
}
