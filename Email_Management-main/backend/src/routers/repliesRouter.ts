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
// Ids above the PostgreSQL integer limit cannot exist; answer 404 instead of a database error (500).
// Other invalid ids are still rejected with 400 by the handlers.
for (const name of ['id', 'threadRootId']) {
  router.param(name, (req, res, next, value) => {
    if (parseInt(String(value), 10) > 2147483647) return res.status(404).json({ error: 'Not found' });
    next();
  });
}
router.get('/replies/thread-root', getThreadRootForRecipientHandler);
router.get('/replies/by-thread/:threadRootId', getReplyThreadByRootHandler);
router.get('/replies', listRepliesHandler);
router.get('/replies/:id', getReplyByIdHandler);
router.post('/replies/:id/send', sendReplyHandler);
router.patch('/replies/:id/label', updateReplyLabelHandler);
export default router;
