/**
 * Who may use the Lead Engine:
 *   LEADGEN_ENABLED=off    nobody (the API answers 404, the worker idles)
 *   LEADGEN_ENABLED=admin  admins and super admins only (release step)
 *   LEADGEN_ENABLED=on     admins + users whose plan has lead_gen_enabled
 */
import { dbPool } from '../db.js';
import { getUserPlan } from '../subscriptionService.js';
import { leadGenMode } from './config.js';
import type { Queryable } from './leadStore.js';

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

/** Same rule as requirePlanFeature('leadGenEnabled') plus the LEADGEN_ENABLED release switch. */
export async function userMayUseLeadGen(userId: number, q: Queryable = dbPool): Promise<boolean> {
  const mode = leadGenMode();
  if (mode === 'off') return false;
  const r = await q.query<{ role: string; is_active: boolean }>(`SELECT role, is_active FROM users WHERE id = $1`, [userId]);
  const user = r.rows[0];
  if (!user || !user.is_active) return false;
  if (isAdminRole(user.role)) return true;
  if (mode === 'admin') return false;
  return (await getUserPlan(userId)).leadGenEnabled === true;
}

/** The user's daily new-lead limit (plans.lead_gen_daily_limit; legacy users get the default). */
export async function dailyLeadLimit(userId: number): Promise<number> {
  return (await getUserPlan(userId)).leadGenDailyLimit;
}
