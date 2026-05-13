import type { Request, Response } from 'express';
import {
  SMTP_PROFILES_MAX,
  deleteSmtpProfile,
  insertSmtpProfile,
  listSmtpProfilesForUser,
  updateSmtpProfile,
} from '../lib/smtpSettings';
import { SMTP_LIMITS, firstLengthViolation } from '../constants/fieldLimits';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GMAIL_APP_PASSWORD_LENGTH = 16;

function normalizeSmtpPassword(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function isGmailSmtpConfig(provider: string, host: string, user: string, fromEmail: string): boolean {
  return (
    provider.toLowerCase() === 'gmail' ||
    host.toLowerCase().includes('smtp.gmail.com') ||
    user.toLowerCase().endsWith('@gmail.com') ||
    fromEmail.toLowerCase().endsWith('@gmail.com')
  );
}

type ValidateCtx = { mode: 'create' | 'update'; hasExistingPassword: boolean };

type ParsedSmtpBody = {
  portNum: number;
  providerStr: string;
  hostStr: string;
  userStr: string;
  fromNameClean: string;
  fromEmailStr: string;
  replyToEmailStr: string;
  trackingStr: string;
  normalizedPassword: string;
  secure: boolean;
};

function validateSmtpBody(
  body: unknown,
  ctx: ValidateCtx
): { ok: false; fieldErrors: Record<string, string>; error?: string } | { ok: true; data: ParsedSmtpBody } {
  const b = body as Record<string, unknown>;
  const providerStr = String(b.provider ?? '').trim();
  const hostStr = String(b.host ?? '').trim();
  const userStr = String(b.user ?? '').trim();
  const fromNameClean = b.fromName != null ? String(b.fromName).trim() : '';
  const fromEmailStr = String(b.fromEmail ?? '').trim();
  const replyToEmailStr = b.replyToEmail != null ? String(b.replyToEmail).trim() : '';
  const trackingStr = b.trackingBaseUrl != null ? String(b.trackingBaseUrl).trim() : '';
  const passwordStr = b.password != null ? String(b.password) : '';
  const normalizedPassword = normalizeSmtpPassword(passwordStr);
  const portRaw = String(b.port ?? '').trim();
  const fieldErrors: Record<string, string> = {};

  if (!providerStr) fieldErrors.provider = 'Provider is required.';
  if (!hostStr) fieldErrors.host = 'SMTP host is required.';
  if (!portRaw) {
    fieldErrors.port = 'Port is required.';
  }

  const portNum = Number(portRaw);
  if (!fieldErrors.port && (Number.isNaN(portNum) || portNum < 1 || portNum > 65535)) {
    fieldErrors.port = 'Port must be between 1 and 65535.';
  }

  if (!userStr) {
    fieldErrors.user = 'Username is required.';
  } else if (!EMAIL_REGEX.test(userStr)) {
    fieldErrors.user = 'Username must be a valid email address.';
  }
  if (!fromEmailStr) {
    fieldErrors.fromEmail = 'From email is required.';
  } else if (!EMAIL_REGEX.test(fromEmailStr)) {
    fieldErrors.fromEmail = 'From email must be a valid email address.';
  }
  if (
    userStr &&
    fromEmailStr &&
    EMAIL_REGEX.test(userStr) &&
    EMAIL_REGEX.test(fromEmailStr) &&
    userStr.toLowerCase() !== fromEmailStr.toLowerCase()
  ) {
    fieldErrors.user = 'Username and From email must be the same.';
    fieldErrors.fromEmail = 'From email and Username must be the same.';
  }

  if (isGmailSmtpConfig(providerStr, hostStr, userStr, fromEmailStr)) {
    if (!normalizedPassword && (!ctx.hasExistingPassword || ctx.mode === 'create')) {
      fieldErrors.password = 'Gmail SMTP requires a 16-character Google App Password.';
    } else if (normalizedPassword && normalizedPassword.length !== GMAIL_APP_PASSWORD_LENGTH) {
      fieldErrors.password = 'Gmail App Password must be exactly 16 characters.';
    }
  } else if (ctx.mode === 'create' && !normalizedPassword) {
    fieldErrors.password = 'Password is required for a new SMTP profile.';
  }

  if (replyToEmailStr && !EMAIL_REGEX.test(replyToEmailStr)) {
    fieldErrors.replyToEmail = 'Reply-to email must be a valid email address.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const smtpChecks: Array<{ label: string; value: string; max: number }> = [
    { label: 'Provider', value: providerStr, max: SMTP_LIMITS.provider },
    { label: 'SMTP host', value: hostStr, max: SMTP_LIMITS.host },
    { label: 'Username', value: userStr, max: SMTP_LIMITS.user },
    { label: 'Sender name', value: fromNameClean, max: SMTP_LIMITS.fromName },
    { label: 'From email', value: fromEmailStr, max: SMTP_LIMITS.fromEmail },
  ];
  if (trackingStr) {
    smtpChecks.push({ label: 'Tracking base URL', value: trackingStr, max: SMTP_LIMITS.trackingBaseUrl });
  }
  if (passwordStr && normalizedPassword) {
    smtpChecks.push({ label: 'Password', value: passwordStr, max: SMTP_LIMITS.password });
  }
  const smtpLenErr = firstLengthViolation(smtpChecks);
  if (smtpLenErr) {
    const fe: Record<string, string> = {};
    if (smtpLenErr.startsWith('Provider ')) fe.provider = smtpLenErr;
    if (smtpLenErr.startsWith('SMTP host ')) fe.host = smtpLenErr;
    if (smtpLenErr.startsWith('Username ')) fe.user = smtpLenErr;
    if (smtpLenErr.startsWith('From email ')) fe.fromEmail = smtpLenErr;
    if (Object.keys(fe).length > 0) {
      return { ok: false, fieldErrors: fe };
    }
    return { ok: false, fieldErrors: {}, error: smtpLenErr };
  }

  return {
    ok: true,
    data: {
      portNum,
      providerStr,
      hostStr,
      userStr,
      fromNameClean,
      fromEmailStr,
      replyToEmailStr,
      trackingStr,
      normalizedPassword,
      secure: Boolean(b.secure),
    },
  };
}

function profileToJson(row: {
  id: number;
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
  dailyEmailLimit?: number;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    provider: row.provider,
    host: row.host,
    port: row.port,
    secure: row.secure,
    user: row.user,
    password: '',
    fromName: row.fromName ?? '',
    fromEmail: row.fromEmail,
    replyToEmail: row.replyToEmail ?? '',
    trackingBaseUrl: row.trackingBaseUrl ?? '',
    dailyEmailLimit: row.dailyEmailLimit ?? 50,
    updatedAt: row.updatedAt,
    hasPassword: Boolean(row.password),
  };
}

function parseDailyEmailLimitFromBody(body: unknown): number | undefined {
  const b = body as Record<string, unknown>;
  if (b.dailyEmailLimit === undefined || b.dailyEmailLimit === null || b.dailyEmailLimit === '') return undefined;
  const n = Number(b.dailyEmailLimit);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return undefined;
  return Math.floor(n);
}

export async function listSmtpProfilesHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await listSmtpProfilesForUser(userId);
    res.status(200).json({
      profiles: rows.map(profileToJson),
      max: SMTP_PROFILES_MAX,
    });
  } catch (error) {
    console.error('Error listing SMTP profiles:', error);
    res.status(500).json({ error: 'Failed to list SMTP profiles' });
  }
}

