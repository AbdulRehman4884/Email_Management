import { Router } from 'express';
import { trackOpenHandler } from '../controllers/trackController.js';

const router = Router();
router.get('/track/open', trackOpenHandler);
export default router;
