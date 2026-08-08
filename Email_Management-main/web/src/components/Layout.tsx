import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Mail,
  MessageSquareReply,
  Inbox,
  Settings,
  BarChart3,
  Bot,
  Users,
  Menu,
  X,
  LogOut,
  Lock,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { BrandLogo } from './BrandLogo';
import { useToast } from './ui';
import { userApi } from '../lib/api';

interface LayoutProps {
  children: React.ReactNode;
}

const PLAN_BADGE_COLORS: Record<string, string> = {
  basic: 'bg-blue-100 text-blue-700',
  standard: 'bg-purple-100 text-purple-700',
  premium: 'bg-amber-100 text-amber-700',
};

export function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const toast = useToast();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  const plan = user?.plan;

  React.useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { unreadCount } = await userApi.getNotifications();
        if (cancelled || unreadCount === 0) return;
        toast.info(
          `You have ${unreadCount} sending-limit notification(s). Review your campaigns or SMTP daily limits.`
        );
        await userApi.markNotificationsReadAll();
      } catch {
        // non-blocking
      }
    };
    void poll();
    const t = window.setInterval(poll, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast stable enough for polling
  }, [user]);

  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard, locked: false },
    { name: 'Campaigns', href: '/campaigns', icon: Mail, locked: false },
    { name: 'Follow-up', href: '/follow-ups', icon: MessageSquareReply, locked: plan ? !plan.followUpEnabled : false },
    { name: 'Inbox', href: '/inbox', icon: Inbox, locked: plan ? !plan.inboxEnabled : false },
    { name: 'AI Agent', href: '/agent', icon: Bot, locked: false },
    { name: 'Analytics', href: '/analytics', icon: BarChart3, locked: false },
    { name: 'Settings', href: '/settings', icon: Settings, locked: false },
    ...(user?.role === 'super_admin'
      ? [{ name: 'User Management', href: '/admin/users', icon: Users, locked: false }]
      : []),
  ];

  const isActive = (href: string) => {
    if (href === '/') return location.pathname === '/';
    return location.pathname.startsWith(href);
  };

  const initials = (user?.name || user?.email || 'U').slice(0, 2).toUpperCase();
  const planBadgeClass = plan ? (PLAN_BADGE_COLORS[plan.code] ?? 'bg-gray-100 text-gray-600') : '';

  return (
    <div className="min-h-screen bg-gray-50">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 transform transition-transform duration-300 ease-in-out lg:translate-x-0 flex flex-col ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-16 px-5 border-b border-gray-200">
          <Link to="/" className="inline-flex">
            <BrandLogo iconClassName="w-9 h-9" textClassName="text-lg font-bold text-gray-900" />
          </Link>
          <button
            className="lg:hidden text-gray-500 hover:text-gray-900"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {navigation.map((item) => {
            const active = isActive(item.href);
            if (item.locked) {
              return (
                <Link
                  key={item.name}
                  to="/packages"
                  onClick={() => setSidebarOpen(false)}
                  title={`Upgrade to unlock ${item.name}`}
                  className="flex items-center px-3 py-2.5 text-sm font-medium rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-500 transition-colors duration-150 cursor-pointer"
                >
                  <item.icon className="w-5 h-5 mr-3 text-gray-300" />
                  {item.name}
                  <Lock className="w-3.5 h-3.5 ml-auto text-gray-300" />
                </Link>
              );
            }
            return (
              <Link
                key={item.name}
                to={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-colors duration-150 ${
                  active
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <item.icon className={`w-5 h-5 mr-3 ${active ? 'text-white' : 'text-gray-400'}`} />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="px-3 py-4 border-t border-gray-200">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-9 h-9 bg-gray-200 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-semibold text-gray-700">{initials}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900 truncate">{user?.name || 'User'}</p>
              <p className="text-xs text-gray-500 truncate">{user?.email || ''}</p>
              {plan && (
                <span className={`inline-block text-xs font-semibold px-1.5 py-0.5 rounded-full mt-0.5 ${planBadgeClass}`}>
                  {plan.name}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                logout();
                navigate('/login');
              }}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64 w-full max-w-full overflow-x-hidden">
        <header
          className="sticky top-0 z-30 bg-white border-b border-gray-200 lg:hidden"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          <div className="flex items-center h-14 px-4 gap-3">
            <button
              className="p-1.5 -ml-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <BrandLogo iconClassName="w-6 h-6" textClassName="text-sm font-semibold text-gray-900" />
          </div>
        </header>

        <main className="p-4 lg:p-8 w-full max-w-full">
          {children}
        </main>
      </div>
    </div>
  );
}
