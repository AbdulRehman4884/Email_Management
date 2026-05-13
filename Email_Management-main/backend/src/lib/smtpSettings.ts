import { db } from './db';
import { smtpSettingsTable } from '../db/schema';
import { and, asc, count, eq } from 'drizzle-orm';

export const SMTP_PROFILES_MAX = 5;

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
  dailyEmailLimit: number;
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
  /** Per-day send cap for this profile; 0 = unlimited */
  dailyEmailLimit?: number;
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

export async function insertSmtpProfile(userId: number, input: SmtpSettingsInput): Promise<number> {
  const n = await countSmtpProfiles(userId);
  if (n >= SMTP_PROFILES_MAX) {
    throw new Error('SMTP_PROFILE_LIMIT');
  }
  const dailyCap =
    input.dailyEmailLimit !== undefined && Number.isFinite(input.dailyEmailLimit)
      ? Math.max(0, Math.floor(Number(input.dailyEmailLimit)))
      : 50;
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
  const [row] = await db.insert(smtpSettingsTable).values({ ...base, userId }).returning({ id: smtpSettingsTable.id });
  if (!row?.id) throw new Error('Failed to create SMTP profile');
  return row.id;
}

export async function updateSmtpProfile(
  userId: number,
  profileId: number,
  input: Omit<SmtpSettingsInput, 'password'> & { password?: string }
): Promise<void> {
  const rows = await db
    .select({ id: smtpSettingsTable.id })
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.id, profileId)))
    .limit(1);
  if (!rows[0]) {
    throw new Error('SMTP profile not found');
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
    ...(input.dailyEmailLimit !== undefined && Number.isFinite(input.dailyEmailLimit)
      ? { dailyEmailLimit: Math.max(0, Math.floor(Number(input.dailyEmailLimit))) }
      : {}),
  };
  const pwd = input.password != null ? String(input.password).replace(/\s+/g, '').trim() : '';
  const updates = pwd ? { ...base, password: pwd } : base;
  await db.update(smtpSettingsTable).set(updates).where(eq(smtpSettingsTable.id, profileId));
}

export async function deleteSmtpProfile(userId: number, profileId: number): Promise<void> {
  const rows = await db
    .select({ id: smtpSettingsTable.id })
    .from(smtpSettingsTable)
    .where(and(eq(smtpSettingsTable.userId, userId), eq(smtpSettingsTable.id, profileId)))
    .limit(1);
  if (!rows[0]) {
    throw new Error('SMTP profile not found');
  }
  await db.delete(smtpSettingsTable).where(eq(smtpSettingsTable.id, profileId));
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
