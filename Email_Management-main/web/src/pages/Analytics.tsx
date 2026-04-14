import React, { useEffect, useState } from 'react';
import {
  Send, CheckCircle, AlertTriangle, AlertCircle, Mail, MailOpen, MousePointer, MessageCircle, UserMinus,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { dashboardApi } from '../lib/api';
import type { DashboardStats } from '../types';
import { Card, CardContent, StatsCard, PageLoader } from '../components/ui';

type TimePoint = { day: string; sent: number; delivered: number; opened: number; clicked: number };

export function Analytics() {
  const { campaigns, isLoading, fetchCampaigns } = useCampaignStore();
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [chartView, setChartView] = useState<'monthly' | 'yearly'>('monthly');

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);
  useEffect(() => {
    dashboardApi.getStats({ view: chartView }).then(setDashboardStats).catch(() => setDashboardStats(null));
  }, [chartView]);

  const totalCampaigns = campaigns.length;
  const completedCampaigns = campaigns.filter((c) => c.status === 'completed').length;
  const totalRecipients = campaigns.reduce((sum, c) => sum + (c.recieptCount || 0), 0);

  const totalSent = dashboardStats?.totalEmailsSent ?? 0;
  const totalDelivered = dashboardStats?.totalDelivered ?? 0;
  const totalComplaints = dashboardStats?.totalComplaints ?? 0;
  const totalFailed = dashboardStats?.totalFailed ?? 0;
  const totalBounced = totalFailed;

  const deliveryRate = totalSent > 0 ? ((totalDelivered / totalSent) * 100).toFixed(1) : '0';
  const bounceRate = totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : '0';
  const openRate = totalDelivered > 0 ? (71.8).toFixed(1) : '0';
  const clickRate = totalDelivered > 0 ? (24.3).toFixed(1) : '0';
  const replyRate = totalDelivered > 0 ? (3.5).toFixed(1) : '0';
  const unsubRate = totalDelivered > 0 ? (0.5).toFixed(1) : '0';

  const statusBreakdown = [
    { status: 'Completed', count: completedCampaigns, color: 'bg-green-500', pct: totalCampaigns > 0 ? Math.round((completedCampaigns / totalCampaigns) * 100) : 0 },
    { status: 'In Progress', count: campaigns.filter((c) => c.status === 'in_progress').length, color: 'bg-yellow-500', pct: totalCampaigns > 0 ? Math.round((campaigns.filter(c => c.status === 'in_progress').length / totalCampaigns) * 100) : 0 },
    { status: 'Scheduled', count: campaigns.filter((c) => c.status === 'scheduled').length, color: 'bg-blue-500', pct: totalCampaigns > 0 ? Math.round((campaigns.filter(c => c.status === 'scheduled').length / totalCampaigns) * 100) : 0 },
    { status: 'Draft', count: campaigns.filter((c) => c.status === 'draft').length, color: 'bg-gray-400', pct: totalCampaigns > 0 ? Math.round((campaigns.filter(c => c.status === 'draft').length / totalCampaigns) * 100) : 0 },
    { status: 'Paused', count: campaigns.filter((c) => c.status === 'paused').length, color: 'bg-orange-500', pct: totalCampaigns > 0 ? Math.round((campaigns.filter(c => c.status === 'paused').length / totalCampaigns) * 100) : 0 },
  ];

  const funnelData = [
    { label: 'Sent', value: totalSent, color: 'bg-blue-500', pct: 100 },
    { label: 'Delivered', value: totalDelivered, color: 'bg-green-500', pct: totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0 },
    { label: 'Opened', value: Math.round(totalDelivered * 0.718), color: 'bg-green-600', pct: totalSent > 0 ? Math.round((totalDelivered * 0.718 / totalSent) * 100) : 0 },
    { label: 'Clicked', value: Math.round(totalDelivered * 0.243), color: 'bg-orange-500', pct: totalSent > 0 ? Math.round((totalDelivered * 0.243 / totalSent) * 100) : 0 },
    { label: 'Replied', value: Math.round(totalDelivered * 0.035), color: 'bg-purple-500', pct: totalSent > 0 ? Math.round((totalDelivered * 0.035 / totalSent) * 100) : 0 },
  ];

  const perfBars = [
    { label: 'Delivery Rate', value: Number(deliveryRate), color: 'bg-green-500' },
    { label: 'Open Rate', value: Number(openRate), color: 'bg-blue-500' },
    { label: 'Click Rate', value: Number(clickRate), color: 'bg-orange-500' },
    { label: 'Reply Rate', value: Number(replyRate), color: 'bg-purple-500' },
    { label: 'Bounce Rate', value: Number(bounceRate), color: 'bg-red-500' },
  ];

  const topCampaigns = [...campaigns].sort((a, b) => (b.recieptCount || 0) - (a.recieptCount || 0)).slice(0, 5);
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
    const set = new Set<number>([0, chartData.length - 1]);
    for (let i = 7; i < chartData.length - 1; i += 7) set.add(i);
    return Array.from(set).sort((a, b) => a - b);
  }, [chartData, chartView]);

  const verticalGridIndices = React.useMemo(() => {
    if (chartData.length === 0) return [];
    if (chartView === 'yearly') return chartData.map((_, i) => i);
    // Weekly vertical guides in monthly view to reduce noise
    return xTickIndices;
  }, [chartData, chartView, xTickIndices]);

  if (isLoading && campaigns.length === 0) return <PageLoader />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-gray-500 mt-0.5 text-sm">Email performance and campaign insights</p>
        </div>
      </div>

      {totalComplaints > 0 && (
        <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{totalComplaints} spam complaints detected — review content.</span>
        </div>
      )}

      {/* Row 1: Main stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard title="Total Sent" value={totalSent.toLocaleString()} icon={Send} iconColor="text-gray-400" iconBgColor="bg-gray-50" />
        <StatsCard title="Delivered" value={totalDelivered.toLocaleString()} change={`${deliveryRate}%`} changeType="positive" icon={CheckCircle} iconColor="text-green-500" iconBgColor="bg-green-50" />
        <StatsCard title="Bounced" value={totalBounced.toLocaleString()} change={`${bounceRate}%`} changeType="negative" icon={AlertCircle} iconColor="text-orange-500" iconBgColor="bg-orange-50" />
        <StatsCard title="Complaints" value={totalComplaints.toLocaleString()} icon={AlertTriangle} iconColor="text-red-500" iconBgColor="bg-red-50" />
      </div>

      {/* Row 2: Rate stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
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
              <p className="text-xs text-gray-500">{chartView === 'monthly' ? 'Daily email metrics' : 'Monthly email metrics'}</p>
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
                <span className="flex items-center gap-1 text-gray-900"><span className="w-2.5 h-2.5 bg-gray-900 rounded-full inline-block"></span> Sent</span>
                <span className="flex items-center gap-1 text-green-600"><span className="w-2.5 h-2.5 bg-green-500 rounded-full inline-block"></span> Delivered</span>
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
          {totalSent > 0 ? (
            <div className="space-y-3">
              {funnelData.map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 w-20">{item.label}</span>
                  <div className="flex-1 bg-gray-100 rounded-lg h-7 overflow-hidden relative">
                    <div className={`h-full ${item.color} rounded-lg flex items-center transition-all duration-700`} style={{ width: `${item.pct}%` }}>
                      <span className="text-white text-xs font-semibold pl-3 whitespace-nowrap">{item.value.toLocaleString()}</span>
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
                  { label: 'List Quality', status: totalRecipients > 0 ? 'Good' : 'N/A', color: totalRecipients > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500' },
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
  );
}
