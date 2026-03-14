import type { Request, Response, NextFunction } from 'express';

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
