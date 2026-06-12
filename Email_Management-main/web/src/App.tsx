import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { RequireSuperAdmin } from './components/RequireSuperAdmin';
import { ToastProvider } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  Dashboard,
  Help,
  CampaignList,
  CreateCampaign,
  CampaignDetail,
  EditCampaign,
  Analytics,
  Inbox,
  Settings,
  Login,
  Signup,
  ForgotPassword,
  ResetPassword,
  AdminUsers,
  AgentChat,
  FollowUps,
  FollowUpSchedule,
} from './pages';
import { useAuthStore } from './store/authStore';
import { useThemeStore } from './store/themeStore';
import { authApi } from './lib/api';
import './index.css';

/**
 * Thin wrapper that reads the current pathname and passes it to ErrorBoundary
 * as the resetKey, so navigating to a new route automatically clears any
 * render error that crashed the previous page.
 */
function RouteErrorBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

export function App() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    hydrate();
    useThemeStore.getState().hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isHydrated || !token) return;
    authApi
      .getMe()
      .then(({ user }) => {
        const preferred = user.preferredTheme ?? 'light';
        useThemeStore.getState().setThemeFromServer(preferred as 'light' | 'dark' | 'system');
      })
      .catch(() => {});
  }, [isHydrated, token]);

  return (
    <ToastProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <RouteErrorBoundary>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/help" element={<Help />} />
                  <Route path="/campaigns" element={<CampaignList />} />
                  <Route path="/campaigns/create" element={<CreateCampaign />} />
                  <Route path="/campaigns/:id" element={<CampaignDetail />} />
                  <Route path="/campaigns/:id/edit" element={<EditCampaign />} />
                  <Route path="/follow-ups/schedule" element={<FollowUpSchedule />} />
                  <Route path="/follow-ups" element={<FollowUps />} />
                  <Route path="/analytics" element={<Analytics />} />
                  <Route path="/inbox" element={<Inbox />} />
                  <Route path="/agent" element={<AgentChat />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route
                    path="/admin/users"
                    element={
                      <RequireSuperAdmin>
                        <AdminUsers />
                      </RequireSuperAdmin>
                    }
                  />
                </Routes>
                </RouteErrorBoundary>
              </Layout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </ToastProvider>
  );
}

export default App;
