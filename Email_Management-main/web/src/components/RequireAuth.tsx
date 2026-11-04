import React, { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { loginUrlFor } from '../lib/authRedirect';

interface RequireAuthProps {
  children: React.ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { token, isHydrated, hydrate } = useAuthStore();
  const location = useLocation();

  useEffect(() => {
    if (!isHydrated) {
      hydrate();
    }
  }, [isHydrated, hydrate]);

  if (!isHydrated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-gray-400 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!token) {
    // F-12: keep the requested page in the URL so sign-in can return to it (survives a refresh).
    return <Navigate to={loginUrlFor(location.pathname + location.search)} state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
