/**
 * N-07 / N-17: refresh tokens of cookie sessions (table auth_refresh_tokens, migration 0038).
 * - The cookie holds 32 random bytes; only their SHA-256 hash is stored.
 * - Every refresh rotates the token (old row revoked, new row in the same family).
 * - A revoked token used again = possible theft: the whole family (that login) is revoked,
 *   unless it was replaced less than REUSE_GRACE_MS ago (two tabs refreshing at the same time).
 * - Idle expiry 7 days (same as the old 7-day login), absolute expiry 30 days per login.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from './db.js';
import { authRefreshTokensTable, usersTable } from '../db/schema.js';
import { hashIp } from './crm/webTracking.js';

export const REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const FAMILY_MAX_MS = 30 * 24 * 60 * 60 * 1000;
export const REUSE_GRACE_MS = 30 * 1000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  refreshToken: string;
  csrfToken: string;
  refreshMaxAgeMs: number;
}

function metaColumns(meta: SessionMeta) {
  return {
    userAgent: meta.userAgent ? meta.userAgent.slice(0, 255) : null,
    ipHash: meta.ip ? hashIp(meta.ip) : null,
  };
}

/** New login: a new family with its first refresh token. */
export async function createSession(userId: number, meta: SessionMeta = {}): Promise<IssuedSession> {
  const refreshToken = newOpaqueToken();
  const csrfToken = newOpaqueToken();
  const now = Date.now();
  await db.insert(authRefreshTokensTable).values({
    userId,
    familyId: randomUUID(),
    tokenHash: sha256Hex(refreshToken),
    csrfHash: sha256Hex(csrfToken),
    expiresAt: new Date(now + REFRESH_IDLE_MS),
    familyExpiresAt: new Date(now + FAMILY_MAX_MS),
    ...metaColumns(meta),
  });
  return { refreshToken, csrfToken, refreshMaxAgeMs: REFRESH_IDLE_MS };
}

export type RotateResult =
  | ({ ok: true; userId: number } & IssuedSession)
  | { ok: false; reason: 'invalid' | 'race' | 'expired' | 'reused' | 'inactive' };

/**
 * Exchanges a refresh token for a new one (rotation). `currentCsrf` (the mf_csrf cookie) is kept when it belongs to
 * this login, so the CSRF value stays the same for the whole login and other open tabs keep working.
 */
export async function rotateSession(rawRefreshToken: string, meta: SessionMeta = {}, currentCsrf?: string | null): Promise<RotateResult> {
  if (!rawRefreshToken) return { ok: false, reason: 'invalid' };
  const [row] = await db
    .select()
    .from(authRefreshTokensTable)
    .where(eq(authRefreshTokensTable.tokenHash, sha256Hex(rawRefreshToken)))
    .limit(1);
  if (!row) return { ok: false, reason: 'invalid' };

  const now = Date.now();
  if (row.revokedAt) {
    const recentlyReplaced = row.replacedBy != null && now - row.revokedAt.getTime() < REUSE_GRACE_MS;
    if (!recentlyReplaced) await revokeFamily(row.familyId);
    // 'race': another tab rotated it a moment ago; the browser already has the newer cookie and retries.
    return { ok: false, reason: recentlyReplaced ? 'race' : 'reused' };
  }
  if (row.expiresAt.getTime() <= now || row.familyExpiresAt.getTime() <= now) {
    await revokeFamily(row.familyId);
    return { ok: false, reason: 'expired' };
  }
  const [user] = await db
    .select({ isActive: usersTable.isActive })
    .from(usersTable)
    .where(eq(usersTable.id, row.userId))
    .limit(1);
  if (!user || !user.isActive) {
    await revokeFamily(row.familyId);
    return { ok: false, reason: 'inactive' };
  }

  const refreshToken = newOpaqueToken();
  const csrfToken = currentCsrf && sha256Hex(currentCsrf) === row.csrfHash ? currentCsrf : newOpaqueToken();
  const expiresAt = new Date(Math.min(now + REFRESH_IDLE_MS, row.familyExpiresAt.getTime()));
  const rotated = await db.transaction(async (tx) => {
    // Claim the old row; if another request rotated it a moment ago, this one loses (grace case).
    const claimed = await tx
      .update(authRefreshTokensTable)
      .set({ revokedAt: new Date(now) })
      .where(and(eq(authRefreshTokensTable.id, row.id), isNull(authRefreshTokensTable.revokedAt)))
      .returning({ id: authRefreshTokensTable.id });
    if (claimed.length === 0) return null;
    const [inserted] = await tx
      .insert(authRefreshTokensTable)
      .values({
        userId: row.userId,
        familyId: row.familyId,
        tokenHash: sha256Hex(refreshToken),
        csrfHash: sha256Hex(csrfToken),
        expiresAt,
        familyExpiresAt: row.familyExpiresAt,
        ...metaColumns(meta),
      })
      .returning({ id: authRefreshTokensTable.id });
    await tx
      .update(authRefreshTokensTable)
      .set({ replacedBy: inserted!.id })
      .where(eq(authRefreshTokensTable.id, row.id));
    return inserted!.id;
  });
  if (rotated == null) return { ok: false, reason: 'race' };
  return { ok: true, userId: row.userId, refreshToken, csrfToken, refreshMaxAgeMs: expiresAt.getTime() - now };
}

/** Logout: ends the login the presented refresh token belongs to. */
export async function revokeSessionByToken(rawRefreshToken: string): Promise<void> {
  if (!rawRefreshToken) return;
  const [row] = await db
    .select({ familyId: authRefreshTokensTable.familyId })
    .from(authRefreshTokensTable)
    .where(eq(authRefreshTokensTable.tokenHash, sha256Hex(rawRefreshToken)))
    .limit(1);
  if (row) await revokeFamily(row.familyId);
}

export async function revokeFamily(familyId: string): Promise<void> {
  await db
    .update(authRefreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(authRefreshTokensTable.familyId, familyId), isNull(authRefreshTokensTable.revokedAt)));
}

/** Password reset, deactivation: every session of the user ends (access tokens expire within minutes). */
export async function revokeAllSessionsForUser(userId: number): Promise<void> {
  await db
    .update(authRefreshTokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(authRefreshTokensTable.userId, userId), isNull(authRefreshTokensTable.revokedAt)));
}

/** Deletes rows that expired more than 30 days ago (kept that long for reuse detection / audit). */
export async function purgeExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - FAMILY_MAX_MS);
  const deleted = await db
    .delete(authRefreshTokensTable)
    .where(or(lt(authRefreshTokensTable.expiresAt, cutoff), lt(authRefreshTokensTable.familyExpiresAt, cutoff)))
    .returning({ id: authRefreshTokensTable.id });
  return deleted.length;
}
