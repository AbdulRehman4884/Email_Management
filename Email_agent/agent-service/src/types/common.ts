/**
 * src/types/common.ts
 *
 * Branded primitive types used throughout agent-service.
 * Prevents accidental assignment between semantically distinct string values.
 */

// ── Branded string types ──────────────────────────────────────────────────────

export type UserId = string & { readonly __brand: "UserId" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type RequestId = string & { readonly __brand: "RequestId" };

// ── Constructor helpers ───────────────────────────────────────────────────────

export const asUserId = (raw: string): UserId => raw as UserId;
export const asSessionId = (raw: string): SessionId => raw as SessionId;
export const asRequestId = (raw: string): RequestId => raw as RequestId;

// ── Auth context ──────────────────────────────────────────────────────────────

/**
 * Resolved authentication context attached to every authenticated request.
 * Populated by src/middleware/auth.ts from the verified JWT payload.
 * Tool handlers receive this via req.authContext — never from tool input.
 */
export interface AuthContext {
  /** Subject claim from the JWT — the authenticated user's ID */
  readonly userId: UserId;

  /** Email claim from the JWT payload (if present) */
  readonly email?: string;

  /** Raw bearer token forwarded to MCP server calls */
  readonly rawToken: string;
}
