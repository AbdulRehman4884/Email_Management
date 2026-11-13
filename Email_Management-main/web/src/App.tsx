import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { RequireSuperAdmin } from './components/RequireSuperAdmin';
import { RequireAdmin } from './components/RequireAdmin';
import { ToastProvider } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';

// N-02: entry pages load with the app; every other page is its own chunk, loaded when first opened.
// (Imported from their own files: importing from './pages' would pull every page into the main bundle.)
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { Packages } from './pages/Packages';
import { CheckoutSuccess } from './pages/CheckoutSuccess';
import { PageLoader } from './components/ui';

const Help = lazy(() => import('./pages/Help').then((m) => ({ default: m.Help })));
const CampaignList = lazy(() => import('./pages/CampaignList').then((m) => ({ default: m.CampaignList })));
const CreateCampaign = lazy(() => import('./pages/CreateCampaign').then((m) => ({ default: m.CreateCampaign })));
const CampaignDetail = lazy(() => import('./pages/CampaignDetail').then((m) => ({ default: m.CampaignDetail })));
const EditCampaign = lazy(() => import('./pages/EditCampaign').then((m) => ({ default: m.EditCampaign })));
const Analytics = lazy(() => import('./pages/Analytics').then((m) => ({ default: m.Analytics })));
const Inbox = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.Inbox })));
const PipelineBuilder = lazy(() => import('./pages/PipelineBuilder').then((m) => ({ default: m.PipelineBuilder })));
const CrmLeads = lazy(() => import('./pages/CrmLeads').then((m) => ({ default: m.CrmLeads })));
const Crm = lazy(() => import('./pages/Crm').then((m) => ({ default: m.Crm })));
const CrmForms = lazy(() => import('./pages/CrmForms').then((m) => ({ default: m.CrmForms })));
const CrmFormBuilder = lazy(() => import('./pages/CrmFormBuilder').then((m) => ({ default: m.CrmFormBuilder })));
const CrmAutomations = lazy(() => import('./pages/CrmAutomations').then((m) => ({ default: m.CrmAutomations })));
const CrmAutomationBuilder = lazy(() => import('./pages/CrmAutomationBuilder').then((m) => ({ default: m.CrmAutomationBuilder })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const AdminUsers = lazy(() => import('./pages/AdminUsers').then((m) => ({ default: m.AdminUsers })));
const AgentChat = lazy(() => import('./pages/AgentChat').then((m) => ({ default: m.AgentChat })));
const FollowUps = lazy(() => import('./pages/FollowUps').then((m) => ({ default: m.FollowUps })));
const FollowUpSchedule = lazy(() => import('./pages/FollowUpSchedule').then((m) => ({ default: m.FollowUpSchedule })));
const ScriptFiles = lazy(() => import('./pages/ScriptFiles').then((m) => ({ default: m.ScriptFiles })));
const ScriptFileCompanies = lazy(() => import('./pages/ScriptFileCompanies').then((m) => ({ default: m.ScriptFileCompanies })));
const CompanyScripts = lazy(() => import('./pages/CompanyScripts').then((m) => ({ default: m.CompanyScripts })));

const LeadFinder = lazy(() => import('./pages/LeadFinder').then((m) => ({ default: m.LeadFinder })));
const LeadSchedules = lazy(() => import('./pages/LeadSchedules').then((m) => ({ default: m.LeadSchedules })));
const AdminLeadGen = lazy(() => import('./pages/AdminLeadGen').then((m) => ({ default: m.AdminLeadGen })));

import { useAuthStore } from './store/authStore';
import { useThemeStore } from './store/themeStore';
import { authApi } from './lib/api';
import { NotFound } from './pages/NotFound';
import './index.css';

/** N-13: a page title per route ("Campaigns · MailFlow") instead of the same title everywhere. */
const PAGE_TITLES: Array<[RegExp, string]> = [
  [/^\/$/, 'Dashboard'],
  [/^\/login/, 'Sign in'],
  [/^\/packages/, 'Pricing'],
  [/^\/checkout/, 'Checkout'],
  [/^\/forgot-password/, 'Forgot password'],
  [/^\/reset-password/, 'Reset password'],
  [/^\/help/, 'Help'],
  [/^\/campaigns\/create/, 'New campaign'],
  [/^\/campaigns\/[^/]+\/edit/, 'Edit campaign'],
  [/^\/campaigns\/[^/]+/, 'Campaign'],
  [/^\/campaigns/, 'Campaigns'],
  [/^\/follow-ups\/schedule/, 'Schedule follow-up'],
  [/^\/follow-ups/, 'Follow-ups'],
  [/^\/analytics/, 'Analytics'],
  [/^\/inbox/, 'Inbox'],
  [/^\/crm\/pipelines/, 'CRM pipelines'],
  [/^\/crm\/forms/, 'Forms'],
  [/^\/crm\/automations/, 'Automations'],
  [/^\/crm/, 'CRM'],
  [/^\/agent/, 'AI Agent'],
  [/^\/settings/, 'Settings'],
  [/^\/admin\/users/, 'User management'],
];
function DocumentTitle() {
  const { pathname } = useLocation();
  useEffect(() => {
    const match = PAGE_TITLES.find(([re]) => re.test(pathname));
    document.title = match ? `${match[1]} · MailFlow` : 'Page not found · MailFlow';
  }, [pathname]);
  return null;
}

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

  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    if (!isHydrated || !token) return;
    authApi
      .getMe()
      .then(({ user }) => {
        // Refresh user in store (includes updated plan info)
        setAuth(user, token);
        const preferred = user.preferredTheme ?? 'light';
        useThemeStore.getState().setThemeFromServer(preferred as 'light' | 'dark' | 'system');
      })
      .catch(() => {});
  }, [isHydrated, token, setAuth]);

  return (
    <ToastProvider>
    <BrowserRouter>
      <DocumentTitle />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Navigate to="/packages" replace />} />
        <Route path="/packages" element={<Packages />} />
        <Route path="/checkout/success" element={<CheckoutSuccess />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <RouteErrorBoundary>
                <Suspense fallback={<PageLoader />}>
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
                  <Route path="/crm/pipelines" element={<PipelineBuilder />} />
                  <Route path="/crm/leads" element={<CrmLeads />} />
                  <Route path="/crm" element={<Crm />} />

                  <Route path="/lead-finder" element={<LeadFinder />} />
                  <Route path="/lead-finder/schedules" element={<LeadSchedules />} />
                  <Route
                    path="/admin/lead-gen"
                    element={
                      <RequireAdmin>
                        <AdminLeadGen />
                      </RequireAdmin>
                    }
                  />

                  <Route path="/crm/forms" element={<CrmForms />} />
                  <Route path="/crm/forms/:id" element={<CrmFormBuilder />} />
                  <Route path="/crm/automations" element={<CrmAutomations />} />
                  <Route path="/crm/automations/:id" element={<CrmAutomationBuilder />} />

                  <Route path="/agent" element={<AgentChat />} />
                  <Route path="/scripts" element={<ScriptFiles />} />
                  <Route path="/scripts/files/:fileId" element={<ScriptFileCompanies />} />
                  <Route path="/scripts/companies/:companyId" element={<CompanyScripts />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route
                    path="/admin/users"
                    element={
                      <RequireSuperAdmin>
                        <AdminUsers />
                      </RequireSuperAdmin>
                    }
                  />
                  {/* F-11: unknown URLs inside the app get a real "not found" page. */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
                </Suspense>
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
