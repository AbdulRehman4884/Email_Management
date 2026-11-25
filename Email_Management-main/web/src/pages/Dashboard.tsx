import React, { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { campaignRecipientCount } from '../lib/apiFields';
import { Link } from 'react-router-dom';
import {
  Mail,
  Send,
  CheckCircle,
  ArrowRight,
  BarChart3,
  BookOpen,
  Activity,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { buttonClassName, Card, CardContent, StatusBadge, PageLoader } from '../components/ui';
import { useReportingScope } from '../lib/reportingScope';
import { ScopeNotice } from '../components/ScopeNotice';
import { dashboardApi } from '../lib/api';

/** Premium stat tile (UI only) — label, big number, soft circular accent icon. */
function StatTile({
  title,
  value,
  sub,
  icon: Icon,
  accentBg,
  accentFg,
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon: LucideIcon;
  accentBg: string;
  accentFg: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{title}</p>
        <div className={`w-9 h-9 rounded-full flex items-center justify-center ${accentBg}`}>
          <Icon className={`w-4 h-4 ${accentFg}`} />
        </div>
      </div>
      <p className="mt-3 text-3xl font-bold text-gray-900 tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

export function Dashboard() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();
  const { scopeSmtpProfileId, scopedCampaigns } = useReportingScope();
  const [totalEmailsSent, setTotalEmailsSent] = useState<number | null>(null);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  useEffect(() => {
    let alive = true;
    // GEN (sent count) / N-26: the server applies the SMTP scope (an empty scope counts nothing);
    // campaign ids are no longer sent in the URL.
    const params = { scopeSmtpId: scopeSmtpProfileId };
    setTotalEmailsSent(null);
    dashboardApi.getStats(params).then((data) => {
      if (alive) setTotalEmailsSent(data.totalEmailsSent);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [scopeSmtpProfileId]);

  const totalCampaigns = scopedCampaigns.length;
  const activeCampaigns = scopedCampaigns.filter(
    (c) => c.status === 'in_progress' || c.status === 'scheduled'
  ).length;
  const completedCampaigns = scopedCampaigns.filter((c) => c.status === 'completed').length;
  const draftCampaigns = scopedCampaigns.filter((c) => c.status === 'draft').length;
  const pausedCampaigns = scopedCampaigns.filter((c) => c.status === 'paused').length;
  // GEN (sent count): never show the uploaded-recipient total as "sent" while the real count loads.
  const emailsSentDisplay = totalEmailsSent != null ? totalEmailsSent.toLocaleString() : '…';

  // Real campaign-status breakdown for the "At a glance" panel (derived client-side, no new data).
  const breakdown = [
    { label: 'Active', count: activeCampaigns, bar: 'bg-green-500' },
    { label: 'Completed', count: completedCampaigns, bar: 'bg-emerald-500' },
    { label: 'Draft', count: draftCampaigns, bar: 'bg-gray-400' },
    { label: 'Paused', count: pausedCampaigns, bar: 'bg-purple-500' },
  ];

  const recentCampaigns = [...scopedCampaigns]
    .sort((a, b) => {
      const tb = new Date(b.updatedAt || b.createdAt).getTime();
      const ta = new Date(a.updatedAt || a.createdAt).getTime();
      return tb - ta;
    })
    .slice(0, 5);

  if (isLoading) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 mt-1">Campaign performance at a glance.</p>
        <ScopeNotice className="mt-1" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatTile
          title="Total Campaigns"
          value={totalCampaigns}
          sub="all campaigns"
          icon={Send}
          accentBg="bg-indigo-50"
          accentFg="text-indigo-500"
        />
        <StatTile
          title="Active Campaigns"
          value={activeCampaigns}
          sub="running now"
          icon={Activity}
          accentBg="bg-green-50"
          accentFg="text-green-500"
        />
        <StatTile
          title="Emails Sent"
          value={emailsSentDisplay}
          sub="delivered"
          icon={Mail}
          accentBg="bg-blue-50"
          accentFg="text-blue-500"
        />
        <StatTile
          title="Completed"
          value={completedCampaigns}
          sub="finished"
          icon={CheckCircle}
          accentBg="bg-emerald-50"
          accentFg="text-emerald-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-gray-900">Recent campaigns</h2>
              <Link
                to="/campaigns"
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center font-medium"
              >
                View all
                <ArrowRight className="w-3.5 h-3.5 ml-1" />
              </Link>
            </div>

            {recentCampaigns.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 text-left">
                      <th className="py-2.5 px-3 text-xs font-medium text-gray-500">Campaign</th>
                      <th className="py-2.5 px-3 text-xs font-medium text-gray-500">Recipients</th>
                      <th className="py-2.5 px-3 text-xs font-medium text-gray-500">Status</th>
                      <th className="py-2.5 px-3 text-xs font-medium text-gray-500">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentCampaigns.map((campaign) => (
                      <tr
                        key={campaign.id}
                        className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                      >
                        <td className="py-3 px-3">
                          <Link
                            to={`/campaigns/${campaign.id}`}
                            className="font-medium text-gray-900 text-sm hover:text-black"
                          >
                            {campaign.name}
                          </Link>
                        </td>
                        <td className="py-3 px-3 text-sm text-gray-700">
                          {(campaignRecipientCount(campaign) || 0).toLocaleString()}
                        </td>
                        <td className="py-3 px-3">
                          <StatusBadge status={campaign.status} />
                        </td>
                        <td className="py-3 px-3 text-sm text-gray-500">
                          {fmtDate(campaign.updatedAt || campaign.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8">
                <Mail className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm mb-3">No campaigns yet</p>
                <Link to="/campaigns/create" className={buttonClassName('primary', 'sm')}>
                  Create your first campaign
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-4">At a glance</h2>
              {totalCampaigns > 0 ? (
                <div className="space-y-3">
                  {breakdown.map((row) => {
                    const pct = totalCampaigns > 0 ? Math.round((row.count / totalCampaigns) * 100) : 0;
                    return (
                      <div key={row.label}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-gray-600">{row.label}</span>
                          <span className="font-semibold text-gray-900 tabular-nums">{row.count}</span>
                        </div>
                        <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${row.bar}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No campaigns to summarize yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-4">Quick actions</h2>
              <div className="space-y-2">
                {/* N-20: one focusable element (was a <button> inside an <a>). */}
                <Link to="/campaigns/create" className={buttonClassName('primary', 'md', 'w-full justify-start')}>
                  <Mail className="w-4 h-4 mr-2" />
                  Create campaign
                </Link>
                <Link
                  to="/campaigns"
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                >
                  <Send className="w-4 h-4 mr-2 text-gray-400" />
                  View campaigns
                </Link>
                <Link
                  to="/analytics"
                  className="flex items-center px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                >
                  <BarChart3 className="w-4 h-4 mr-2 text-gray-400" />
                  Analytics
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <div className="flex items-start gap-3">
                <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
                  <BookOpen className="w-5 h-5 text-gray-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">Help & Docs</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Learn how to create effective campaigns, manage recipients, and track performance.
                  </p>
                  <Link
                    to="/help"
                    className="text-xs text-blue-600 font-medium mt-2 inline-block hover:text-blue-700"
                  >
                    Read the guide
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
