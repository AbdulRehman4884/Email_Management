import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { listUsers, updateUser, deleteUser } from '../controllers/adminController.js';

const router = Router();

router.get('/admin/users', authMiddleware, requireSuperAdmin, listUsers);
router.patch('/admin/users/:id', authMiddleware, requireSuperAdmin, updateUser);
router.delete('/admin/users/:id', authMiddleware, requireSuperAdmin, deleteUser);

export default router;
