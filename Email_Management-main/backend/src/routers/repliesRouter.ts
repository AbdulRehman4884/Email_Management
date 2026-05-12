import { Router } from 'express';
import {
  listRepliesHandler,
  getReplyByIdHandler,
  sendReplyHandler,
  replyIntelligenceSummaryHandler,
  hotLeadsHandler,
  meetingReadyLeadsHandler,
  getReplySuggestionHandler,
  markReplyReviewHandler,
} from '../controllers/repliesController.js';

const router = Router();
router.get('/replies', listRepliesHandler);
router.get('/replies/intelligence/summary', replyIntelligenceSummaryHandler);
router.get('/replies/hot-leads', hotLeadsHandler);
router.get('/replies/meeting-ready', meetingReadyLeadsHandler);
router.get('/replies/:id', getReplyByIdHandler);
router.get('/replies/:id/suggestion', getReplySuggestionHandler);
router.post('/replies/:id/review', markReplyReviewHandler);
router.post('/replies/:id/send', sendReplyHandler);
export default router;
