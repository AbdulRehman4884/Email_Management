import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../lib/db.js';
import { usersTable, subscriptionsTable, plansTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { signToken, tokenMaxAgeMs } from '../middleware/authMiddleware.js';
import { isSameAppOrigin } from '../middleware/csrf.js';
import { clearSessionCookies, CSRF_COOKIE, readCookie, REFRESH_COOKIE, setSessionCookies } from '../lib/authCookies.js';
import { createSession, revokeAllSessionsForUser, revokeSessionByToken, rotateSession, type IssuedSession } from '../lib/refreshTokens.js';
import {
  validatePassword,
  signupBodySchema,
  loginBodySchema,
  forgotPasswordBodySchema,
  verifyResetOtpBodySchema,
  resetPasswordBodySchema,
} from '../lib/passwordValidation.js';
import { sendEmailViaEnv } from '../lib/smtp.js';
import { allowHit, hitCount, secondsUntilReset, clearHits } from '../lib/publicRateLimit.js';
import { clientIp } from '../lib/crm/webTracking.js';

/**
 * N-07 / N-17: short access token + rotating refresh token, both in HttpOnly cookies.
 * The JSON body still carries `token` (kept in memory only by the web app; used as Bearer for the AI agent) and
 * `csrfToken` (sent back as X-CSRF-Token on cookie-authenticated writes).
 */
function sendSessionCookies(res: Response, user: { id: number; email: string; role: string }, session: IssuedSession): string {
  const token = signToken({ userId: user.id, email: user.email, role: user.role });
  setSessionCookies(res, {
    accessToken: token,
    accessMaxAgeMs: tokenMaxAgeMs(token),
    refreshToken: session.refreshToken,
    refreshMaxAgeMs: session.refreshMaxAgeMs,
    csrfToken: session.csrfToken,
  });
  return token;
}

async function startCookieSession(req: Request, res: Response, user: { id: number; email: string; role: string }) {
  const session = await createSession(user.id, { userAgent: req.get('user-agent'), ip: clientIp(req) });
  const token = sendSessionCookies(res, user, session);
  return { token, csrfToken: session.csrfToken };
}

// SEC-02: failed sign-ins allowed per window, per account and per client IP.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS_PER_ACCOUNT = 5;
const MAX_FAILED_LOGINS_PER_IP = 20;
// SEC-01: forgot-password requests per window (same answer for known and unknown emails).
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FORGOT_PER_EMAIL = 3;
const MAX_FORGOT_PER_IP = 10;
const FORGOT_NEUTRAL_MESSAGE = 'If an account exists for this email, we sent an OTP. Check your inbox.';

function tooManyLoginsMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many failed sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

const SALT_ROUNDS = 10;

function generateSixDigitOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function getOtpEmailHtml(otp: string) {
  return `
    <div style="font-family: Arial, sans-serif;">
      <h2>Password Reset</h2>
      <p>Your OTP code is:</p>
      <div style="font-size: 28px; font-weight: bold; letter-spacing: 3px;">${otp}</div>
      <p>This OTP will expire in 10 minutes.</p>
    </div>
  `;
}

export async function signup(req: Request, res: Response) {
  try {
    const parsed = signupBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const msg = first?.message ?? 'Validation failed';
      return res.status(400).json({ error: msg });
    }
    const { email, password, name } = parsed.data;

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.success) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password.trim(), SALT_ROUNDS);
    const [user] = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        name,
        role: 'user',
      })
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        preferredTheme: usersTable.preferredTheme,
      });

    if (!user) {
      return res.status(500).json({ error: 'Failed to create user' });
    }

    const { token, csrfToken } = await startCookieSession(req, res, user);
    return res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, preferredTheme: user.preferredTheme },
      token,
      csrfToken,
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
}

export async function login(req: Request, res: Response) {
  try {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }
    const { email, password } = parsed.data;

    const accountKey = `login:acct:${email}`;
    const ipKey = `login:ip:${clientIp(req)}`;
    if (hitCount(accountKey) >= MAX_FAILED_LOGINS_PER_ACCOUNT || hitCount(ipKey) >= MAX_FAILED_LOGINS_PER_IP) {
      const wait = Math.max(secondsUntilReset(accountKey), secondsUntilReset(ipKey));
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: tooManyLoginsMessage(wait) });
    }
    const recordFailure = () => {
      allowHit(accountKey, MAX_FAILED_LOGINS_PER_ACCOUNT, LOGIN_WINDOW_MS);
      allowHit(ipKey, MAX_FAILED_LOGINS_PER_IP, LOGIN_WINDOW_MS);
    };

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !user.isActive) {
      recordFailure();
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      recordFailure();
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    clearHits(accountKey);

    const { token, csrfToken } = await startCookieSession(req, res, user);
    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, preferredTheme: user.preferredTheme },
      token,
      csrfToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Invalid email or password' });
  }
}

