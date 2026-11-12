import React, { useEffect, useMemo, useState } from 'react';
import { campaignRecipientCount } from '../lib/apiFields';
import {
  Send, AlertTriangle, AlertCircle, Mail, MailOpen, MessageCircle, UserMinus,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { dashboardApi } from '../lib/api';
import type { DashboardStats } from '../types';
import { Card, CardContent, StatsCard, PageLoader } from '../components/ui';
import { FollowUpFilters } from '../components/FollowUpFilters';
import { ScopeNotice } from '../components/ScopeNotice';
import { BestSendTimeCard } from '../components/BestSendTimeCard';
import {
  useReportingScope,
} from '../lib/reportingScope';

type TimePoint = { day: string; sent: number; delivered: number; opened: number; clicked: number };

/** Rate vs list size; caps at 100% if counts ever disagree. */
function ratePctString(numerator: number, listSize: number): string {
  if (listSize <= 0) return '0';
  return Math.min(100, (numerator / listSize) * 100).toFixed(1);
}

function funnelPct(numerator: number, listSize: number): number {
  if (listSize <= 0) return 0;
  return Math.min(100, Math.round((numerator / listSize) * 100));
}

/** F-23: smallest "nice" axis maximum (4 whole-number ticks of 1, 2, 2.5 or 5 x 10^n) that fits the data. */
function niceAxisMax(maxValue: number): number {
  if (maxValue <= 4) return 4;
  const raw = maxValue / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((st) => st >= raw && Number.isInteger(st)) ?? 10 * pow;
  return step * 4;
}

/** F-35: status + colour for a rate against two thresholds; "No data" when nothing was sent. */
function insightLevel(hasData: boolean, value: number, warnAt: number, badAt: number, labels: [string, string, string]) {
  if (!hasData) return { status: 'No data', color: 'bg-gray-100 text-gray-500' };
  if (value < warnAt) return { status: labels[0], color: 'bg-green-100 text-green-700' };
  if (value < badAt) return { status: labels[1], color: 'bg-yellow-100 text-yellow-700' };
  return { status: labels[2], color: 'bg-red-100 text-red-700' };
}

export function Analytics() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();
  const { scopeSmtpProfileId, scopedCampaigns, scopedCampaignIds } = useReportingScope();
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [chartView, setChartView] = useState<'monthly' | 'yearly'>('monthly');
  const [selectedAnalyticsCampaignIds, setSelectedAnalyticsCampaignIds] = useState<number[]>([]);
  const [selectedFollowUpJobId, setSelectedFollowUpJobId] = useState<number | null>(null);

  const scopeCampaigns = useMemo(() => {
    if (selectedAnalyticsCampaignIds.length === 0) return scopedCampaigns;
    const allowed = new Set(selectedAnalyticsCampaignIds.map((id) => Number(id)));
    return scopedCampaigns.filter((c) => allowed.has(Number(c.id)));
  }, [scopedCampaigns, selectedAnalyticsCampaignIds]);

  useEffect(() => {
    setSelectedAnalyticsCampaignIds((prev) => {
      if (prev.length === 0) return prev;
      const allowed = new Set(scopedCampaignIds);
      const next = prev.filter((id) => allowed.has(Number(id)));
      return next.length === prev.length ? prev : next;
    });
  }, [scopedCampaignIds]);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);
  useEffect(() => {
    let alive = true;
    setStatsLoading(true);
    const selected = [...new Set(selectedAnalyticsCampaignIds.map((id) => Number(id)))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    // N-26: only an explicit selection is sent as ids; the SMTP scope is applied on the server.
    const params = {
      view: chartView,
      campaignIds: selected.length > 0 ? selected : undefined,
      scopeSmtpId: scopeSmtpProfileId,
      followUpJobId: selectedFollowUpJobId ?? undefined,
    };
    dashboardApi
      .getStats(params)
      .then((data) => {
        if (alive) setDashboardStats(data);
      })
      .catch(() => {
        if (alive) setDashboardStats(null);
      })
      .finally(() => {
        if (alive) setStatsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [chartView, selectedAnalyticsCampaignIds, selectedFollowUpJobId, scopeSmtpProfileId]);

  const totalCampaigns = scopeCampaigns.length;
  const completedCampaigns = scopeCampaigns.filter((c) => c.status === 'completed').length;
  const totalRecipientsFromStore = scopeCampaigns.reduce((sum, c) => sum + (campaignRecipientCount(c) || 0), 0);

  /** Chart/time series from filtered dashboard. Sent/delivered counts + denominator come from API for the same campaign scope (store counts can be stale). */
  const emailsSentCount = dashboardStats?.totalEmailsSent ?? 0;
  const totalEmailsCount =
    dashboardStats?.totalRecipientCountInScope ?? totalRecipientsFromStore;
  const totalDeliveredApi = dashboardStats?.totalDelivered ?? 0;
  const totalComplaints = dashboardStats?.totalComplaints ?? 0;
  const totalFailed = dashboardStats?.totalFailed ?? 0;
  const totalBouncesApi = dashboardStats?.totalBounces ?? 0;
  const totalBounced = totalFailed + totalBouncesApi;
  const totalUnsubscribed = dashboardStats?.totalUnsubscribed ?? 0;
  const openedCount = dashboardStats?.totalOpened ?? 0;
  const repliedCount = dashboardStats?.totalReplied ?? 0;

  const deliveryRate = ratePctString(totalDeliveredApi, emailsSentCount);
  // GEN (bounce rate): failed sends have no sent_at, so they are not in emailsSentCount. The rate is
  // (bounced + failed) out of all attempted sends (sent + failed), so it is never inflated.
  const bounceRate = ratePctString(totalBounced, emailsSentCount + totalFailed);
  const openRate = ratePctString(openedCount, emailsSentCount);
  const replyRate = ratePctString(repliedCount, emailsSentCount);
  const unsubRate = ratePctString(totalUnsubscribed, emailsSentCount);

  const hasEmailMetrics =
    emailsSentCount > 0 || openedCount > 0 || repliedCount > 0 || totalBounced > 0;
  // F-35: with nothing sent there is nothing to judge deliverability on.
  const hasSends = emailsSentCount + totalFailed > 0;
  const complaintRatePct = emailsSentCount > 0 ? (totalComplaints / emailsSentCount) * 100 : 0;
  const bounceRateNum = Number(bounceRate);

  const statusBreakdown = [
    { status: 'Completed', count: completedCampaigns, color: 'bg-green-500', pct: totalCampaigns > 0 ? Math.round((completedCampaigns / totalCampaigns) * 100) : 0 },
    { status: 'In Progress', count: scopeCampaigns.filter((c) => c.status === 'in_progress').length, color: 'bg-yellow-500', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'in_progress').length / totalCampaigns) * 100) : 0 },
    { status: 'Scheduled', count: scopeCampaigns.filter((c) => c.status === 'scheduled').length, color: 'bg-blue-500', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'scheduled').length / totalCampaigns) * 100) : 0 },
    { status: 'Draft', count: scopeCampaigns.filter((c) => c.status === 'draft').length, color: 'bg-gray-400', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'draft').length / totalCampaigns) * 100) : 0 },
    { status: 'Paused', count: scopeCampaigns.filter((c) => c.status === 'paused').length, color: 'bg-orange-500', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'paused').length / totalCampaigns) * 100) : 0 },
  ];

  const funnelData = [
    // F-22: Sent is the top of the funnel (100%); every other stage is a share of Sent.
    { label: 'Sent', value: emailsSentCount, color: 'bg-blue-500', pct: emailsSentCount > 0 ? 100 : 0 },
    { label: 'Opened', value: openedCount, color: 'bg-green-600', pct: funnelPct(openedCount, emailsSentCount) },
    { label: 'Replied', value: repliedCount, color: 'bg-purple-500', pct: funnelPct(repliedCount, emailsSentCount) },
    // Same base as the Bounce Rate card (attempted sends), so the two numbers agree.
    { label: 'Bounced', value: totalBounced, color: 'bg-red-500', pct: funnelPct(totalBounced, emailsSentCount + totalFailed) },
  ];

  const perfBars = [
    { label: 'Delivery Rate', value: Number(deliveryRate), color: 'bg-green-500' },
    { label: 'Open Rate', value: Number(openRate), color: 'bg-blue-500' },
    { label: 'Reply Rate', value: Number(replyRate), color: 'bg-purple-500' },
    { label: 'Bounce Rate', value: Number(bounceRate), color: 'bg-red-500' },
  ];

  const topCampaigns = dashboardStats?.topCampaigns ?? [];
  const chartData: TimePoint[] = dashboardStats?.timeSeries ?? [];
  const chartMaxRaw = Math.max(1, ...chartData.flatMap((p) => [p.sent, p.delivered, p.opened, p.clicked]));
  const chartMax = niceAxisMax(chartMaxRaw);
  const chartWidth = 1000;
  const chartHeight = 260;
  const marginLeft = 72;
  const marginRight = 12;
  const marginTop = 12;
  const marginBottom = 40;
  const plotWidth = chartWidth - marginLeft - marginRight;
  const plotHeight = chartHeight - marginTop - marginBottom;

  const xForIndex = (idx: number) => {
    if (chartData.length <= 1) return marginLeft + plotWidth / 2;
    return marginLeft + (idx / (chartData.length - 1)) * plotWidth;
  };
  const yForValue = (value: number) => marginTop + (1 - value / chartMax) * plotHeight;

  const makeLine = (key: keyof Pick<TimePoint, 'sent' | 'delivered' | 'opened' | 'clicked'>) =>
    chartData.map((p, idx) => `${xForIndex(idx)},${yForValue(p[key])}`).join(' ');

  const xTickIndices = React.useMemo(() => {
    if (chartData.length === 0) return [];
    if (chartView === 'yearly') return chartData.map((_, i) => i);
    const lastIdx = chartData.length - 1;
    const set = new Set<number>([0, lastIdx]);
    for (let i = 7; i < lastIdx; i += 7) set.add(i);

    // Prevent end-of-month collisions like "Apr 29" and "Apr 30".
    const sorted = Array.from(set).sort((a, b) => a - b);
    // F-23: an end-anchored last label needs room for a whole label on its left.
    const minTickGapPx = 80;
    const result: number[] = [];
    for (const idx of sorted) {
      const prev = result[result.length - 1];
      if (prev == null) {
        result.push(idx);
        continue;
      }
      const gap = Math.abs(xForIndex(idx) - xForIndex(prev));
      if (gap >= minTickGapPx) {
        result.push(idx);
      } else if (idx === lastIdx) {
        // Keep the final label and replace the crowded previous one.
        result[result.length - 1] = idx;
      }
    }
    return result;
  }, [chartData, chartView, plotWidth]);

  const verticalGridIndices = React.useMemo(() => {
    if (chartData.length === 0) return [];
    if (chartView === 'yearly') return chartData.map((_, i) => i);
    // Weekly vertical guides in monthly view to reduce noise
    return xTickIndices;
  }, [chartData, chartView, xTickIndices]);

  if (isLoading) return <PageLoader />;

  return (
    <div className="app-page-shell space-y-6 w-full max-w-full">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 w-full max-w-full">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-gray-500 mt-0.5 text-sm">Email performance and campaign insights</p>
          <ScopeNotice className="mt-1" />
          {selectedAnalyticsCampaignIds.length > 0 && (
            <p className="text-xs text-gray-600 mt-1">
              Showing data for {selectedAnalyticsCampaignIds.length} selected campaign
              {selectedAnalyticsCampaignIds.length === 1 ? '' : 's'} — charts and totals match this filter.
            </p>
          )}
        </div>
        <FollowUpFilters
          campaigns={scopedCampaigns}
          selectedCampaignIds={selectedAnalyticsCampaignIds}
          onCampaignChange={setSelectedAnalyticsCampaignIds}
          selectedJobId={selectedFollowUpJobId}
          onJobChange={setSelectedFollowUpJobId}
        />

      </div>

      <div
        className={`space-y-6 transition-opacity ${
          statsLoading ? 'pointer-events-none opacity-50' : 'opacity-100'
        }`}
      >
      {totalComplaints > 0 && (
        <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{totalComplaints} spam complaints detected — review content.</span>
        </div>
      )}

      {/* Top metrics — dashboard refetch ignores stale responses when filter changes */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatsCard title="Total Sent" value={emailsSentCount.toLocaleString()} icon={Send} iconColor="text-gray-400" iconBgColor="bg-gray-50" />
        {/* U-05: red only when the bounce rate is high. F-34: no made-up trend on Open Rate. */}
        <StatsCard title="Bounced" value={totalBounced.toLocaleString()} change={hasSends ? `${bounceRate}%` : undefined} changeType={bounceRateNum >= 5 ? 'negative' : 'neutral'} icon={AlertCircle} iconColor="text-orange-500" iconBgColor="bg-orange-50" />
        <StatsCard title="Open Rate" value={`${openRate}%`} icon={MailOpen} iconColor="text-blue-500" iconBgColor="bg-blue-50" />
        <StatsCard title="Reply Rate" value={`${replyRate}%`} icon={MessageCircle} iconColor="text-purple-500" iconBgColor="bg-purple-50" />
        <StatsCard title="Bounce Rate" value={`${bounceRate}%`} icon={AlertTriangle} iconColor="text-red-500" iconBgColor="bg-red-50" />
        <StatsCard title="Unsub Rate" value={`${unsubRate}%`} icon={UserMinus} iconColor="text-gray-400" iconBgColor="bg-gray-50" />
      </div>

      {/* Performance Over Time */}
      <Card>
        <CardContent>
          {/* U-12: header, toggle and legend wrap on narrow screens. */}
          <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">Performance Over Time</h2>
              <p className="text-xs text-gray-500">
                {/* F-23: subtitle matches the toggle. */}
                {chartView === 'monthly' ? 'Monthly view - one point per day' : 'Yearly view - one point per month (last 12 months)'}
                {selectedAnalyticsCampaignIds.length > 0 ? ' · Selected campaigns only' : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap justify-end">
              <div className="inline-flex rounded-md border border-gray-200 overflow-hidden">
                <button
                  className={`px-3 py-1.5 text-xs ${chartView === 'monthly' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => setChartView('monthly')}
                >
                  Monthly
                </button>
                <button
                  className={`px-3 py-1.5 text-xs border-l border-gray-200 ${chartView === 'yearly' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => setChartView('yearly')}
                >
                  Yearly
                </button>
              </div>
              {/* F-23: legend matches the four drawn lines (sent is the dark line). */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {[
                  { label: 'Sent', color: '#111827' },
                  { label: 'Delivered', color: '#22c55e' },
                  { label: 'Opened', color: '#3b82f6' },
                  { label: 'Replied', color: '#f59e0b' },
                ].map((l) => (
                  <span key={l.label} className="flex items-center gap-1 text-gray-700">
                    <span aria-hidden style={{ width: 10, height: 10, borderRadius: 9999, background: l.color, display: 'inline-block' }} />
                    {l.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-100 p-2 bg-white">
            {chartData.length > 0 ? (
              <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full h-[270px]">
                {[0, 0.25, 0.5, 0.75, 1].map((step) => {
                  const y = marginTop + step * plotHeight;
                  const tickValue = Math.round((1 - step) * chartMax);
                  return (
                    <g key={`y-${step}`}>
                      <line x1={marginLeft} y1={y} x2={chartWidth - marginRight} y2={y} stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3 4" />
                      <text x={marginLeft - 10} y={y + 4} textAnchor="end" fontSize="11" fill="#6b7280">
                        {tickValue}
                      </text>
                    </g>
                  );
                })}

                {verticalGridIndices.map((idx) => {
                  const x = xForIndex(idx);
                  return (
                    <line
                      key={`x-${idx}`}
                      x1={x}
                      y1={marginTop}
                      x2={x}
                      y2={marginTop + plotHeight}
                      stroke="#eef2f7"
                      strokeWidth="1"
                    />
                  );
                })}

                <polyline fill="none" stroke="#111827" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={makeLine('sent')} />
                <polyline fill="none" stroke="#22c55e" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={makeLine('delivered')} />
                <polyline fill="none" stroke="#3b82f6" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={makeLine('opened')} />
                <polyline fill="none" stroke="#f59e0b" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={makeLine('clicked')} />

                {xTickIndices.map((idx) => (
                  <text
                    key={`lbl-${chartData[idx]?.day}-${idx}`}
                    x={xForIndex(idx)}
                    y={chartHeight - 8}
                    textAnchor={idx === 0 ? 'start' : idx === chartData.length - 1 ? 'end' : 'middle'}
                    fontSize="11"
                    fill="#6b7280"
                  >
                    {chartData[idx]?.day}
                  </text>
                ))}

              </svg>
            ) : (
              <div className="h-[270px] flex items-center justify-center text-sm text-gray-400">
                No time-series data yet
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Email Funnel */}
      <Card>
        <CardContent>
          <h2 className="text-base font-semibold text-gray-900 mb-1">Email Funnel</h2>
          <p className="text-xs text-gray-500 mb-4">Conversion through email stages</p>
          {hasEmailMetrics ? (
            <div className="space-y-3">
              {funnelData.map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 w-20">{item.label}</span>
                  <div className="flex-1 bg-gray-100 rounded-lg h-7 overflow-hidden relative">
                    <div className={`h-full ${item.color} rounded-lg flex items-center transition-all duration-700`} style={{ width: `${item.pct}%` }}>
                      <span className="text-gray-900 text-xs font-semibold pl-3 whitespace-nowrap">{item.value.toLocaleString()}</span>
                    </div>
                  </div>
                  <span className="text-xs text-gray-500 w-12 text-right">{item.pct}%</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400">
              <Mail className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p className="text-sm">No email data yet</p>
              <p className="text-xs mt-1">Send your first campaign to see funnel metrics</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance Overview */}
        <Card>
          <CardContent>
            <h2 className="text-base font-semibold text-gray-900 mb-4">Performance Overview</h2>
            <div className="space-y-3">
              {perfBars.map((item) => (
                <div key={item.label}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-gray-600">{item.label}</span>
                    <span className="text-sm font-semibold text-gray-900">{hasSends ? `${item.value}%` : '–'}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full ${item.color} rounded-full transition-all duration-500`} style={{ width: `${item.value}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <h3 className="text-sm font-semibold text-gray-900 mt-6 mb-3">Campaign Status</h3>
            <div className="space-y-2">
              {statusBreakdown.map((item) => (
                <div key={item.status} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`w-2.5 h-2.5 rounded-full ${item.color}`}></span>
                    <span className="text-gray-600">{item.status}</span>
                  </div>
                  <span className="text-gray-900 font-medium">{item.pct}% <span className="text-gray-400 font-normal">({item.count})</span></span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Top Campaigns + Deliverability */}
        <div className="space-y-6">
          <Card>
            <CardContent>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-semibold text-gray-900">Top Campaigns</h2>
                <span className="text-xs text-gray-500">Emails sent</span>
              </div>
              {topCampaigns.length > 0 ? (
                <div className="space-y-3">
                  {topCampaigns.map((c, i) => (
                    <div key={c.id} className="flex items-center gap-3">
                      <div className="w-7 h-7 bg-gray-100 rounded-lg flex items-center justify-center text-xs font-bold text-gray-500">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                        <p className="text-xs text-gray-500 truncate">{c.subject}</p>
                      </div>
                      <span className="text-sm font-semibold text-gray-900">{c.sent.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-4">No campaigns have sent emails yet</p>
              )}
            </CardContent>
          </Card>

          {selectedFollowUpJobId == null && (
            <BestSendTimeCard campaignIds={selectedAnalyticsCampaignIds} scopeSmtpId={scopeSmtpProfileId} />
          )}

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-3">Deliverability Insights</h2>
              {/* F-35: judged from real bounce / complaint rates, and only once something was sent. */}
              {!hasSends && <p className="text-xs text-gray-500 mb-2">Not enough data yet. Send a campaign to see deliverability insights.</p>}
              <div className="space-y-2">
                {[
                  { label: 'Bounce Health', ...insightLevel(hasSends, bounceRateNum, 2, 5, ['Healthy', 'Watch', 'Warning']) },
                  { label: 'Spam Risk', ...insightLevel(hasSends, complaintRatePct, 0.1, 0.3, ['Low', 'Medium', 'High']) },
                  { label: 'List Quality', ...insightLevel(hasSends, bounceRateNum + complaintRatePct, 2, 5, ['Good', 'Fair', 'Poor']) },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between py-1">
                    <span className="text-sm text-gray-600">{item.label}</span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${item.color}`}>{item.status}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      </div>
    </div>
  );
}