export async function postSmtpProfileHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const v = validateSmtpBody(req.body, { mode: 'create', hasExistingPassword: false });
    if (!v.ok) {
      return res.status(400).json({
        error: v.error ?? 'Please fix the highlighted fields.',
        ...(Object.keys(v.fieldErrors).length > 0 ? { fieldErrors: v.fieldErrors } : {}),
      });
    }
    const parsed = v.data;

    const dailyLimit = parseDailyEmailLimitFromBody(req.body);

    try {
      const id = await insertSmtpProfile(userId, {
        provider: parsed.providerStr,
        host: parsed.hostStr,
        port: parsed.portNum,
        secure: parsed.secure,
        user: parsed.userStr,
        password: parsed.normalizedPassword,
        fromName: parsed.fromNameClean,
        fromEmail: parsed.fromEmailStr,
        replyToEmail: parsed.replyToEmailStr,
        trackingBaseUrl: parsed.trackingStr || null,
        ...(dailyLimit !== undefined ? { dailyEmailLimit: dailyLimit } : {}),
      });
      res.status(201).json({ id, message: 'SMTP profile created' });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'SMTP_PROFILE_LIMIT') {
        return res.status(400).json({ error: `You can have at most ${SMTP_PROFILES_MAX} SMTP profiles.` });
      }
      throw e;
    }
  } catch (error) {
    console.error('Error creating SMTP profile:', error);
    res.status(500).json({ error: 'Failed to create SMTP profile' });
  }
}

