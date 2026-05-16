import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquareReply, Plus } from 'lucide-react';
import { followUpApi } from '../lib/api';
import { useCampaignStore } from '../store';
import type { FollowUpAnalyticsResponse, FollowUpJobAnalyticsResponse, FollowUpJobRow } from '../types';
import { FollowUpFilters } from '../components/FollowUpFilters';
import { Button, Card, CardContent, PageLoader } from '../components/ui';
import { formatLocalScheduleDisplay } from '../lib/localScheduleFormat';
import { formatIsoWeekdaysList } from '../lib/isoWeekdays';
import {
  REPORTING_EMPTY_SCOPE_PLACEHOLDER_CAMPAIGN_ID,
  effectiveInboxCampaignIds,
  useReportingScope,
} from '../lib/reportingScope';

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
  const { scopeSmtpProfileId, scopedCampaigns, scopedCampaignIds } = useReportingScope();
  const [analytics, setAnalytics] = useState<FollowUpAnalyticsResponse | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<FollowUpJobRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>('all');
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
  const [jobDetail, setJobDetail] = useState<FollowUpJobAnalyticsResponse | null>(null);
  const [jobDetailLoading, setJobDetailLoading] = useState(false);
  const [showBucketTable, setShowBucketTable] = useState(false);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<number[]>([]);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  useEffect(() => {
    setSelectedCampaignIds((prev) => {
      if (prev.length === 0) return prev;
      const allowed = new Set(scopedCampaignIds);
      const next = prev.filter((id) => allowed.has(Number(id)));
      return next.length === prev.length ? prev : next;
    });
  }, [scopedCampaignIds]);

  const idsForAnalytics = useMemo(() => {
    if (scopeSmtpProfileId != null && scopedCampaignIds.length === 0) {
      return [REPORTING_EMPTY_SCOPE_PLACEHOLDER_CAMPAIGN_ID];
    }
    const selected = [...new Set(selectedCampaignIds.map((id) => Number(id)))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const eff =
      selected.length === 0
        ? scopedCampaignIds
        : effectiveInboxCampaignIds(selected, scopedCampaignIds);
    if (eff.length === 0 && scopeSmtpProfileId != null) {
      return [REPORTING_EMPTY_SCOPE_PLACEHOLDER_CAMPAIGN_ID];
    }
    return eff;
  }, [selectedCampaignIds, scopedCampaignIds, scopeSmtpProfileId]);

  const refreshAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const data = await followUpApi.getAnalytics(idsForAnalytics);
      setAnalytics(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load follow-up analytics';
      setAnalyticsError(msg);
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
    if (selectedJobId == null) {
      setJobDetail(null);
      return;
    }
    let alive = true;
    setJobDetailLoading(true);
    void followUpApi
      .getJobAnalytics(selectedJobId)
      .then((data) => {
        if (alive) setJobDetail(data);
      })
      .catch(() => {
        if (alive) setJobDetail(null);
      })
      .finally(() => {
        if (alive) setJobDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedJobId]);

  const visibleJobs = useMemo(() => {
    if (scopeSmtpProfileId == null) return jobs;
    const allowed = new Set(scopedCampaignIds);
    return jobs.filter((j) => allowed.has(Number(j.campaignId)));
  }, [jobs, scopeSmtpProfileId, scopedCampaignIds]);

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

  const stopJob = async (id: number) => {
    try {
      await followUpApi.stopJob(id);
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
        <CardContent className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <h2 className="text-base font-semibold text-gray-900">Follow-up runs</h2>
            <FollowUpFilters
              campaigns={scopedCampaigns}
              selectedCampaignIds={selectedCampaignIds}
              onCampaignChange={setSelectedCampaignIds}
              selectedJobId={selectedJobId}
              onJobChange={setSelectedJobId}
            />
          </div>
          <p className="text-xs text-gray-500">
            Each row is one scheduled job instance. Select a run to see sends for that run only.
          </p>
          {jobsLoading ? (
            <PageLoader />
          ) : (
            <div className="overflow-x-auto border border-gray-100 rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Campaign</th>
                    <th className="text-left px-3 py-2 font-medium">Template</th>
                    <th className="text-left px-3 py-2 font-medium">When</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-right px-3 py-2 font-medium">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                        No follow-up jobs yet.
                      </td>
                    </tr>
                  ) : (
                    visibleJobs.map((j) => (
                      <tr
                        key={j.id}
                        onClick={() => setSelectedJobId(j.id)}
                        className={`border-t border-gray-100 cursor-pointer hover:bg-gray-50/80 ${
                          selectedJobId === j.id ? 'bg-amber-50' : ''
                        }`}
                      >
                        <td className="px-3 py-2">{j.campaignName ?? `#${j.campaignId}`}</td>
                        <td className="px-3 py-2">{j.templateTitle ?? j.templateId}</td>
                        <td className="px-3 py-2">{formatLocalScheduleDisplay(j.scheduledAt)}</td>
                        <td className="px-3 py-2 capitalize">{j.status}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{j.sentCount ?? '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
          {selectedJobId != null && (
            <div className="rounded-lg border border-amber-100 bg-amber-50/50 px-3 py-3 text-sm">
              {jobDetailLoading ? (
                <p className="text-gray-600">Loading run analytics…</p>
              ) : jobDetail ? (
                <p className="text-gray-800 tabular-nums">
                  <strong>{jobDetail.job.templateTitle ?? 'Run'}</strong>: {jobDetail.summary.sent} sent ·{' '}
                  {jobDetail.summary.uniqueRecipients} recipients · {jobDetail.summary.replied} replies (proxy)
                </p>
              ) : (
                <p className="text-gray-600">Could not load run analytics.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
            <button
              type="button"
              className="text-base font-semibold text-gray-900 text-left hover:underline"
              onClick={() => setShowBucketTable((v) => !v)}
            >
              Recipient buckets (primary sent) {showBucketTable ? '▾' : '▸'}
            </button>
          </div>

          {showBucketTable && (
          <>
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
                  ? scopeSmtpProfileId == null
                    ? 'All your campaigns included.'
                    : 'Campaigns using the SMTP profile selected in Settings → Reports and inbox scope.'
                  : `${selectedCampaignIds.length} campaign${selectedCampaignIds.length === 1 ? '' : 's'} selected (within scope).`}
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

          {analyticsError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {analyticsError}
              <button
                type="button"
                onClick={() => void refreshAnalytics()}
                className="ml-2 underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          )}

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
          </>
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
          ) : visibleJobs.length === 0 ? (
            <p className="text-sm text-gray-500">
              No scheduled jobs for campaigns in the current SMTP scope. Change scope in Settings or pick &quot;All
              SMTP accounts&quot; to see every job.
            </p>
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
                  {visibleJobs.map((j) => {
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
                                  : j.status === 'cancelled' || j.status === 'stopped'
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
                        {j.status === 'running' && (
                          <Button variant="secondary" size="sm" onClick={() => void stopJob(j.id)}>
                            Stop
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
