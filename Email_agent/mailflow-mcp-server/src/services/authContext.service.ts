/**
 * src/services/authContext.service.ts
 *
 * Converts raw inbound auth headers into a validated, typed AuthContext.
 *
 * Responsibilities:
 *  1. Validate X-Service-Token to confirm the caller is agent-service
 *  2. Resolve the bearer token (forwarded user JWT or service-account fallback)
 *  3. Decode userId from the JWT payload (for context/logging only — not authz)
 *  4. Return a sealed AuthContext ready for injection into ToolContext
 *
 * Security rules enforced here:
 *  - Service token comparison uses crypto.timingSafeEqual — no timing oracle
 *  - Bearer tokens are never logged, even on error
 *  - userId is always resolved from the token, never from tool input
 *  - JWT signature is NOT verified here — MailFlow backend is authoritative;
 *    an invalid token will simply be rejected by MailFlow with a 401
 *
 * Integration note (Phase 7):
 *  The singleton `authContextService` is called from requestContext.ts,
 *  which is called from toolExecution.service.ts before any tool handler runs.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { AuthError, ErrorCode } from "../lib/errors.js";
import {
  asBearerToken,
  type AuthContext,
  type BearerToken,
  type RawInboundAuth,
} from "../types/auth.js";
import { asUserId, type UserId } from "../types/common.js";

const log = createLogger("authContext.service");

// ── Mock context ───────────────────────────────────────────────────────────────

/**
 * Synthetic bearer token injected in mock mode.
 * The mock MailFlow server accepts any token; this value is used only in
 * development when MOCK_MAILFLOW=true so it never appears in production.
 */
const MOCK_BEARER_TOKEN = asBearerToken("mock-bearer-token");
const MOCK_USER_ID = asUserId("test-user");

// ── Timing-safe string comparison ─────────────────────────────────────────────

/**
 * Compares two strings in constant time to prevent timing side-channels.
 * If lengths differ, a same-length comparison is still performed to avoid
 * leaking information about the expected secret's length.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  // Hash both values to a fixed-length buffer before comparing.
  // This normalises length without revealing the expected secret length.
  const bufA = createHash("sha256").update(a).digest();
  const bufB = createHash("sha256").update(b).digest();
  return timingSafeEqual(bufA, bufB);
}

// ── JWT payload decode (no verification) ─────────────────────────────────────

/**
 * Decodes the JWT payload to extract `sub` (userId).
 * Does NOT verify the signature — MailFlow backend is the authority.
 * Returns undefined if the token is structurally invalid.
 */
function decodeJwtSub(token: BearerToken): UserId | undefined {
  try {
    const parts = (token as string).split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;

    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );

    if (
      payload !== null &&
      typeof payload === "object" &&
      "sub" in payload &&
      typeof (payload as Record<string, unknown>).sub === "string"
    ) {
      return asUserId((payload as { sub: string }).sub);
    }
  } catch {
    // Malformed JWT — not an error; userId simply won't be available
  }

  return undefined;
}

// ── AuthContextService ────────────────────────────────────────────────────────

export class AuthContextService {
  /**
   * Validates inbound auth headers and returns a typed AuthContext.
   *
   * When MOCK_MAILFLOW=true (development only), x-forwarded-authorization is
   * not required and a fixed mock user context is returned instead of decoding
   * a real JWT. The x-service-token check still applies.
   *
   * Throws AuthError on:
   *  - Missing or invalid X-Service-Token
   *  - No bearer token available (no forwarded JWT and no service account configured)
   */
  resolve(rawAuth: RawInboundAuth): AuthContext {
    this.validateServiceToken(rawAuth.serviceToken);

    if (env.MOCK_MAILFLOW && env.NODE_ENV === "development") {
      log.debug("Mock mode active — injecting mock user context");
      return {
        mode: "mock",
        bearerToken: MOCK_BEARER_TOKEN,
        userId: MOCK_USER_ID,
      };
    }

    const { bearerToken, mode } = this.resolveBearerToken(
      rawAuth.forwardedAuthorization,
    );
    const userId = decodeJwtSub(bearerToken);

    log.debug(
      { mode, hasUserId: userId !== undefined },
      "Auth context resolved",
    );

    return { mode, bearerToken, userId };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Validates X-Service-Token against MCP_SERVICE_SECRET.
   * Rejects missing tokens and tokens that don't match in constant time.
   */
  private validateServiceToken(token: string | undefined): void {
    if (!token) {
      log.warn("Request rejected: missing X-Service-Token");
      throw new AuthError(
        ErrorCode.AUTH_MISSING_TOKEN,
        "Missing service token",
      );
    }

    if (!timingSafeStringEqual(token, env.MCP_SERVICE_SECRET)) {
      log.warn("Request rejected: invalid X-Service-Token");
      throw new AuthError(
        ErrorCode.AUTH_INVALID_TOKEN,
        "Invalid service token",
      );
    }
  }

  /**
   * Resolves the bearer token for MailFlow API calls.
   *
   * Priority:
   *  1. X-Forwarded-Authorization header (end-user JWT forwarded by agent-service)
   *  2. MAILFLOW_SERVICE_ACCOUNT_TOKEN env var (service-level fallback)
   *
   * Throws AUTH_MISSING_TOKEN if neither source is available.
   */
  private resolveBearerToken(forwardedAuth: string | undefined): {
    bearerToken: BearerToken;
    mode: AuthContext["mode"];
  } {
    if (forwardedAuth) {
      // Strip optional "Bearer " prefix — accept both "Bearer <token>" and raw token
      const raw = forwardedAuth.replace(/^Bearer\s+/i, "").trim();
      if (raw.length > 0) {
        return { bearerToken: asBearerToken(raw), mode: "forwarded-bearer" };
      }
    }

    if (env.MAILFLOW_SERVICE_ACCOUNT_TOKEN) {
      log.debug(
        "No forwarded authorization — using service account token",
      );
      return {
        bearerToken: asBearerToken(env.MAILFLOW_SERVICE_ACCOUNT_TOKEN),
        mode: "service-account",
      };
    }

    throw new AuthError(
      ErrorCode.AUTH_MISSING_TOKEN,
      "No bearer token available: provide X-Forwarded-Authorization or configure MAILFLOW_SERVICE_ACCOUNT_TOKEN",
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Module-level singleton — stateless, safe to share across all tool calls.
 * Import this directly rather than constructing a new instance per request.
 */
export const authContextService = new AuthContextService();
