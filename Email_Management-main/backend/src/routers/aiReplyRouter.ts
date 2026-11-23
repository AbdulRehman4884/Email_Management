import { Router } from 'express';
import {
  createThreadDraftHandler,
  discardDraftHandler,
  getSettingsHandler,
  getThreadDraftHandler,
  listDraftsHandler,
  saveSettingsHandler,
  suggestionHandler,
  useDraftHandler,
} from '../controllers/aiReplyController.js';

/** AI reply agent (mounted at /api with authMiddleware + the Inbox plan check). */
const router = Router();

router.get('/ai-reply/settings', getSettingsHandler);
router.put('/ai-reply/settings', saveSettingsHandler);
router.get('/ai-reply/drafts', listDraftsHandler);
router.get('/ai-reply/threads/:threadRootId/draft', getThreadDraftHandler);
router.post('/ai-reply/threads/:threadRootId/draft', createThreadDraftHandler);
router.post('/ai-reply/drafts/:id/discard', discardDraftHandler);
router.post('/ai-reply/drafts/:id/use', useDraftHandler);
router.get('/replies/:id/suggestion', suggestionHandler);

export default router;