export async function me(req: Request, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const [user] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        preferredTheme: usersTable.preferredTheme,
      })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id))
      .limit(1);
    if (!user || !user.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Attach active plan info
    const planRows = await db
      .select({
        code: plansTable.code,
        name: plansTable.name,
        smtpLimit: plansTable.smtpLimit,
        dailyEmailLimit: plansTable.dailyEmailLimit,
        inboxEnabled: plansTable.inboxEnabled,
        followUpEnabled: plansTable.followUpEnabled,
        crmEnabled: plansTable.crmEnabled,
      })
      .from(subscriptionsTable)
      .innerJoin(plansTable, eq(subscriptionsTable.planCode, plansTable.code))
      .where(eq(subscriptionsTable.userId, user.id))
      .limit(1);

    return res.status(200).json({ user: { ...user, plan: planRows[0] ?? null } });
  } catch (err) {
    console.error('Me error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

const THEME_VALUES = ['light', 'dark', 'system'] as const;
type PreferredTheme = (typeof THEME_VALUES)[number];

export async function updatePreferredTheme(req: Request, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const raw = req.body?.preferredTheme;
    const preferredTheme =
      typeof raw === 'string' && THEME_VALUES.includes(raw as PreferredTheme) ? (raw as PreferredTheme) : undefined;
    if (!preferredTheme) {
      return res.status(400).json({ error: 'preferredTheme must be one of: light, dark, system' });
    }
    const [updated] = await db
      .update(usersTable)
      .set({ preferredTheme })
      .where(eq(usersTable.id, req.user!.id))
      .returning({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        preferredTheme: usersTable.preferredTheme,
      });
    if (!updated) {
      return res.status(500).json({ error: 'Failed to update theme' });
    }
    return res.status(200).json({ user: updated });
  } catch (err) {
    console.error('updatePreferredTheme error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

export async function forgotPassword(req: Request, res: Response) {
  try {
    const parsed = forgotPasswordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? 'Validation failed' });
    }
    const { email } = parsed.data;

    // SEC-01: throttle per email and per IP before looking the user up, so known and unknown emails behave the same.
    if (
      !allowHit(`forgot:email:${email}`, MAX_FORGOT_PER_EMAIL, FORGOT_WINDOW_MS) ||
      !allowHit(`forgot:ip:${clientIp(req)}`, MAX_FORGOT_PER_IP, FORGOT_WINDOW_MS)
    ) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !user.isActive) {
      // SEC-01: same neutral answer as for a registered email - do not reveal which emails have accounts.
      return res.status(200).json({ message: FORGOT_NEUTRAL_MESSAGE });
    }

    const now = new Date();
    const lastRequestedAt = user.passwordResetRequestedAt;
    const COOLDOWN_MS = 60_000;
    if (lastRequestedAt) {
      const elapsed = now.getTime() - lastRequestedAt.getTime();
      if (elapsed >= 0 && elapsed < COOLDOWN_MS) {
        // SEC-01: an OTP was just sent - answer neutrally (unknown emails get the same reply) and send nothing new.
        return res.status(200).json({ message: FORGOT_NEUTRAL_MESSAGE });
      }
    }

    const otp = generateSixDigitOtp();
    const otpHash = sha256Hex(otp);
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

    await db
      .update(usersTable)
      .set({
        passwordResetOtpHash: otpHash,
        passwordResetOtpExpiresAt: expiresAt,
        passwordResetOtpUsedAt: null,
        passwordResetRequestedAt: now,
      })
      .where(eq(usersTable.id, user.id));

    try {
      await sendEmailViaEnv({
        to: user.email,
        subject: 'Your password reset OTP',
        html: getOtpEmailHtml(otp),
        text: `Your password reset OTP is: ${otp}. It expires in 10 minutes.`,
      });
    } catch (e) {
      console.error('[Auth] Failed to send OTP email:', e);
      return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }

    return res.status(200).json({ message: FORGOT_NEUTRAL_MESSAGE });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}

export async function verifyResetOtp(req: Request, res: Response) {
  try {
    const parsed = verifyResetOtpBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? 'Validation failed' });
    }
    const { email, otp } = parsed.data;
    const otpHash = sha256Hex(otp);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !user.isActive) {
      return res.status(400).json({ error: 'Invalid OTP or email.' });
    }

    if (!user.passwordResetOtpHash || user.passwordResetOtpUsedAt) {
      return res.status(400).json({ error: 'Invalid OTP or email.' });
    }

    const expiresAt = user.passwordResetOtpExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }

    if (user.passwordResetOtpHash !== otpHash) {
      return res.status(400).json({ error: 'Invalid OTP or email.' });
    }

    return res.status(200).json({ message: 'OTP verified.' });
  } catch (error) {
    console.error('Verify reset OTP error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}

export async function resetPassword(req: Request, res: Response) {
  try {
    const parsed = resetPasswordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({ error: first?.message ?? 'Validation failed' });
    }
    const { email, otp, newPassword, confirmPassword } = parsed.data;

    if (newPassword.trim() !== confirmPassword.trim()) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.success) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    const otpHash = sha256Hex(otp);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !user.isActive) {
      return res.status(400).json({ error: 'Invalid OTP or email.' });
    }

    if (!user.passwordResetOtpHash || user.passwordResetOtpUsedAt) {
      return res.status(400).json({ error: 'Invalid OTP or email.' });
    }

    const expiresAt = user.passwordResetOtpExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }

    if (user.passwordResetOtpHash !== otpHash) {
      return res.status(400).json({ error: 'Invalid OTP or email.' });
    }

    const passwordHash = await bcrypt.hash(newPassword.trim(), SALT_ROUNDS);
    const now = new Date();

    await db
      .update(usersTable)
      .set({
        passwordHash,
        passwordResetOtpHash: null,
        passwordResetOtpExpiresAt: null,
        passwordResetOtpUsedAt: now,
        passwordResetRequestedAt: null,
      })
      .where(eq(usersTable.id, user.id));
    // N-17: a new password ends every existing session (refresh tokens); access tokens expire within minutes.
    await revokeAllSessionsForUser(user.id);

    return res.status(200).json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}

