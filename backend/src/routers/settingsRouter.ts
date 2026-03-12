import { Router } from 'express';
import { getSmtpSettingsHandler, putSmtpSettingsHandler } from '../controllers/settingsController.js';

const router = Router();
router.get('/settings/smtp', getSmtpSettingsHandler);
router.put('/settings/smtp', putSmtpSettingsHandler);
export default router;
