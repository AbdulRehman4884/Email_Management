import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { db } from '../lib/db.js';
import { usersTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { signToken } from '../middleware/authMiddleware.js';
import { validatePassword, signupBodySchema, loginBodySchema } from '../lib/passwordValidation.js';

const SALT_ROUNDS = 10;

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
