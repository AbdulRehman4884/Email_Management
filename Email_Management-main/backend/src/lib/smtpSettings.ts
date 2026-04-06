import { db } from './db';
import { smtpSettingsTable } from '../db/schema';
import { eq } from 'drizzle-orm';

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
  trackingBaseUrl: string | null;
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
  trackingBaseUrl?: string | null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  provider?: string;
  trackingBaseUrl?: string | null;
}

/** Get SMTP settings from DB for a user; if none, fall back to process.env */
export async function getSmtpSettings(userId: number): Promise<SmtpConfig> {
  const rows = await db.select().from(smtpSettingsTable).where(eq(smtpSettingsTable.userId, userId)).limit(1);
  if (rows[0]) {
    const r = rows[0];
    return {
      host: r.host,
      port: r.port,
      secure: r.secure,
      user: r.user,
      pass: r.password,
      fromName: r.fromName ?? '',
      fromEmail: r.fromEmail,
      provider: r.provider,
      trackingBaseUrl: r.trackingBaseUrl ?? undefined,
    };
  }
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

/** Get settings for API response — password is returned so the UI can pre-fill the field. */
export async function getSmtpSettingsForApi(userId: number): Promise<SmtpSettingsRow | null> {
  const rows = await db.select().from(smtpSettingsTable).where(eq(smtpSettingsTable.userId, userId)).limit(1);
  return rows[0] ?? null;
}

/** Save SMTP settings (upsert per user). Password optional on update (blank = keep existing). */
export async function saveSmtpSettings(userId: number, input: SmtpSettingsInput): Promise<void> {
  const rows = await db.select().from(smtpSettingsTable).where(eq(smtpSettingsTable.userId, userId)).limit(1);
  const base = {
    provider: input.provider,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    fromName: (input.fromName ?? '').trim() || '',
    fromEmail: input.fromEmail,
    trackingBaseUrl: input.trackingBaseUrl != null ? (String(input.trackingBaseUrl).trim() || null) : null,
  };
  if (rows[0]) {
    const updates = input.password ? { ...base, password: input.password } : base;
    await db.update(smtpSettingsTable).set(updates).where(eq(smtpSettingsTable.id, rows[0].id));
  } else {
    await db.insert(smtpSettingsTable).values({
      ...base,
      userId,
      password: input.password || '',
    });
  }
}
