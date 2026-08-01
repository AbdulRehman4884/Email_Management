import { db } from './db.js';
import { plansTable, subscriptionsTable } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface PlanLimits {
  code: string;
  name: string;
  smtpLimit: number;
  dailyEmailLimit: number;
  inboxEnabled: boolean;
  followUpEnabled: boolean;
  stripePriceId: string | null;
  priceUsd: string;
}

// Users who existed before the subscription system was introduced have no subscription row.
// Give them full legacy access so existing functionality is not broken.
const FALLBACK_PLAN: PlanLimits = {
  code: 'legacy',
  name: 'Legacy',
  smtpLimit: 5,
  dailyEmailLimit: 50,
  inboxEnabled: true,
  followUpEnabled: true,
  stripePriceId: null,
  priceUsd: '0',
};

export async function getUserPlan(userId: number): Promise<PlanLimits> {
  const rows = await db
    .select({
      code: plansTable.code,
      name: plansTable.name,
      smtpLimit: plansTable.smtpLimit,
      dailyEmailLimit: plansTable.dailyEmailLimit,
      inboxEnabled: plansTable.inboxEnabled,
      followUpEnabled: plansTable.followUpEnabled,
      stripePriceId: plansTable.stripePriceId,
      priceUsd: plansTable.priceUsd,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planCode, plansTable.code))
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  return (rows[0] as PlanLimits) ?? FALLBACK_PLAN;
}

export async function getUserPlanOrThrow(userId: number): Promise<PlanLimits> {
  const rows = await db
    .select({
      code: plansTable.code,
      name: plansTable.name,
      smtpLimit: plansTable.smtpLimit,
      dailyEmailLimit: plansTable.dailyEmailLimit,
      inboxEnabled: plansTable.inboxEnabled,
      followUpEnabled: plansTable.followUpEnabled,
      stripePriceId: plansTable.stripePriceId,
      priceUsd: plansTable.priceUsd,
      status: subscriptionsTable.status,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planCode, plansTable.code))
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!rows[0] || rows[0].status !== 'active') {
    throw Object.assign(new Error('No active subscription'), { statusCode: 403 });
  }
  return rows[0] as PlanLimits;
}

export async function getUserSubscription(userId: number) {
  const rows = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}
