import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, MessageSquareReply, Plus } from 'lucide-react';
import { followUpApi } from '../lib/api';
import { useCampaignStore } from '../store';
import type { FollowUpAnalyticsResponse, FollowUpJobRow } from '../types';
import { Button, Card, CardContent, PageLoader } from '../components/ui';
import { formatLocalScheduleDisplay } from '../lib/localScheduleFormat';
import { formatIsoWeekdaysList } from '../lib/isoWeekdays';

function formatMaxRunLabel(m: number | null | undefined): string | null {
  if (m == null || m < 1) return null;
  if (m % 60 === 0 && m >= 60) {
    const h = m / 60;
    return `Max ${h} hour${h === 1 ? '' : 's'} run`;
  }
  return `Max ${m} minute${m === 1 ? '' : 's'} run`;
}

type BucketFilter = 'all' | 0 | 1 | 2 | 3 | 4 | 5;

export function FollowUps() {
  const { campaigns, fetchCampaigns, isLoading } = useCampaignStore();
  const [analytics, setAnalytics] = useState<FollowUpAnalyticsResponse | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [jobs, setJobs] = useState<FollowUpJobRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>('all');
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<number[]>([]);
  const [campaignMenuOpen, setCampaignMenuOpen] = useState(false);
  const [campaignPickerSearch, setCampaignPickerSearch] = useState('');
  const campaignMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  const idsForAnalytics = useMemo(() => {
    const selected = [...new Set(selectedCampaignIds.map((id) => Number(id)))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    if (selected.length > 0) return selected;
    return campaigns
      .map((c) => Number(c.id))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  }, [selectedCampaignIds, campaigns]);

  const refreshAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const data = await followUpApi.getAnalytics(idsForAnalytics);
      setAnalytics(data);
    } catch {
      setAnalytics(null);
    } finally {
      setAnalyticsLoading(false);
    }
  }, [idsForAnalytics]);

  useEffect(() => {
    void refreshAnalytics();
  }, [refreshAnalytics]);

  const refreshJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const data = await followUpApi.listJobs();
      setJobs(data.jobs);
    } catch {
      setJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshJobs();
    const t = window.setInterval(() => void refreshJobs(), 30_000);
    return () => window.clearInterval(t);
  }, [refreshJobs]);

  useEffect(() => {
    if (!campaignMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (campaignMenuRef.current?.contains(e.target as Node)) return;
      setCampaignMenuOpen(false);
    };
    const id = window.setTimeout(() => document.addEventListener('click', onDoc), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('click', onDoc);
    };
  }, [campaignMenuOpen]);

  useEffect(() => {
    if (!campaignMenuOpen) setCampaignPickerSearch('');
  }, [campaignMenuOpen]);

  useEffect(() => {
    if (!campaignMenuOpen) return;
    const close = () => setCampaignMenuOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [campaignMenuOpen]);

  const toggleCampaign = (id: number) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    setSelectedCampaignIds((prev) => {
      const norm = [...new Set(prev.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
      return norm.includes(n) ? norm.filter((x) => x !== n) : [...norm, n];
    });
  };

  const pickerQuery = campaignPickerSearch.trim().toLowerCase();
  const campaignsForPicker = useMemo(() => {
    if (!pickerQuery) return campaigns;
    return campaigns.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const subject = (c.subject || '').toLowerCase();
      const idStr = String(c.id);
      return name.includes(pickerQuery) || subject.includes(pickerQuery) || idStr.includes(pickerQuery);
    });
  }, [campaigns, pickerQuery]);

  const filteredAnalyticsRows = useMemo(() => {
    const rows = analytics?.campaigns ?? [];
    if (bucketFilter === 'all') return rows;
    const k = bucketFilter;
    return rows.filter((r) => (r.buckets[k] ?? 0) > 0);
  }, [analytics?.campaigns, bucketFilter]);

  const bucketTabs: Array<{ key: BucketFilter; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 0, label: '0' },
    { key: 1, label: '1' },
    { key: 2, label: '2' },
    { key: 3, label: '3' },
    { key: 4, label: '4' },
    { key: 5, label: '5+' },
  ];

  const cancelJob = async (id: number) => {
    try {
      await followUpApi.cancelJob(id);
      await refreshJobs();
    } catch {
      // toast optional
    }
  };

  if (isLoading && campaigns.length === 0) return <PageLoader />;

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-gray-900">
            <MessageSquareReply className="w-8 h-8" />
            <h1 className="text-2xl font-bold">Follow-up</h1>
          </div>
          <p className="text-gray-500 mt-1 text-sm">
            Analytics by follow-up depth, scheduled bulk jobs, and scheduling for campaigns that already sent at least
            one primary email.
          </p>
        </div>
        <Link to="/follow-ups/schedule">
          <Button leftIcon={<Plus className="w-4 h-4" />}>Schedule follow-up</Button>
        </Link>
      </div>

      <Card>
        <CardContent>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
            <h2 className="text-base font-semibold text-gray-900">Recipient buckets (primary sent)</h2>
            <div className="relative" ref={campaignMenuRef}>
              <button
                type="button"
                onClick={() => setCampaignMenuOpen((o) => !o)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 min-w-[12rem] justify-between"
              >
                <span className="truncate text-left">
                  {selectedCampaignIds.length === 0 ? 'All campaigns' : `${selectedCampaignIds.length} selected`}
                </span>
                <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
              </button>
              {campaignMenuOpen && (
                <div
                  className="absolute right-0 z-20 mt-1 flex w-64 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="shrink-0 border-b border-gray-100 p-2">
                    <input
                      type="search"
                      placeholder="Search campaigns…"
                      value={campaignPickerSearch}
                      onChange={(e) => setCampaignPickerSearch(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-gray-900/15"
                    />
                  </div>
                  <div className="campaign-picker-list-scroll py-1">
                    {campaignsForPicker.map((c) => {
                      const checked = selectedCampaignIds.includes(Number(c.id));
                      return (
                        <label
                          key={c.id}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCampaign(Number(c.id))}
                          />
                          <span className="truncate">{c.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <p className="text-xs text-gray-500 mb-3">
            Counts are recipients who received the primary send, grouped by how many follow-up emails they have
            received so far. Column <strong>5+</strong> includes everyone with five or more follow-ups.
          </p>

          {analytics && (
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800">
              <p className="font-medium text-gray-900">Scope summary</p>
              <p className="mt-1 text-gray-700 tabular-nums">
                Recipients: <strong>{analytics.scopeSummary.recipientTotal}</strong>
                <span className="mx-2 text-gray-300">·</span>
                Primary sent: <strong>{analytics.scopeSummary.primarySent}</strong>
                <span className="mx-2 text-gray-300">·</span>
                Opened: <strong>{analytics.scopeSummary.opened}</strong>
                <span className="mx-2 text-gray-300">·</span>
                Replied: <strong>{analytics.scopeSummary.replied}</strong>
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {selectedCampaignIds.length === 0
                  ? 'All your campaigns included.'
                  : `${selectedCampaignIds.length} campaign${selectedCampaignIds.length === 1 ? '' : 's'} selected.`}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2 mb-4">
            {bucketTabs.map((tab) => {
              const active = bucketFilter === tab.key;
              return (
                <button
                  key={String(tab.key)}
                  type="button"
                  onClick={() => setBucketFilter(tab.key)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                    active
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {tab.label === '5+' ? '5+' : tab.label === 'All' ? 'All buckets' : `${tab.label} FU`}
                </button>
              );
            })}
          </div>

          {analyticsLoading ? (
            <PageLoader />
          ) : (
            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Campaign</th>
                    <th className="text-right px-2 py-2 font-medium tabular-nums">0</th>
                    <th className="text-right px-2 py-2 font-medium tabular-nums">1</th>
                    <th className="text-right px-2 py-2 font-medium tabular-nums">2</th>
                    <th className="text-right px-2 py-2 font-medium tabular-nums">3</th>
                    <th className="text-right px-2 py-2 font-medium tabular-nums">4</th>
                    <th className="text-right px-2 py-2 font-medium tabular-nums">5+</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAnalyticsRows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                        No campaigns in this filter.
                      </td>
                    </tr>
                  ) : (
                    filteredAnalyticsRows.map((row) => (
                      <tr key={row.id} className="border-t border-gray-100 hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-medium text-gray-900">
                          <Link to={`/campaigns/${row.id}`} className="hover:underline">
                            {row.name}
                          </Link>
                        </td>
                        {[0, 1, 2, 3, 4, 5].map((k) => (
                          <td
                            key={k}
                            className={`text-right px-2 py-2 tabular-nums ${
                              bucketFilter !== 'all' && bucketFilter === k ? 'bg-amber-50 font-semibold' : ''
                            }`}
                          >
                            {row.buckets[k as 0 | 1 | 2 | 3 | 4 | 5] ?? 0}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {analytics && analytics.campaignsWithActivity.length > 0 && (
        <Card>
          <CardContent>
            <h2 className="text-base font-semibold text-gray-900 mb-3">Campaigns with follow-up sends</h2>
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {analytics.campaignsWithActivity.map((c) => (
                <li key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <Link to={`/campaigns/${c.id}`} className="font-medium text-gray-900 hover:underline truncate">
                    {c.name}
                  </Link>
                  <span className="text-gray-500 tabular-nums shrink-0 ml-2">
                    {c.followUpOutboundTotal} outbound
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-gray-900">Scheduled jobs</h2>
            <Button variant="secondary" size="sm" onClick={() => void refreshJobs()} disabled={jobsLoading}>
              Refresh
            </Button>
          </div>
          {jobsLoading ? (
            <PageLoader />
          ) : jobs.length === 0 ? (
            <p className="text-sm text-gray-500">No follow-up jobs yet.</p>
          ) : (
            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Campaign</th>
                    <th className="text-left px-3 py-2 font-medium">When</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const maxRunLbl = formatMaxRunLabel(j.maxRunMinutes);
                    const sendDaysLbl =
                      j.sendWeekdays && j.sendWeekdays.length > 0
                        ? formatIsoWeekdaysList(j.sendWeekdays)
                        : null;
                    return (
                    <tr key={j.id} className="border-t border-gray-100">
                      <td className="px-3 py-2">
                        <span className="font-medium text-gray-900">{j.campaignName ?? `#${j.campaignId}`}</span>
                        <div className="text-xs text-gray-500">
                          Prior FU: {j.priorFollowUpCount} · {j.engagement}
                          {maxRunLbl ? <> · {maxRunLbl}</> : null}
                          {sendDaysLbl ? <> · Days: {sendDaysLbl}</> : null}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{formatLocalScheduleDisplay(j.scheduledAt)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${
                            j.status === 'completed'
                              ? 'bg-green-100 text-green-800'
                              : j.status === 'failed'
                                ? 'bg-red-100 text-red-800'
                                : j.status === 'running'
                                  ? 'bg-blue-100 text-blue-800'
                                  : j.status === 'cancelled'
                                    ? 'bg-gray-100 text-gray-700'
                                    : 'bg-amber-100 text-amber-900'
                          }`}
                        >
                          {j.status}
                        </span>
                        {j.errorMessage && (
                          <div
                            className={`text-xs mt-1 max-w-md whitespace-normal break-words ${
                              j.status === 'completed' &&
                              j.errorMessage.includes('Maximum run duration')
                                ? 'text-amber-800'
                                : 'text-red-600'
                            }`}
                            title={j.errorMessage}
                          >
                            {j.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {j.status === 'pending' && (
                          <Button variant="secondary" size="sm" onClick={() => void cancelJob(j.id)}>
                            Cancel
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
