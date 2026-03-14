import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

interface RequireSuperAdminProps {
  children: React.ReactNode;
}

export function RequireSuperAdmin({ children }: RequireSuperAdminProps) {
  const user = useAuthStore((s) => s.user);

  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role !== 'super_admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
