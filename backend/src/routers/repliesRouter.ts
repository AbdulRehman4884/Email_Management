import { Router } from 'express';
import { listRepliesHandler, getReplyByIdHandler, sendReplyHandler } from '../controllers/repliesController.js';

const router = Router();
router.get('/replies', listRepliesHandler);
router.get('/replies/:id', getReplyByIdHandler);
router.post('/replies/:id/send', sendReplyHandler);
export default router;
