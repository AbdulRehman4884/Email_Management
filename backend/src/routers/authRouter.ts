import { Router } from 'express';
import {
  signup,
  login,
  me,
  updatePreferredTheme,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
} from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/auth/signup', signup);
router.post('/auth/login', login);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/verify-reset-otp', verifyResetOtp);
router.post('/auth/reset-password', resetPassword);
router.get('/auth/me', authMiddleware, me);
router.patch('/auth/me', authMiddleware, updatePreferredTheme);

export default router;
