import bcrypt from 'bcrypt';
import { db } from './db.js';
import { usersTable, plansTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { stripe } from './stripe.js';

const SALT_ROUNDS = 10;

const PLANS_SEED = [
  {
    code: 'basic',
    name: 'Basic',
    smtpLimit: 1,
    dailyEmailLimit: 10,
    inboxEnabled: false,
    followUpEnabled: false,
    priceUsd: '9.99',
  },
  {
    code: 'standard',
    name: 'Standard',
    smtpLimit: 3,
    dailyEmailLimit: 25,
    inboxEnabled: true,
    followUpEnabled: true,
    priceUsd: '24.99',
  },
  {
    code: 'premium',
    name: 'Premium',
    smtpLimit: 5,
    dailyEmailLimit: 50,
    inboxEnabled: true,
    followUpEnabled: true,
    priceUsd: '49.99',
  },
] as const;

async function seedPlans(): Promise<void> {
  for (const plan of PLANS_SEED) {
    await db
      .insert(plansTable)
      .values({ ...plan, stripePriceId: null })
      .onConflictDoUpdate({
        target: plansTable.code,
        set: {
          name: plan.name,
          smtpLimit: plan.smtpLimit,
          dailyEmailLimit: plan.dailyEmailLimit,
          inboxEnabled: plan.inboxEnabled,
          followUpEnabled: plan.followUpEnabled,
          priceUsd: plan.priceUsd,
        },
      });
  }
  console.log('[seed] Plans seeded:', PLANS_SEED.map((p) => p.code).join(', '));
}

async function seedStripePrices(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!key || key === 'sk_test_placeholder') {
    console.log('[seed] Skipping Stripe price seeding — STRIPE_SECRET_KEY not set');
    return;
  }

  const plans = await db.select().from(plansTable);

  for (const plan of plans) {
    // Skip if already has a real Stripe price ID (not a placeholder)
    const isReal = plan.stripePriceId &&
      plan.stripePriceId.startsWith('price_') &&
      !plan.stripePriceId.toUpperCase().includes('PRICE_ID_HERE') &&
      plan.stripePriceId.length > 20;
    if (isReal) continue;

    try {
      const product = await stripe.products.create({
        name: `${plan.name} Plan`,
        metadata: { planCode: plan.code },
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(parseFloat(plan.priceUsd) * 100),
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { planCode: plan.code },
      });

      await db
        .update(plansTable)
        .set({ stripePriceId: price.id })
        .where(eq(plansTable.code, plan.code));

      console.log(`[seed] Stripe price created for ${plan.name}: ${price.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[seed] Failed to create Stripe price for ${plan.name}:`, msg);
    }
  }
}

export async function seedInitialSuperAdmin(): Promise<void> {
  // Always seed plans first, then auto-create Stripe prices
  await seedPlans();
  await seedStripePrices();

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
