import { Router } from 'express';
import {
  listRepliesHandler,
  getReplyByIdHandler,
  sendReplyHandler,
  getThreadRootForRecipientHandler,
  getReplyThreadByRootHandler,
  updateReplyLabelHandler,
} from '../controllers/repliesController.js';

const router = Router();
router.get('/replies/thread-root', getThreadRootForRecipientHandler);
router.get('/replies/by-thread/:threadRootId', getReplyThreadByRootHandler);
router.get('/replies', listRepliesHandler);
router.get('/replies/:id', getReplyByIdHandler);
router.post('/replies/:id/send', sendReplyHandler);
router.patch('/replies/:id/label', updateReplyLabelHandler);
export default router;
