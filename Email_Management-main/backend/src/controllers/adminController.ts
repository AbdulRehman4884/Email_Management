import type { Request, Response } from 'express';
import { db } from '../lib/db.js';
import { usersTable } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

export async function listUsers(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const offset = (page - 1) * limit;

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .orderBy(usersTable.createdAt)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable);
    const total = countResult[0]?.count ?? 0;

    res.status(200).json({ users, total });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
}

export async function updateUser(req: Request, res: Response) {
  try {
    const currentUserId = req.user?.id;
    if (!currentUserId) return res.status(401).json({ error: 'Unauthorized' });
    const targetId = parseInt(String(req.params.id ?? ''), 10);
    if (isNaN(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (targetId === currentUserId) {
      return res.status(400).json({ error: 'Cannot modify your own role or status' });
    }
    const role = typeof req.body.role === 'string' ? req.body.role : undefined;
    const isActive = req.body.isActive;
    const updates: { role?: string; isActive?: boolean } = {};
    if (role !== undefined) {
      if (role !== 'user' && role !== 'super_admin') {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.role = role;
    }
    if (isActive !== undefined) {
      updates.isActive = Boolean(isActive);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid updates provided' });
    }
    const [updated] = await db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, targetId))
      .returning({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, isActive: usersTable.isActive });
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(200).json(updated);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
}

export async function deleteUser(req: Request, res: Response) {
  try {
    const currentUserId = req.user?.id;
    if (!currentUserId) return res.status(401).json({ error: 'Unauthorized' });
    const targetId = parseInt(String(req.params.id ?? ''), 10);
    if (isNaN(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (targetId === currentUserId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const [deleted] = await db.delete(usersTable).where(eq(usersTable.id, targetId)).returning({ id: usersTable.id });
    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(200).json({ message: 'User deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
}
