import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { stripe, constructStripeEvent } from '../lib/stripe.js';
import {
  usersTable,
  subscriptionsTable,
  pendingRegistrationsTable,
  paymentEventsTable,
  plansTable,
} from '../db/schema.js';
import { eq, and, lt } from 'drizzle-orm';
import { validatePassword } from '../lib/passwordValidation.js';

const SALT_ROUNDS = 10;

const checkoutBodySchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  planCode: z.enum(['basic', 'standard', 'premium']),
});

async function getPriceId(planCode: string): Promise<string> {
  const [plan] = await db
    .select({ stripePriceId: plansTable.stripePriceId })
    .from(plansTable)
    .where(eq(plansTable.code, planCode))
    .limit(1);

  const priceId = plan?.stripePriceId;
  if (!priceId || priceId.length < 10) {
    throw new Error(`Stripe price not yet configured for plan: ${planCode}. Please restart the server.`);
  }
  return priceId;
}

export async function createCheckoutSession(req: Request, res: Response) {
  try {
    const parsed = checkoutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? 'Validation failed';
      return res.status(400).json({ error: msg });
    }
    const { name, email, password, planCode } = parsed.data;

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.success) {
      return res.status(400).json({ error: passwordCheck.message });
    }

    // Reject if email already has an active user
    const existingUser = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()))
      .limit(1);
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }

    // Clean up any expired pending registrations for this email
    await db.delete(pendingRegistrationsTable)
      .where(and(
        eq(pendingRegistrationsTable.email, email.toLowerCase()),
        lt(pendingRegistrationsTable.expiresAt, new Date()),
      ));

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';

    let priceId: string;
    try {
      priceId = await getPriceId(planCode);
    } catch {
      return res.status(500).json({ error: 'Payment not configured. Please restart the server or contact support.' });
    }

    // Create Stripe Checkout session first to get the session ID
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email.toLowerCase(),
      success_url: `${frontendUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/packages`,
      metadata: { planCode },
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { planCode },
      },
    });

    // Store pending registration keyed by stripe session ID
    await db.insert(pendingRegistrationsTable).values({
      stripeSessionId: session.id,
      email: email.toLowerCase(),
      name: name.trim(),
      passwordHash,
      planCode,
      expiresAt,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[Payment] createCheckoutSession error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

export async function stripeWebhook(req: Request, res: Response) {
  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event;
  try {
    event = constructStripeEvent(req.body as Buffer, sig);
  } catch (err) {
    console.error('[Webhook] Signature verification failed:', err);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotency: skip already-processed events
  const existing = await db.select({ id: paymentEventsTable.id })
    .from(paymentEventsTable)
    .where(eq(paymentEventsTable.stripeEventId, event.id))
    .limit(1);
  if (existing.length > 0) {
    return res.status(200).json({ received: true });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object as import('stripe').Stripe.Checkout.Session);
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(event.data.object as import('stripe').Stripe.Subscription);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object as import('stripe').Stripe.Subscription);
    }

    await db.insert(paymentEventsTable).values({
      stripeEventId: event.id,
      type: event.type,
      payload: event.data.object as Record<string, unknown>,
      processedAt: new Date(),
    });
  } catch (err) {
    console.error(`[Webhook] Error processing ${event.type}:`, err);
    // Still return 200 to prevent Stripe retries for non-transient errors
    return res.status(200).json({ received: true, warning: 'Processing error logged' });
  }

  return res.status(200).json({ received: true });
}

async function handleCheckoutCompleted(session: import('stripe').Stripe.Checkout.Session) {
  const pending = await db.select()
    .from(pendingRegistrationsTable)
    .where(eq(pendingRegistrationsTable.stripeSessionId, session.id))
    .limit(1);

  if (!pending[0]) {
    console.warn('[Webhook] No pending registration for session:', session.id);
    return;
  }

  const reg = pending[0];

  // Check user doesn't already exist (double-delivery protection)
  const existingUser = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, reg.email))
    .limit(1);

  let userId: number;
  if (existingUser[0]) {
    userId = existingUser[0].id;
  } else {
    const [newUser] = await db.insert(usersTable).values({
      email: reg.email,
      passwordHash: reg.passwordHash,
      name: reg.name,
      role: 'user',
    }).returning({ id: usersTable.id });
    if (!newUser?.id) throw new Error('Failed to create user');
    userId = newUser.id;
  }

  // Upsert subscription
  const stripeSubscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? null;
  const stripeCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? null;

  await db.insert(subscriptionsTable).values({
    userId,
    planCode: reg.planCode,
    stripeCustomerId,
    stripeSubscriptionId,
    status: 'active',
    currentPeriodEnd: null,
  }).onConflictDoUpdate({
    target: subscriptionsTable.userId,
    set: {
      planCode: reg.planCode,
      stripeCustomerId,
      stripeSubscriptionId,
      status: 'active',
      updatedAt: new Date(),
    },
  });

  // Delete the pending registration
  await db.delete(pendingRegistrationsTable)
    .where(eq(pendingRegistrationsTable.id, reg.id));

  console.log(`[Webhook] Account created for ${reg.email} with plan ${reg.planCode}`);
}

async function handleSubscriptionUpdated(subscription: import('stripe').Stripe.Subscription) {
  const subId = subscription.id;
  const status = subscription.status;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;

  // Determine plan from metadata or items
  let planCode: string | undefined = subscription.metadata?.planCode;
  if (!planCode && subscription.items?.data?.[0]?.price?.id) {
    const priceId = subscription.items.data[0].price.id;
    const plan = await db.select({ code: plansTable.code })
      .from(plansTable)
      .where(eq(plansTable.stripePriceId, priceId))
      .limit(1);
    planCode = plan[0]?.code;
  }

  const updateData: Record<string, unknown> = {
    status,
    currentPeriodEnd: periodEnd,
    updatedAt: new Date(),
  };
  if (planCode) updateData.planCode = planCode;

  await db.update(subscriptionsTable)
    .set(updateData)
    .where(eq(subscriptionsTable.stripeSubscriptionId, subId));
}

async function handleSubscriptionDeleted(subscription: import('stripe').Stripe.Subscription) {
  await db.update(subscriptionsTable)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(eq(subscriptionsTable.stripeSubscriptionId, subscription.id));
}

export async function getCheckoutStatus(req: Request, res: Response) {
  try {
    const sessionId = String(req.query.session_id ?? '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'session_id is required' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return res.status(200).json({
      status: session.status,
      paymentStatus: session.payment_status,
      email: session.customer_email,
    });
  } catch (err) {
    console.error('[Payment] getCheckoutStatus error:', err);
    return res.status(500).json({ error: 'Failed to retrieve session status' });
  }
}

export async function createCustomerPortalSession(req: Request, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sub = await db.select({ stripeCustomerId: subscriptionsTable.stripeCustomerId })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, req.user.id))
      .limit(1);

    const customerId = sub[0]?.stripeCustomerId;
    if (!customerId) {
      return res.status(404).json({ error: 'No billing account found. Please contact support.' });
    }

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontendUrl}/settings`,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error('[Payment] createCustomerPortalSession error:', err);
    return res.status(500).json({ error: 'Failed to create billing portal session' });
  }
}

export async function getPlans(req: Request, res: Response) {
  try {
    const plans = await db.select().from(plansTable).orderBy(plansTable.priceUsd);
    return res.status(200).json({ plans });
  } catch (err) {
    console.error('[Payment] getPlans error:', err);
    return res.status(500).json({ error: 'Failed to fetch plans' });
  }
}
