import { Router } from 'express';
import {
  signup,
  login,
  me,
  updatePreferredTheme,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
  refreshSession,
  logoutSession,
  upgradeLegacySession,
} from '../controllers/authController.js';
import { authMiddleware, bearerOnlyAuth } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/auth/signup', signup);
router.post('/auth/login', login);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/verify-reset-otp', verifyResetOtp);
router.post('/auth/reset-password', resetPassword);
// N-07 / N-17: cookie sessions. refresh/logout use the mf_rt cookie (origin-checked); session = one-time upgrade
// of an old localStorage token (Bearer only).
router.post('/auth/refresh', refreshSession);
router.post('/auth/logout', logoutSession);
router.post('/auth/session', bearerOnlyAuth, upgradeLegacySession);
router.get('/auth/me', authMiddleware, me);
router.patch('/auth/me', authMiddleware, updatePreferredTheme);

export default router;
