import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../lib/db.js';
import { usersTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { signToken } from '../middleware/authMiddleware.js';
import {
  validatePassword,
  signupBodySchema,
  loginBodySchema,
  forgotPasswordBodySchema,
  verifyResetOtpBodySchema,
  resetPasswordBodySchema,
} from '../lib/passwordValidation.js';
import { sendEmailViaEnv } from '../lib/smtp.js';

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

    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    return res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, preferredTheme: user.preferredTheme },
      token,
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

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, preferredTheme: user.preferredTheme },
      token,
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
    return res.status(200).json({ user });
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

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    // Generic response to prevent account enumeration
    const generic = { message: 'If the email exists, an OTP has been sent to your inbox.' };

    if (!user || !user.isActive) {
      return res.status(200).json(generic);
    }

    const otp = generateSixDigitOtp();
    const otpHash = sha256Hex(otp);
    const now = new Date();
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
      // Still return generic response (do not leak email existence / deliverability)
      console.error('[Auth] Failed to send OTP email:', e);
    }

    return res.status(200).json(generic);
  } catch (error) {
    console.error('Forgot password error:', error);
    // Avoid leaking: return generic message
    return res.status(200).json({ message: 'If the email exists, an OTP has been sent to your inbox.' });
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

    return res.status(200).json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}
