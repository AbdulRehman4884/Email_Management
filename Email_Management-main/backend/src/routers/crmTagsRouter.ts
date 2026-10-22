import { Router } from 'express';
import { requirePlanFeature } from '../middleware/requirePlanFeature.js';
import {
  listAllTags,
  createTag,
  updateTag,
  deleteTag,
  addCampaignTag,
  removeCampaignTag,
} from '../controllers/crmTagController.js';

/**
 * CRM step 5: tag CRUD and campaign tags. Mounted at /api (auth in index.ts).
 * The CRM plan check is on each route (not router.use), so other /api routes are never blocked by it.
 */
const router = Router();
const crm = requirePlanFeature('crmEnabled');

router.get('/tags', crm, listAllTags);
router.post('/tags', crm, createTag);
router.patch('/tags/:tagId', crm, updateTag);
router.delete('/tags/:tagId', crm, deleteTag);

router.post('/campaigns/:id/tags/:tagId', crm, addCampaignTag);
router.delete('/campaigns/:id/tags/:tagId', crm, removeCampaignTag);

export default router;
