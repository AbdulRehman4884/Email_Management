import { db } from './db';
import { smtpSettingsTable, campaignTable, emailSendLogTable, smtpAliasesTable } from '../db/schema';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../constants/fieldLimits';
import { SMTP_PROFILES_UNLIMITED } from './planCatalog';

/** Default when no plan limit is passed: unlimited (same sentinel as the Premium plan). */
export const SMTP_PROFILES_MAX = SMTP_PROFILES_UNLIMITED;

/** null = unlimited, 0 = block all sending, 1-N = cap. */
function clampDailyEmailLimit(n: number | null, max = SMTP_DAILY_EMAIL_LIMIT_MAX): number | null {
  if (n === null) return null;
  const f = Math.floor(Number(n));
  if (!Number.isFinite(f)) return max;
  if (f <= 0) return 0;
  return Math.min(max, f);
}

export interface SmtpSettingsRow {
  id: number;
  userId: number;
  provider: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string;
  trackingBaseUrl: string | null;
  /** null = unlimited, 0 = block all sending, 1-50 = cap */
  dailyEmailLimit: number | null;
  dailyLimitResetAt: Date | null;
  updatedAt: Date;
}

export interface SmtpSettingsInput {
  provider: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName?: string;
  fromEmail: string;
  replyToEmail?: string;
  trackingBaseUrl?: string | null;
  /** Per-day send cap for this profile; null = unlimited, 0 = block all sending, 1-50 = cap */
  dailyEmailLimit?: number | null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  replyToEmail?: string;
  provider?: string;
  trackingBaseUrl?: string | null;
}

function rowToConfig(r: typeof smtpSettingsTable.$inferSelect): SmtpConfig {
  return {
    host: r.host,
    port: r.port,
    secure: r.secure,
    user: r.user,
    pass: r.password,
    fromName: r.fromName ?? '',
    fromEmail: r.fromEmail,
    replyToEmail: r.replyToEmail ?? '',
    provider: r.provider,
    trackingBaseUrl: r.trackingBaseUrl ?? undefined,
  };
}

function envFallbackConfig(): SmtpConfig {
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    fromName: '',
    fromEmail: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    trackingBaseUrl: process.env.TRACKING_BASE_URL || process.env.PUBLIC_URL || undefined,
  };
}

/** SMTP profile must exist and belong to user. */
export async function getSmtpProfileRow(
  userId: number,
  smtpSettingsId: number
): Promise<(typeof smtpSettingsTable.$inferSelect) | null> {
  const rows = await db
    .select()
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.id, smtpSettingsId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function requireSmtpProfile(userId: number, smtpSettingsId: number): Promise<SmtpConfig> {
  const rows = await db
    .select()
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.id, smtpSettingsId)))
    .limit(1);
  if (!rows[0]) {
    throw new Error('SMTP profile not found');
  }
  return rowToConfig(rows[0]);
}

/**
 * Resolve SMTP config for sending.
 * - If `smtpSettingsId` is set: that profile only (no fallback).
 * - Else: first profile for user by id, else env.
 */
export async function getSmtpSettings(userId: number, smtpSettingsId?: number | null): Promise<SmtpConfig> {
  if (smtpSettingsId != null && Number.isFinite(smtpSettingsId) && smtpSettingsId > 0) {
    return requireSmtpProfile(userId, smtpSettingsId);
  }
  const rows = await db
    .select()
    .from(smtpSettingsTable)
    .where(eq(smtpSettingsTable.userId, userId))
    .orderBy(asc(smtpSettingsTable.id))
    .limit(1);
  if (rows[0]) {
    return rowToConfig(rows[0]);
  }
  return envFallbackConfig();
}

export async function listSmtpProfilesForUser(userId: number): Promise<SmtpSettingsRow[]> {
  const rows = await db
    .select()
    .from(smtpSettingsTable)
    .where(eq(smtpSettingsTable.userId, userId))
    .orderBy(asc(smtpSettingsTable.id));
  return rows as SmtpSettingsRow[];
}

export async function countSmtpProfiles(userId: number): Promise<number> {
  const r = await db.select({ c: count() }).from(smtpSettingsTable).where(eq(smtpSettingsTable.userId, userId));
  return Number(r[0]?.c ?? 0);
}

/**
 * The From email may be an alias of the login (same company domain), so the same login must not be added twice:
 * one mailbox = one SMTP account = 20 emails per day, whatever alias it sends as. Ignores `exceptId` (the profile
 * being edited).
 */
