import { Router } from 'express';
import { unsubscribeHandler } from '../controllers/unsubscribeController.js';

const router = Router();
router.get('/unsubscribe/:token', unsubscribeHandler);
router.get('/unsubscribe', unsubscribeHandler);
router.post('/unsubscribe', unsubscribeHandler);
export default router;
