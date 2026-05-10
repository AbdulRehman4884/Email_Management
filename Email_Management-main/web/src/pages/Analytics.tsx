import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send, AlertTriangle, AlertCircle, Mail, MailOpen, MousePointer, MessageCircle, UserMinus, ChevronDown,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { dashboardApi } from '../lib/api';
import type { DashboardStats } from '../types';
import { Card, CardContent, StatsCard, PageLoader } from '../components/ui';

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

export function Analytics() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [chartView, setChartView] = useState<'monthly' | 'yearly'>('monthly');
  const [selectedAnalyticsCampaignIds, setSelectedAnalyticsCampaignIds] = useState<number[]>([]);
  const [analyticsCampaignMenuOpen, setAnalyticsCampaignMenuOpen] = useState(false);
  const [analyticsCampaignPickerSearch, setAnalyticsCampaignPickerSearch] = useState('');
  const analyticsCampaignMenuRef = useRef<HTMLDivElement>(null);

  const scopeCampaigns = useMemo(() => {
    if (selectedAnalyticsCampaignIds.length === 0) return campaigns;
    const allowed = new Set(selectedAnalyticsCampaignIds.map((id) => Number(id)));
    return campaigns.filter((c) => allowed.has(Number(c.id)));
  }, [campaigns, selectedAnalyticsCampaignIds]);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);
  useEffect(() => {
    let alive = true;
    setStatsLoading(true);
    const selected = [...new Set(selectedAnalyticsCampaignIds.map((id) => Number(id)))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    /** Always send explicit campaign ids so the API never mis-reads "show all" vs a subset. */
    const idsForRequest =
      selected.length > 0
        ? selected
        : campaigns
            .map((c) => Number(c.id))
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((a, b) => a - b);
    const params =
      idsForRequest.length > 0 ? { view: chartView, campaignIds: idsForRequest } : { view: chartView };
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
  }, [chartView, selectedAnalyticsCampaignIds, campaigns]);

  useEffect(() => {
    if (!analyticsCampaignMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (analyticsCampaignMenuRef.current?.contains(e.target as Node)) return;
      setAnalyticsCampaignMenuOpen(false);
    };
    const id = window.setTimeout(() => document.addEventListener('click', onDoc), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('click', onDoc);
    };
  }, [analyticsCampaignMenuOpen]);

  useEffect(() => {
    if (!analyticsCampaignMenuOpen) setAnalyticsCampaignPickerSearch('');
  }, [analyticsCampaignMenuOpen]);

  useEffect(() => {
    if (!analyticsCampaignMenuOpen) return;
    const onWindowScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && analyticsCampaignMenuRef.current?.contains(t)) return;
      setAnalyticsCampaignMenuOpen(false);
    };
    const onResize = () => setAnalyticsCampaignMenuOpen(false);
    window.addEventListener('scroll', onWindowScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onWindowScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [analyticsCampaignMenuOpen]);

  const toggleAnalyticsCampaign = (id: number) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    setSelectedAnalyticsCampaignIds((prev) => {
      const norm = [...new Set(prev.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
      return norm.includes(n) ? norm.filter((x) => x !== n) : [...norm, n];
    });
  };

  const totalCampaigns = scopeCampaigns.length;
  const completedCampaigns = scopeCampaigns.filter((c) => c.status === 'completed').length;
  const totalRecipientsFromStore = scopeCampaigns.reduce((sum, c) => sum + (c.recieptCount || 0), 0);

  /** Chart/time series from filtered dashboard. Sent/delivered counts + denominator come from API for the same campaign scope (store counts can be stale). */
  const emailsSentCount = dashboardStats?.totalEmailsSent ?? 0;
  const totalEmailsCount =
    dashboardStats?.totalRecipientCountInScope ?? totalRecipientsFromStore;
  const totalDeliveredApi = dashboardStats?.totalDelivered ?? 0;
  const totalComplaints = dashboardStats?.totalComplaints ?? 0;
  const totalFailed = dashboardStats?.totalFailed ?? 0;
  const totalBounced = totalFailed;
  const openedCount = dashboardStats?.totalOpened ?? 0;
  const clickedCount = dashboardStats?.totalReplied ?? 0;
  const repliedCount = dashboardStats?.totalReplied ?? 0;

  const deliveredAsSentCount = emailsSentCount;

  const deliveryRate = ratePctString(deliveredAsSentCount, totalEmailsCount);
  const bounceRate = ratePctString(totalBounced, totalEmailsCount);
  const openRate = ratePctString(openedCount, totalEmailsCount);
  const clickRate = ratePctString(clickedCount, totalEmailsCount);
  const replyRate = ratePctString(repliedCount, totalEmailsCount);
  const unsubRate = totalDeliveredApi > 0 ? (0.5).toFixed(1) : '0';

  const hasEmailMetrics =
    emailsSentCount > 0 || openedCount > 0 || repliedCount > 0 || totalBounced > 0;

  const analyticsPickerQuery = analyticsCampaignPickerSearch.trim().toLowerCase();
  const campaignsForAnalyticsPicker = useMemo(() => {
    if (!analyticsPickerQuery) return campaigns;
    return campaigns.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const subject = (c.subject || '').toLowerCase();
      const idStr = String(c.id);
      return (
        name.includes(analyticsPickerQuery)
        || subject.includes(analyticsPickerQuery)
        || idStr.includes(analyticsPickerQuery)
      );
    });
  }, [campaigns, analyticsPickerQuery]);

  const statusBreakdown = [
    { status: 'Completed', count: completedCampaigns, color: 'bg-green-500', pct: totalCampaigns > 0 ? Math.round((completedCampaigns / totalCampaigns) * 100) : 0 },
    { status: 'In Progress', count: scopeCampaigns.filter((c) => c.status === 'in_progress').length, color: 'bg-yellow-500', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'in_progress').length / totalCampaigns) * 100) : 0 },
    { status: 'Scheduled', count: scopeCampaigns.filter((c) => c.status === 'scheduled').length, color: 'bg-blue-500', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'scheduled').length / totalCampaigns) * 100) : 0 },
    { status: 'Draft', count: scopeCampaigns.filter((c) => c.status === 'draft').length, color: 'bg-gray-400', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'draft').length / totalCampaigns) * 100) : 0 },
    { status: 'Paused', count: scopeCampaigns.filter((c) => c.status === 'paused').length, color: 'bg-orange-500', pct: totalCampaigns > 0 ? Math.round((scopeCampaigns.filter((c) => c.status === 'paused').length / totalCampaigns) * 100) : 0 },
  ];

  const funnelData = [
    { label: 'Delivered', value: deliveredAsSentCount, color: 'bg-blue-500', pct: funnelPct(deliveredAsSentCount, totalEmailsCount) },
    { label: 'Opened', value: openedCount, color: 'bg-green-600', pct: funnelPct(openedCount, totalEmailsCount) },
    { label: 'Replied', value: repliedCount, color: 'bg-purple-500', pct: funnelPct(repliedCount, totalEmailsCount) },
    { label: 'Bounced', value: totalBounced, color: 'bg-red-500', pct: funnelPct(totalBounced, totalEmailsCount) },
  ];

  const perfBars = [
    { label: 'Delivery Rate', value: Number(deliveryRate), color: 'bg-green-500' },
    { label: 'Open Rate', value: Number(openRate), color: 'bg-blue-500' },
    // { label: 'Click Rate', value: Number(clickRate), color: 'bg-orange-500' },
    { label: 'Reply Rate', value: Number(replyRate), color: 'bg-purple-500' },
    { label: 'Bounce Rate', value: Number(bounceRate), color: 'bg-red-500' },
  ];

  const topCampaigns = [...scopeCampaigns].sort((a, b) => (b.recieptCount || 0) - (a.recieptCount || 0)).slice(0, 5);
  const chartData: TimePoint[] = dashboardStats?.timeSeries ?? [];
  const chartMaxRaw = Math.max(1, ...chartData.flatMap((p) => [p.sent, p.delivered, p.opened, p.clicked]));
  const chartMax = Math.ceil(chartMaxRaw / 250) * 250;
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
    const minTickGapPx = 56;
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

  if (isLoading && campaigns.length === 0) return <PageLoader />;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-gray-500 mt-0.5 text-sm">Email performance and campaign insights</p>
          {selectedAnalyticsCampaignIds.length > 0 && (
            <p className="text-xs text-gray-600 mt-1">
              Showing data for {selectedAnalyticsCampaignIds.length} selected campaign
              {selectedAnalyticsCampaignIds.length === 1 ? '' : 's'} — charts and totals match this filter.
            </p>
          )}
        </div>
        <div className="relative" ref={analyticsCampaignMenuRef}>
          <button
            type="button"
            onClick={() => setAnalyticsCampaignMenuOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 min-w-[12rem] justify-between"
          >
            <span className="truncate text-left">
              {selectedAnalyticsCampaignIds.length === 0
                ? 'All campaigns'
                : `${selectedAnalyticsCampaignIds.length} campaign${selectedAnalyticsCampaignIds.length === 1 ? '' : 's'}`}
            </span>
            <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
          </button>
          {analyticsCampaignMenuOpen && (
            <div
              className="absolute right-0 z-20 mt-1 flex w-72 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="shrink-0 border-b border-gray-100 p-2">
                <input
                  type="search"
                  placeholder="Search campaigns…"
                  value={analyticsCampaignPickerSearch}
                  onChange={(e) => setAnalyticsCampaignPickerSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-gray-900/15"
                />
              </div>
              <div className="campaign-picker-list-scroll py-1">
                {campaigns.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-500">No campaigns</p>
                ) : campaignsForAnalyticsPicker.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-500">No matches</p>
                ) : (
                  campaignsForAnalyticsPicker.map((c) => {
                    const checked = selectedAnalyticsCampaignIds.includes(Number(c.id));
                    return (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAnalyticsCampaign(c.id)}
                          className="rounded border-gray-300"
                        />
                        <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
              {selectedAnalyticsCampaignIds.length > 0 && (
                <button
                  type="button"
                  className="shrink-0 border-t border-gray-100 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50"
                  onClick={() => setSelectedAnalyticsCampaignIds([])}
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
        </div>
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
        <StatsCard title="Total Delivered" value={deliveredAsSentCount.toLocaleString()} icon={Send} iconColor="text-gray-400" iconBgColor="bg-gray-50" />
        <StatsCard title="Bounced" value={totalBounced.toLocaleString()} change={`${bounceRate}%`} changeType="negative" icon={AlertCircle} iconColor="text-orange-500" iconBgColor="bg-orange-50" />
        <StatsCard title="Open Rate" value={`${openRate}%`} change="+2.5%" changeType="positive" icon={MailOpen} iconColor="text-blue-500" iconBgColor="bg-blue-50" />
        <StatsCard title="Click Rate" value={`${clickRate}%`} change="+1.2%" changeType="positive" icon={MousePointer} iconColor="text-orange-500" iconBgColor="bg-orange-50" />
        <StatsCard title="Reply Rate" value={`${replyRate}%`} icon={MessageCircle} iconColor="text-purple-500" iconBgColor="bg-purple-50" />
        <StatsCard title="Unsub Rate" value={`${unsubRate}%`} icon={UserMinus} iconColor="text-gray-400" iconBgColor="bg-gray-50" />
      </div>

      {/* Performance Over Time */}
      <Card>
        <CardContent>
          <div className="flex items-center justify-between mb-4 gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Performance Over Time</h2>
              <p className="text-xs text-gray-500">
                {chartView === 'monthly' ? 'Daily email metrics' : 'Monthly email metrics'}
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
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1 text-gray-900"><span className="w-2.5 h-2.5 bg-gray-900 rounded-full inline-block"></span> Delivered</span>
                <span className="flex items-center gap-1 text-blue-600"><span className="w-2.5 h-2.5 bg-blue-500 rounded-full inline-block"></span> Opened</span>
                <span className="flex items-center gap-1 text-amber-600"><span className="w-2.5 h-2.5 bg-orange-400 rounded-full inline-block"></span> Clicked</span>
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
                    <span className="text-sm font-semibold text-gray-900">{item.value}%</span>
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
                <span className="text-xs text-gray-500">Recipients</span>
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
                      <span className="text-sm font-semibold text-gray-900">{(c.recieptCount || 0).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400 text-center py-4">No campaigns</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-3">Deliverability Insights</h2>
              <div className="space-y-2">
                {[
                  { label: 'Bounce Health', status: Number(bounceRate) < 5 ? 'Healthy' : 'Warning', color: Number(bounceRate) < 5 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700' },
                  { label: 'Spam Risk', status: totalComplaints < 5 ? 'Low' : 'Medium', color: totalComplaints < 5 ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700' },
                  { label: 'List Quality', status: totalEmailsCount > 0 ? 'Good' : 'N/A', color: totalEmailsCount > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500' },
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