async function loginUsedByAnotherProfile(userId: number, login: string, exceptId?: number): Promise<boolean> {
  const rows = await db
    .select({ id: smtpSettingsTable.id })
    .from(smtpSettingsTable)
    .where(
      and(
        eq(smtpSettingsTable.userId, userId),
        sql`lower(${smtpSettingsTable.user}) = ${login.trim().toLowerCase()}`,
        ...(exceptId != null ? [ne(smtpSettingsTable.id, exceptId)] : [])
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function insertSmtpProfile(userId: number, input: SmtpSettingsInput, smtpLimit = SMTP_PROFILES_MAX): Promise<number> {
  const n = await countSmtpProfiles(userId);
  if (n >= smtpLimit) {
    throw new Error('SMTP_PROFILE_LIMIT');
  }
  // Reject duplicate: same sender email already registered for this user.
  const existing = await db
    .select({ id: smtpSettingsTable.id })
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.fromEmail, input.fromEmail)))
    .limit(1);
  if (existing.length > 0) {
    throw new Error('SMTP_DUPLICATE_EMAIL');
  }
  if (await loginUsedByAnotherProfile(userId, input.user)) {
    throw new Error('SMTP_DUPLICATE_LOGIN');
  }
  const dailyCap =
    input.dailyEmailLimit === undefined
      ? SMTP_DAILY_EMAIL_LIMIT_MAX  // default = 20 sends/day per email
      : clampDailyEmailLimit(input.dailyEmailLimit === null ? null : Number(input.dailyEmailLimit), SMTP_DAILY_EMAIL_LIMIT_MAX);
  const base = {
    provider: input.provider,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    fromName: (input.fromName ?? '').trim() || '',
    fromEmail: input.fromEmail,
    replyToEmail: (input.replyToEmail ?? '').trim(),
    trackingBaseUrl: input.trackingBaseUrl != null ? (String(input.trackingBaseUrl).trim() || null) : null,
    password: input.password || '',
    dailyEmailLimit: dailyCap,
  };
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(smtpSettingsTable).values({ ...base, userId }).returning({ id: smtpSettingsTable.id });
    if (!row?.id) throw new Error('Failed to create SMTP profile');
    // Every profile owns at least one alias: its primary From. This is the alias that campaigns
    // using only the profile (no explicit alias) send as, and it carries the profile's daily cap.
    await tx.insert(smtpAliasesTable).values({
      smtpSettingsId: row.id,
      userId,
      fromEmail: base.fromEmail,
      fromName: base.fromName,
      dailyEmailLimit: dailyCap,
    });
    return row.id;
  });
}

export async function updateSmtpProfile(
  userId: number,
  profileId: number,
  input: Omit<SmtpSettingsInput, 'password'> & { password?: string; dailyLimitResetAt?: Date | null }
): Promise<void> {
  const rows = await db
    .select({ id: smtpSettingsTable.id })
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.id, profileId)))
    .limit(1);
  if (!rows[0]) {
    throw new Error('SMTP profile not found');
  }
  if (await loginUsedByAnotherProfile(userId, input.user, profileId)) {
    throw new Error('SMTP_DUPLICATE_LOGIN');
  }
  const base = {
    provider: input.provider,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    fromName: (input.fromName ?? '').trim() || '',
    fromEmail: input.fromEmail,
    replyToEmail: (input.replyToEmail ?? '').trim(),
    trackingBaseUrl: input.trackingBaseUrl != null ? (String(input.trackingBaseUrl).trim() || null) : null,
    ...(input.dailyEmailLimit !== undefined
      ? { dailyEmailLimit: clampDailyEmailLimit(input.dailyEmailLimit === null ? null : Number(input.dailyEmailLimit)) }
      : {}),
    ...(input.dailyLimitResetAt !== undefined
      ? { dailyLimitResetAt: input.dailyLimitResetAt }
      : {}),
  };
  const pwd = input.password != null ? String(input.password).replace(/\s+/g, '').trim() : '';
  const updates = pwd ? { ...base, password: pwd } : base;
  await db.transaction(async (tx) => {
    await tx.update(smtpSettingsTable).set(updates).where(eq(smtpSettingsTable.id, profileId));
    // Keep the primary (earliest) alias's identity aligned with the profile's From.
    const [primary] = await tx
      .select({ id: smtpAliasesTable.id })
      .from(smtpAliasesTable)
      .where(eq(smtpAliasesTable.smtpSettingsId, profileId))
      .orderBy(asc(smtpAliasesTable.id))
      .limit(1);
    if (primary) {
      await tx
        .update(smtpAliasesTable)
        .set({ fromEmail: base.fromEmail, fromName: base.fromName })
        .where(eq(smtpAliasesTable.id, primary.id));
    } else {
      // Profile predates the aliases feature and somehow has none: seed its primary alias.
      await tx.insert(smtpAliasesTable).values({
        smtpSettingsId: profileId,
        userId,
        fromEmail: base.fromEmail,
        fromName: base.fromName,
        dailyEmailLimit: (updates as { dailyEmailLimit?: number | null }).dailyEmailLimit ?? null,
      });
    }
  });
}

