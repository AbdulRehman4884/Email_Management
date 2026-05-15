import { Router } from 'express';
import {
  listRepliesHandler,
  getReplyByIdHandler,
  sendReplyHandler,
  getThreadRootForRecipientHandler,
  getReplyThreadByRootHandler,
} from '../controllers/repliesController.js';

const router = Router();
router.get('/replies/thread-root', getThreadRootForRecipientHandler);
router.get('/replies/by-thread/:threadRootId', getReplyThreadByRootHandler);
router.get('/replies', listRepliesHandler);
router.get('/replies/:id', getReplyByIdHandler);
router.post('/replies/:id/send', sendReplyHandler);
export default router;
