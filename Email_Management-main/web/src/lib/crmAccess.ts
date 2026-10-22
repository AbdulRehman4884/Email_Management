import { useAuthStore } from '../store/authStore';

/**
 * True when the logged-in user may use CRM features (plans.crm_enabled), same rule as the backend:
 * admins always, users without a plan (legacy) always, others when their plan has CRM.
 * Pages use it to hide CRM parts (tags, label bar) instead of showing errors.
 */
export function useCrmEnabled(): boolean {
  const user = useAuthStore((s) => s.user);
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'super_admin') return true;
  return user.plan ? user.plan.crmEnabled !== false : true;
}
