import { Router } from 'express';
import { signup, login, me, updatePreferredTheme } from '../controllers/authController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

router.post('/auth/signup', signup);
router.post('/auth/login', login);
router.get('/auth/me', authMiddleware, me);
router.patch('/auth/me', authMiddleware, updatePreferredTheme);

export default router;
