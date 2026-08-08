import type { Request, Response, NextFunction } from 'express';
import { getUserPlan } from '../lib/subscriptionService.js';

type PlanFeatureFlag = 'inboxEnabled' | 'followUpEnabled';

export function requirePlanFeature(feature: PlanFeatureFlag) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    // Admin and super_admin always have full access regardless of plan
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
      return next();
    }
    try {
      const plan = await getUserPlan(req.user.id);
      if (!plan[feature]) {
        return res.status(403).json({
          error: `Your current plan (${plan.name}) does not include this feature. Please upgrade to access it.`,
          code: 'PLAN_FEATURE_REQUIRED',
          feature,
          currentPlan: plan.code,
        });
      }
      next();
    } catch {
      return res.status(403).json({ error: 'Plan verification failed' });
    }
  };
}
