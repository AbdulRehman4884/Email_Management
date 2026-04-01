/**
 * src/types/auth.ts
 *
 * Auth domain types for mailflow-mcp-server.
 *
 * Design rules enforced here:
 *  - userId is NEVER sourced from tool input — it is resolved server-side
 *    from a validated bearer token by authContext.service.ts
 *  - BearerToken is a branded string so it cannot be accidentally assigned
 *    from an unvalidated string literal
 *  - AuthContext is the single object passed to all tool handlers
 */

import type { UserId } from "./common.js";

// ── Branded token types ───────────────────────────────────────────────────────

/** A validated JWT Bearer token. Never log or include in error messages. */
export type BearerToken = string & { readonly __brand: "BearerToken" };

/**
 * The shared service secret used for service-to-service auth.
 * Passed by agent-service in the X-Service-Token header.
 * Validated against MCP_SERVICE_SECRET env var.
 */
export type ServiceToken = string & { readonly __brand: "ServiceToken" };

// ── Constructor helpers ───────────────────────────────────────────────────────

/**
 * Casts a raw string to BearerToken.
 * Caller is responsible for ensuring the string is a valid, non-empty JWT.
 */
export const asBearerToken = (raw: string): BearerToken =>
  raw as BearerToken;

export const asServiceToken = (raw: string): ServiceToken =>
  raw as ServiceToken;

// ── Auth modes ────────────────────────────────────────────────────────────────

/**
 * How the MCP server obtained its MailFlow authorization credential.
 *
 * - `forwarded-bearer`: agent-service forwarded an end-user JWT via
 *   X-Forwarded-Authorization. The token is passed as-is to MailFlow.
 *
 * - `service-account`: No user token was forwarded; the server falls back to
 *   MAILFLOW_SERVICE_ACCOUNT_TOKEN. Only permitted when that env var is set.
 *
 * Future modes (not yet implemented):
 * - `mtls`: mutual TLS service-to-service
 * - `oidc-exchange`: token exchange via OIDC
 */
export type AuthMode = "forwarded-bearer" | "service-account" | "mock";

// ── Auth context ──────────────────────────────────────────────────────────────

/**
 * AuthContext is injected into every tool handler by authContext.service.ts.
 *
 * It carries the resolved credential that the tool should use when calling
 * the MailFlow API client. Tool handlers must not construct or modify this.
 *
 * userId is optional: in forwarded-bearer mode the MailFlow API enforces
 * ownership; in service-account mode userId may be absent.
 */
export interface AuthContext {
  /** How the credential was obtained */
  readonly mode: AuthMode;

  /**
   * The bearer token to attach to MailFlow API calls.
   * In forwarded-bearer mode this is the user's JWT.
   * In service-account mode this is MAILFLOW_SERVICE_ACCOUNT_TOKEN.
   */
  readonly bearerToken: BearerToken;

  /**
   * Resolved user identifier, if available.
   * Populated by authContext.service when decoding the JWT.
   * NEVER sourced from tool input payloads.
   */
  readonly userId?: UserId;
}

// ── Inbound auth extraction input ─────────────────────────────────────────────

/**
 * Raw header values extracted from the MCP session / SSE request.
 * authContext.service.ts transforms this into a validated AuthContext.
 */
export interface RawInboundAuth {
  /** Value of X-Service-Token header — validates the caller is agent-service */
  serviceToken?: string;

  /** Value of X-Forwarded-Authorization header — the end-user JWT */
  forwardedAuthorization?: string;
}

// ── Token decode result ───────────────────────────────────────────────────────

/**
 * Minimal claims extracted from a decoded JWT.
 * Extend as MailFlow's JWT payload grows.
 */
export interface DecodedTokenClaims {
  sub: string;   // subject = userId
  exp: number;   // expiry (Unix timestamp)
  iat: number;   // issued at
}
