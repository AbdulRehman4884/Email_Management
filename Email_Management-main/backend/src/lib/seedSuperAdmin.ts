import bcrypt from 'bcrypt';
import { db } from './db.js';
import { usersTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const SALT_ROUNDS = 10;

export async function seedInitialSuperAdmin(): Promise<void> {
  const email = process.env.INITIAL_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_SUPER_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.role, 'super_admin'))
    .limit(1);
  if (existing.length > 0) return;

  const existingEmail = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  const existingUser = existingEmail[0];
  if (existingUser) {
    await db.update(usersTable).set({ role: 'super_admin' }).where(eq(usersTable.id, existingUser.id));
    console.log('[seed] Existing user promoted to super_admin:', email);
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await db.insert(usersTable).values({
    email,
    passwordHash,
    name: 'Super Admin',
    role: 'super_admin',
  });
  console.log('[seed] Initial super_admin created:', email);
}