const sessionUserColumns = {
  id: usersTable.id,
  email: usersTable.email,
  name: usersTable.name,
  role: usersTable.role,
  preferredTheme: usersTable.preferredTheme,
  isActive: usersTable.isActive,
};

/**
 * POST /api/auth/refresh (N-17): exchanges the mf_rt cookie for a new access token + rotated refresh token.
 * 401 { code } when there is no valid session: NO_SESSION, REFRESH_RACE (another tab just refreshed; retry once),
 * SESSION_ENDED (expired, reused, revoked or user deactivated).
 */
export async function refreshSession(req: Request, res: Response) {
  try {
    if (!isSameAppOrigin(req)) return res.status(403).json({ error: 'Request origin not allowed', code: 'CSRF' });
    const raw = readCookie(req, REFRESH_COOKIE);
    if (!raw) return res.status(401).json({ error: 'Not signed in', code: 'NO_SESSION' });
    const rotated = await rotateSession(raw, { userAgent: req.get('user-agent'), ip: clientIp(req) }, readCookie(req, CSRF_COOKIE));
    if (!rotated.ok) {
      if (rotated.reason === 'race') return res.status(401).json({ error: 'Session is being refreshed', code: 'REFRESH_RACE' });
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Session ended, please sign in again', code: 'SESSION_ENDED' });
    }
    const [user] = await db.select(sessionUserColumns).from(usersTable).where(eq(usersTable.id, rotated.userId)).limit(1);
    if (!user || !user.isActive) {
      clearSessionCookies(res);
      return res.status(401).json({ error: 'Session ended, please sign in again', code: 'SESSION_ENDED' });
    }
    const token = sendSessionCookies(res, user, rotated);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, preferredTheme: user.preferredTheme },
      token,
      csrfToken: rotated.csrfToken,
    });
  } catch (err) {
    console.error('Refresh session error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/** POST /api/auth/logout (N-17): ends this login's session on the server and clears the cookies. */
export async function logoutSession(req: Request, res: Response) {
  try {
    if (!isSameAppOrigin(req)) return res.status(403).json({ error: 'Request origin not allowed', code: 'CSRF' });
    const raw = readCookie(req, REFRESH_COOKIE);
    if (raw) await revokeSessionByToken(raw);
    clearSessionCookies(res);
    return res.status(200).json({ message: 'Signed out' });
  } catch (err) {
    console.error('Logout error:', err);
    clearSessionCookies(res);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * POST /api/auth/session (migration only, N-07): a browser that still has an old 7-day token in localStorage
 * sends it once as Bearer and gets a cookie session instead, so nobody has to sign in again.
 * Remove after the old tokens have expired (7 days after the new web build is live).
 */
export async function upgradeLegacySession(req: Request, res: Response) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!isSameAppOrigin(req)) return res.status(403).json({ error: 'Request origin not allowed', code: 'CSRF' });
    const [user] = await db.select(sessionUserColumns).from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
    if (!user || !user.isActive) return res.status(401).json({ error: 'Unauthorized' });
    const { token, csrfToken } = await startCookieSession(req, res, user);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, preferredTheme: user.preferredTheme },
      token,
      csrfToken,
    });
  } catch (err) {
    console.error('Upgrade session error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
