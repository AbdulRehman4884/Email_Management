import React, { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, LoadingSpinner } from '../components/ui';
import { adminApi, type AdminUser } from '../lib/api';
import { useAuthStore } from '../store/authStore';

export function AdminUsers() {
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getUsers({ limit: 100 });
      setUsers(res.users);
      setTotal(res.total);
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e && (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(msg || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleRoleChange = async (id: number, role: string) => {
    if (id === currentUser?.id) return;
    setUpdatingId(id);
    try {
      await adminApi.updateUser(id, { role });
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, role } : u)));
    } catch {
      setError('Failed to update user');
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (id === currentUser?.id) return;
    if (!window.confirm('Are you sure you want to delete this user?')) return;
    setDeletingId(id);
    try {
      await adminApi.deleteUser(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
      setTotal((t) => t - 1);
    } catch {
      setError('Failed to delete user');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading && users.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Manage Users</h1>
        <p className="text-gray-400 mt-1">View and manage all users and roles.</p>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      <Card className="border border-gray-800">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">User</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Email</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Role</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Status</th>
                  <th className="text-right py-3 px-4 text-sm font-medium text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === currentUser?.id;
                  return (
                    <tr key={u.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="py-3 px-4 text-white font-medium">{u.name}</td>
                      <td className="py-3 px-4 text-gray-300">{u.email}</td>
                      <td className="py-3 px-4">
                        <select
                          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:ring-2 focus:ring-indigo-500"
                          value={u.role}
                          disabled={isSelf || updatingId === u.id}
                          onChange={(e) => handleRoleChange(u.id, e.target.value)}
                        >
                          <option value="user">User</option>
                          <option value="super_admin">Super Admin</option>
                        </select>
                        {updatingId === u.id && (
                          <Loader2 className="inline w-4 h-4 ml-2 animate-spin text-indigo-400" />
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            u.isActive ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {u.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!isSelf && (
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={deletingId === u.id}
                            onClick={() => handleDelete(u.id)}
                          >
                            {deletingId === u.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="p-4 border-t border-gray-800 text-sm text-gray-400">
            Total: {total} user{total !== 1 ? 's' : ''}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
