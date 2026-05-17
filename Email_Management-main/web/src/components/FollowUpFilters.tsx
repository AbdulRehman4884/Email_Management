import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { followUpApi } from '../lib/api';
import type { Campaign, FollowUpJobRow } from '../types';
import { formatLocalScheduleDisplay } from '../lib/localScheduleFormat';

type Props = {
  campaigns: Campaign[];
  selectedCampaignIds: number[];
  onCampaignChange: (ids: number[]) => void;
  selectedJobId: number | null;
  onJobChange: (id: number | null) => void;
  /** When false, only one campaign can be selected (for Campaigns page). */
  multiSelect?: boolean;
  className?: string;
};

function jobLabel(j: FollowUpJobRow): string {
  const title = j.templateTitle || j.templateId;
  const when = formatLocalScheduleDisplay(j.scheduledAt);
  return `${title} · ${when} · Job #${j.id}`;
}

export function FollowUpFilters({
  campaigns,
  selectedCampaignIds,
  onCampaignChange,
  selectedJobId,
  onJobChange,
  multiSelect = true,
  className = '',
}: Props) {
  const [campaignMenuOpen, setCampaignMenuOpen] = useState(false);
  const [campaignSearch, setCampaignSearch] = useState('');
  const campaignMenuRef = useRef<HTMLDivElement>(null);
  const [jobs, setJobs] = useState<FollowUpJobRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);

  const singleCampaignId =
    selectedCampaignIds.length === 1 ? Number(selectedCampaignIds[0]) : null;

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
    if (!campaignMenuOpen) setCampaignSearch('');
  }, [campaignMenuOpen]);

  useEffect(() => {
    if (singleCampaignId == null || !Number.isFinite(singleCampaignId)) {
      setJobs([]);
      if (selectedJobId != null) onJobChange(null);
      return;
    }
    let alive = true;
    setJobsLoading(true);
    void followUpApi
      .listJobs({ campaignId: singleCampaignId })
      .then(({ jobs: list }) => {
        if (!alive) return;
        setJobs(list);
        if (selectedJobId != null && !list.some((j) => j.id === selectedJobId)) {
          onJobChange(null);
        }
      })
      .catch(() => {
        if (alive) setJobs([]);
      })
      .finally(() => {
        if (alive) setJobsLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset job when campaign changes
  }, [singleCampaignId]);

  const filteredCampaigns = useMemo(() => {
    const q = campaignSearch.trim().toLowerCase();
    if (!q) return campaigns;
    return campaigns.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.subject || '').toLowerCase().includes(q) ||
        String(c.id).includes(q)
    );
  }, [campaigns, campaignSearch]);

  const toggleCampaign = (id: number) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!multiSelect) {
      onCampaignChange([n]);
      onJobChange(null);
      setCampaignMenuOpen(false);
      return;
    }
    const norm = [...new Set(selectedCampaignIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
    const next = norm.includes(n) ? norm.filter((x) => x !== n) : [...norm, n];
    onCampaignChange(next);
    if (next.length !== 1) onJobChange(null);
  };

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <div className="relative" ref={campaignMenuRef}>
        <button
          type="button"
          onClick={() => setCampaignMenuOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 min-w-[12rem] justify-between"
        >
          <span className="truncate text-left">
            {selectedCampaignIds.length === 0
              ? 'All campaigns'
              : multiSelect
                ? `${selectedCampaignIds.length} campaign${selectedCampaignIds.length === 1 ? '' : 's'}`
                : campaigns.find((c) => c.id === selectedCampaignIds[0])?.name ?? 'Campaign'}
          </span>
          <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
        </button>
        {campaignMenuOpen && (
          <div
            className="absolute right-0 z-20 mt-1 flex w-72 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 border-b border-gray-100 p-2">
              <input
                type="search"
                placeholder="Search campaigns…"
                value={campaignSearch}
                onChange={(e) => setCampaignSearch(e.target.value)}
                className="w-full rounded-md border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-gray-900/15"
              />
            </div>
            <div className="campaign-picker-list-scroll max-h-60 overflow-y-auto py-1">
              {filteredCampaigns.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-500">No campaigns</p>
              ) : (
                filteredCampaigns.map((c) => {
                  const checked = selectedCampaignIds.includes(Number(c.id));
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50"
                    >
                      <input
                        type={multiSelect ? 'checkbox' : 'radio'}
                        name={multiSelect ? undefined : 'campaign-filter'}
                        checked={checked}
                        onChange={() => toggleCampaign(c.id)}
                        className="rounded border-gray-300"
                      />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    </label>
                  );
                })
              )}
            </div>
            {selectedCampaignIds.length > 0 && (
              <button
                type="button"
                className="shrink-0 border-t border-gray-100 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50"
                onClick={() => {
                  onCampaignChange([]);
                  onJobChange(null);
                }}
              >
                Clear selection
              </button>
            )}
          </div>
        )}
      </div>

      {singleCampaignId != null && (
        <div className="flex items-center gap-2">
          <label htmlFor="follow-up-job-filter" className="text-sm text-gray-600 whitespace-nowrap">
            Follow-up run
          </label>
          <select
            id="follow-up-job-filter"
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white min-w-[14rem] max-w-[20rem]"
            value={selectedJobId ?? ''}
            disabled={jobsLoading}
            onChange={(e) => {
              const v = e.target.value;
              onJobChange(v ? Number(v) : null);
            }}
          >
            <option value="">All follow-ups (campaign)</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {jobLabel(j)}
                {j.sentCount != null ? ` · ${j.sentCount} sent` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}