/**
 * Deletes the profile even if campaigns/send history reference it: unlinks
 * campaigns (smtpSettingsId -> null) and drops their send-log rows for this
 * profile first, since email_send_log.smtpSettingsId is NOT NULL and can't
 * be nulled out like campaigns can.
 */
export async function deleteSmtpProfile(userId: number, profileId: number): Promise<void> {
  const rows = await db
    .select({ id: smtpSettingsTable.id })
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.id, profileId)))
    .limit(1);
  if (!rows[0]) {
    throw new Error('SMTP profile not found');
  }
  await db.transaction(async (tx) => {
    await tx.delete(emailSendLogTable).where(eq(emailSendLogTable.smtpSettingsId, profileId));
    await tx
      .update(campaignTable)
      .set({ smtpSettingsId: null })
      .where(eq(campaignTable.smtpSettingsId, profileId));
    await tx.delete(smtpSettingsTable).where(eq(smtpSettingsTable.id, profileId));
  });
}

/** @deprecated Use listSmtpProfilesForApi; kept for any legacy imports. */
export async function getSmtpSettingsForApi(userId: number): Promise<SmtpSettingsRow | null> {
  const rows = await db
    .select()
    .from(smtpSettingsTable)
    .where(eq(smtpSettingsTable.userId, userId))
    .orderBy(asc(smtpSettingsTable.id))
    .limit(1);
  return (rows[0] as SmtpSettingsRow) ?? null;
}

/** @deprecated Use insertSmtpProfile / updateSmtpProfile */
export async function saveSmtpSettings(userId: number, input: SmtpSettingsInput): Promise<void> {
  const rows = await db
    .select()
    .from(smtpSettingsTable)
    .where(eq(smtpSettingsTable.userId, userId))
    .orderBy(asc(smtpSettingsTable.id))
    .limit(1);
  const base = {
    provider: input.provider,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    fromName: (input.fromName ?? '').trim() || '',
    fromEmail: input.fromEmail,
    replyToEmail: (input.replyToEmail ?? '').trim(),
    trackingBaseUrl: input.trackingBaseUrl != null ? (String(input.trackingBaseUrl).trim() || null) : null,
  };
  if (rows[0]) {
    const updates = input.password ? { ...base, password: input.password } : base;
    await db.update(smtpSettingsTable).set(updates).where(eq(smtpSettingsTable.id, rows[0].id));
  } else {
    await insertSmtpProfile(userId, { ...input, password: input.password || '' });
  }
}

// ───────────────────────────── Sending aliases (per-alias quota) ─────────────────────────────

export interface SmtpAliasRow {
  id: number;
  smtpSettingsId: number;
  userId: number;
  fromEmail: string;
  fromName: string;
  /** null = default 20, 0 = block, 1-20 = cap */
  dailyEmailLimit: number | null;
  dailyLimitResetAt: Date | null;
  isActive: boolean;
  createdAt: Date;
}

export interface SmtpAliasInput {
  /** Required on create; optional on update (only changes when provided). */
  fromEmail?: string;
  fromName?: string;
  dailyEmailLimit?: number | null;
  isActive?: boolean;
}

/** Aliases of a profile, earliest first (the earliest is the profile's primary From). */
export async function listAliasesForProfile(userId: number, smtpSettingsId: number): Promise<SmtpAliasRow[]> {
  const rows = await db
    .select()
    .from(smtpAliasesTable)
    .where(and(eq(smtpAliasesTable.userId, userId), eq(smtpAliasesTable.smtpSettingsId, smtpSettingsId)))
    .orderBy(asc(smtpAliasesTable.id));
  return rows as SmtpAliasRow[];
}

/** All of a user's aliases across every profile (earliest first). Used by quota summaries. */
export async function listAliasesForUser(userId: number): Promise<SmtpAliasRow[]> {
  const rows = await db
    .select()
    .from(smtpAliasesTable)
    .where(eq(smtpAliasesTable.userId, userId))
    .orderBy(asc(smtpAliasesTable.smtpSettingsId), asc(smtpAliasesTable.id));
  return rows as SmtpAliasRow[];
}

