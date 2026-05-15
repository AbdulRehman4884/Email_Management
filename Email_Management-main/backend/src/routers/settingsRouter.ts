import { Router } from 'express';
import {
  getSmtpSettingsHandler,
  listSmtpProfilesHandler,
  postSmtpProfileHandler,
  putSmtpProfileHandler,
  putSmtpSettingsHandler,
  deleteSmtpProfileHandler,
} from '../controllers/settingsController.js';

const router = Router();
router.get('/settings/smtp/list', listSmtpProfilesHandler);
router.post('/settings/smtp', postSmtpProfileHandler);
router.put('/settings/smtp/:id', putSmtpProfileHandler);
router.delete('/settings/smtp/:id', deleteSmtpProfileHandler);
router.get('/settings/smtp', getSmtpSettingsHandler);
router.put('/settings/smtp', putSmtpSettingsHandler);
export default router;
