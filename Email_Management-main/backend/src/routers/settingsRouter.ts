import { Router } from 'express';
import {
  getSmtpSettingsHandler,
  listSmtpProfilesHandler,
  postSmtpProfileHandler,
  putSmtpProfileHandler,
  putSmtpSettingsHandler,
  deleteSmtpProfileHandler,
  listAliasesHandler,
  postAliasHandler,
  putAliasHandler,
  deleteAliasHandler,
} from '../controllers/settingsController.js';

const router = Router();
router.get('/settings/smtp/list', listSmtpProfilesHandler);
router.post('/settings/smtp', postSmtpProfileHandler);
// Sending aliases of a profile (per-alias daily quota). Specific routes before /:id so they match first.
router.get('/settings/smtp/:id/aliases', listAliasesHandler);
router.post('/settings/smtp/:id/aliases', postAliasHandler);
router.put('/settings/smtp/:id/aliases/:aliasId', putAliasHandler);
router.delete('/settings/smtp/:id/aliases/:aliasId', deleteAliasHandler);
router.put('/settings/smtp/:id', putSmtpProfileHandler);
router.delete('/settings/smtp/:id', deleteSmtpProfileHandler);
router.get('/settings/smtp', getSmtpSettingsHandler);
router.put('/settings/smtp', putSmtpSettingsHandler);
export default router;
