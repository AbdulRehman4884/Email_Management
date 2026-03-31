import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { RequireSuperAdmin } from './components/RequireSuperAdmin';
import {
  Dashboard,
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
} from './pages';
import { useAuthStore } from './store/authStore';
import { useThemeStore } from './store/themeStore';
import { authApi } from './lib/api';
import './index.css';

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
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/campaigns" element={<CampaignList />} />
                  <Route path="/campaigns/create" element={<CreateCampaign />} />
                  <Route path="/campaigns/:id" element={<CampaignDetail />} />
                  <Route path="/campaigns/:id/edit" element={<EditCampaign />} />
                  <Route path="/analytics" element={<Analytics />} />
                  <Route path="/inbox" element={<Inbox />} />
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
              </Layout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
