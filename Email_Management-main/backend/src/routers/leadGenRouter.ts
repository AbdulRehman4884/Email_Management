/**
 * Lead Engine routes.
 *   leadGenRouter        /api/lead-gen/*        (auth + requireLeadGen, mounted in index.ts)
 *   leadGenPublicRouter  /api/lead-gen/privacy  (no login: data subject requests)
 *   leadGenAdminRouter   /api/admin/lead-gen/*  (admin / super_admin)
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { isAdminRole, userMayUseLeadGen } from '../lib/leadgen/access.js';
import { leadGenMode } from '../lib/leadgen/config.js';
import {
  addToCampaign, cancelRunHandler, createSearch, deleteSchedule, deleteSearch, getCategories, getLeadHandler, getRun, getUsage,
  listLeadsHandler, listRuns, listSchedules, listSearches, rejectLeads, reviewLeads, runSearchNow, saveToCrm, updateSchedule,
  updateSearch, upsertSchedule,
} from '../controllers/leadGenController.js';
import {
  adminListPrivacy, adminOverview, adminProcessPrivacy, adminRefreshNow, adminUpdateSource, publicPrivacyRequest, publicPrivacyVerify,
} from '../controllers/leadGenAdminController.js';

/** Async handler errors -> 500 JSON (Express 5 forwards rejections; this keeps the message generic). */
const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error('[LeadGen API]', req.method, req.path, err);
    if (!res.headersSent) res.status(500).json({ error: 'Lead Finder error. Please try again.' });
    else next(err);
  }
};

/**
 * LEADGEN_ENABLED=off: 404 for everyone (the feature does not exist yet). admin: admins only.
 * on: admins + plans with lead_gen_enabled (403 PLAN_FEATURE_REQUIRED otherwise, like the CRM).
 */
export async function requireLeadGen(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const mode = leadGenMode();
  if (mode === 'off' || (mode === 'admin' && !isAdminRole(req.user.role))) return res.status(404).json({ error: 'Not found' });
  try {
    if (await userMayUseLeadGen(req.user.id)) return next();
    return res.status(403).json({
      error: 'Your current plan does not include this feature. Please upgrade to access it.',
      code: 'PLAN_FEATURE_REQUIRED',
      feature: 'leadGenEnabled',
    });
  } catch {
    return res.status(403).json({ error: 'Plan verification failed' });
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!isAdminRole(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

export const leadGenRouter = Router();
leadGenRouter.get('/usage', wrap(getUsage));
leadGenRouter.get('/categories', wrap(getCategories));
leadGenRouter.get('/searches', wrap(listSearches));
leadGenRouter.post('/searches', wrap(createSearch));
leadGenRouter.patch('/searches/:id', wrap(updateSearch));
leadGenRouter.delete('/searches/:id', wrap(deleteSearch));
leadGenRouter.post('/searches/:id/run', wrap(runSearchNow));
leadGenRouter.post('/searches/:id/schedule', wrap(upsertSchedule));
leadGenRouter.get('/schedules', wrap(listSchedules));
leadGenRouter.patch('/schedules/:id', wrap(updateSchedule));
leadGenRouter.delete('/schedules/:id', wrap(deleteSchedule));
leadGenRouter.get('/runs', wrap(listRuns));
leadGenRouter.get('/runs/:id', wrap(getRun));
leadGenRouter.post('/runs/:id/cancel', wrap(cancelRunHandler));
leadGenRouter.get('/leads', wrap(listLeadsHandler));
leadGenRouter.post('/leads/reject', wrap(rejectLeads));
leadGenRouter.post('/leads/review', wrap(reviewLeads));
leadGenRouter.post('/leads/save-to-crm', wrap(saveToCrm));
leadGenRouter.post('/leads/add-to-campaign', wrap(addToCampaign));
leadGenRouter.get('/leads/:id', wrap(getLeadHandler));

export const leadGenPublicRouter = Router();
leadGenPublicRouter.post('/lead-gen/privacy/requests', wrap(publicPrivacyRequest));
leadGenPublicRouter.get('/lead-gen/privacy/verify', wrap(publicPrivacyVerify));

export const leadGenAdminRouter = Router();
leadGenAdminRouter.get('/admin/lead-gen/overview', authMiddleware, requireAdmin, wrap(adminOverview));
leadGenAdminRouter.patch('/admin/lead-gen/sources/:id', authMiddleware, requireAdmin, wrap(adminUpdateSource));
leadGenAdminRouter.post('/admin/lead-gen/refresh', authMiddleware, requireAdmin, wrap(adminRefreshNow));
leadGenAdminRouter.get('/admin/lead-gen/privacy', authMiddleware, requireAdmin, wrap(adminListPrivacy));
leadGenAdminRouter.post('/admin/lead-gen/privacy/:id/process', authMiddleware, requireAdmin, wrap(adminProcessPrivacy));
