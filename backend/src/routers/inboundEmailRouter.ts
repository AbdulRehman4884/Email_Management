import { Router } from 'express';
import { inboundEmailHandler } from '../controllers/inboundEmailController.js';

const router = Router();
router.post('/webhooks/inbound-email', inboundEmailHandler);
export default router;