export async function putSmtpProfileHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const profileId = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(profileId) || profileId < 1) {
      return res.status(400).json({ error: 'Invalid profile id' });
    }

    const rows = await listSmtpProfilesForUser(userId);
    const existing = rows.find((r) => r.id === profileId);
    if (!existing) {
      return res.status(404).json({ error: 'SMTP profile not found' });
    }

    const v = validateSmtpBody(req.body, {
      mode: 'update',
      hasExistingPassword: Boolean(existing.password),
    });
    if (!v.ok) {
      return res.status(400).json({
        error: v.error ?? 'Please fix the highlighted fields.',
        ...(Object.keys(v.fieldErrors).length > 0 ? { fieldErrors: v.fieldErrors } : {}),
      });
    }
    const parsed = v.data;
    const dailyLimit = parseDailyEmailLimitFromBody(req.body);

    await updateSmtpProfile(userId, profileId, {
      provider: parsed.providerStr,
      host: parsed.hostStr,
      port: parsed.portNum,
      secure: parsed.secure,
      user: parsed.userStr,
      fromName: parsed.fromNameClean,
      fromEmail: parsed.fromEmailStr,
      replyToEmail: parsed.replyToEmailStr,
      trackingBaseUrl: parsed.trackingStr || null,
      password: parsed.normalizedPassword || undefined,
      ...(dailyLimit !== undefined ? { dailyEmailLimit: dailyLimit } : {}),
    });
    res.status(200).json({ message: 'SMTP profile updated' });
  } catch (error) {
    console.error('Error updating SMTP profile:', error);
    res.status(500).json({ error: 'Failed to update SMTP profile' });
  }
}

export async function deleteSmtpProfileHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const profileId = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(profileId) || profileId < 1) {
      return res.status(400).json({ error: 'Invalid profile id' });
    }

    try {
      await deleteSmtpProfile(userId, profileId);
      res.status(200).json({ message: 'SMTP profile deleted' });
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'SMTP profile not found') {
        return res.status(404).json({ error: 'SMTP profile not found' });
      }
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === '23503') {
        return res.status(409).json({
          error: 'This SMTP profile is linked to a campaign and cannot be deleted.',
        });
      }
      throw e;
    }
  } catch (error) {
    console.error('Error deleting SMTP profile:', error);
    res.status(500).json({ error: 'Failed to delete SMTP profile' });
  }
}

/** Returns first profile plus full list (for older clients). */
export async function getSmtpSettingsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await listSmtpProfilesForUser(userId);
    const settings = rows[0];
    if (!settings) {
      return res.status(200).json({
        provider: '',
        host: '',
        port: 587,
        secure: false,
        user: '',
        fromName: '',
        fromEmail: '',
        trackingBaseUrl: '',
        dailyEmailLimit: 50,
        hasPassword: false,
        /** Never return SMTP password over the wire; use hasPassword + PUT to update. */
        password: '',
        configuredInDatabase: false,
        /** When false, worker may still use process.env SMTP_* fallback from getSmtpSettings(). */
        usesEnvironmentFallback: true,
        profiles: [],
        max: SMTP_PROFILES_MAX,
      });
    }
    res.status(200).json({
      ...profileToJson(settings),
      configuredInDatabase: true,
      usesEnvironmentFallback: false,
      profiles: rows.map(profileToJson),
      max: SMTP_PROFILES_MAX,
    });
  } catch (error) {
    console.error('Error fetching SMTP settings:', error);
    res.status(500).json({ error: 'Failed to retrieve SMTP settings' });
  }
}

/** Legacy: update first profile only. */
export async function putSmtpSettingsHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await listSmtpProfilesForUser(userId);
    const targetId = rows[0]?.id;
    if (!targetId) {
      return res.status(400).json({ error: 'Create an SMTP profile first (POST /settings/smtp).' });
    }
    const fakeReq = { ...req, params: { id: String(targetId) } } as unknown as Request;
    return putSmtpProfileHandler(fakeReq, res);
  } catch (error) {
    console.error('Error saving SMTP settings:', error);
    res.status(500).json({ error: 'Failed to save SMTP settings' });
  }
}
