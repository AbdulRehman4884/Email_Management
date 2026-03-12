import { Router } from 'express';
import { listRepliesHandler, getReplyByIdHandler } from '../controllers/repliesController.js';

const router = Router();
router.get('/replies', listRepliesHandler);
router.get('/replies/:id', getReplyByIdHandler);
export default router;