export async function getAliasRow(userId: number, aliasId: number): Promise<SmtpAliasRow | null> {
  const rows = await db
    .select()
    .from(smtpAliasesTable)
    .where(and(eq(smtpAliasesTable.userId, userId), eq(smtpAliasesTable.id, aliasId)))
    .limit(1);
  return (rows[0] as SmtpAliasRow) ?? null;
}

/** The profile's primary alias is its earliest one; it may not be removed. */
export async function isPrimaryAlias(smtpSettingsId: number, aliasId: number): Promise<boolean> {
  const [primary] = await db
    .select({ id: smtpAliasesTable.id })
    .from(smtpAliasesTable)
    .where(eq(smtpAliasesTable.smtpSettingsId, smtpSettingsId))
    .orderBy(asc(smtpAliasesTable.id))
    .limit(1);
  return primary?.id === aliasId;
}

export async function insertAlias(userId: number, smtpSettingsId: number, input: SmtpAliasInput): Promise<number> {
  const fromEmail = (input.fromEmail ?? '').trim();
  if (!fromEmail) throw new Error('ALIAS_FROM_EMAIL_REQUIRED');
  const cap =
    input.dailyEmailLimit === undefined
      ? SMTP_DAILY_EMAIL_LIMIT_MAX
      : clampDailyEmailLimit(input.dailyEmailLimit === null ? null : Number(input.dailyEmailLimit), SMTP_DAILY_EMAIL_LIMIT_MAX);
  const dup = await db
    .select({ id: smtpAliasesTable.id })
    .from(smtpAliasesTable)
    .where(
      and(
        eq(smtpAliasesTable.smtpSettingsId, smtpSettingsId),
        sql`lower(${smtpAliasesTable.fromEmail}) = ${fromEmail.toLowerCase()}`
      )
    )
    .limit(1);
  if (dup.length > 0) throw new Error('ALIAS_DUPLICATE_EMAIL');
  const [row] = await db
    .insert(smtpAliasesTable)
    .values({
      smtpSettingsId,
      userId,
      fromEmail,
      fromName: (input.fromName ?? '').trim(),
      dailyEmailLimit: cap,
      isActive: input.isActive ?? true,
    })
    .returning({ id: smtpAliasesTable.id });
  if (!row?.id) throw new Error('Failed to create alias');
  return row.id;
}

export async function updateAlias(userId: number, aliasId: number, input: SmtpAliasInput): Promise<void> {
  const current = await getAliasRow(userId, aliasId);
  if (!current) throw new Error('ALIAS_NOT_FOUND');
  if (input.fromEmail && input.fromEmail.trim().toLowerCase() !== current.fromEmail.toLowerCase()) {
    const dup = await db
      .select({ id: smtpAliasesTable.id })
      .from(smtpAliasesTable)
      .where(
        and(
          eq(smtpAliasesTable.smtpSettingsId, current.smtpSettingsId),
          sql`lower(${smtpAliasesTable.fromEmail}) = ${input.fromEmail.trim().toLowerCase()}`,
          ne(smtpAliasesTable.id, aliasId)
        )
      )
      .limit(1);
    if (dup.length > 0) throw new Error('ALIAS_DUPLICATE_EMAIL');
  }
  const set: Record<string, unknown> = {};
  if (input.fromEmail !== undefined) set.fromEmail = input.fromEmail.trim();
  if (input.fromName !== undefined) set.fromName = (input.fromName ?? '').trim();
  if (input.isActive !== undefined) set.isActive = input.isActive;
  if (input.dailyEmailLimit !== undefined) {
    const newCap = clampDailyEmailLimit(input.dailyEmailLimit === null ? null : Number(input.dailyEmailLimit));
    set.dailyEmailLimit = newCap;
    // Mirror the profile rule: when the cap goes from unlimited/blocked to a positive value,
    // start a fresh window so earlier sends don't eat the new quota.
    const prev = current.dailyEmailLimit;
    const wasUncapped = prev == null || prev === 0;
    if (wasUncapped && newCap != null && newCap > 0) set.dailyLimitResetAt = new Date();
  }
  if (Object.keys(set).length === 0) return;
  await db.update(smtpAliasesTable).set(set).where(eq(smtpAliasesTable.id, aliasId));
}

export async function deleteAlias(userId: number, aliasId: number): Promise<void> {
  const current = await getAliasRow(userId, aliasId);
  if (!current) throw new Error('ALIAS_NOT_FOUND');
  if (await isPrimaryAlias(current.smtpSettingsId, aliasId)) {
    throw new Error('ALIAS_PRIMARY_LOCKED');
  }
  // email_send_log.alias_id is ON DELETE SET NULL, so history survives (smtp_settings_id stays).
  await db.delete(smtpAliasesTable).where(eq(smtpAliasesTable.id, aliasId));
}
