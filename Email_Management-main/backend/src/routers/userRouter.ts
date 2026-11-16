import { Router } from 'express';
import {
  getNotificationsHandler,
  postNotificationsReadAllHandler,
  postNotificationReadHandler,
  getSmtpQuotaSummaryHandler,
} from '../controllers/userNotificationsController.js';

const router = Router();

router.get('/user/notifications', getNotificationsHandler);
router.post('/user/notifications/read-all', postNotificationsReadAllHandler);
router.post('/user/notifications/:id/read', postNotificationReadHandler);
router.get('/user/smtp-quota', getSmtpQuotaSummaryHandler);

export default router;
