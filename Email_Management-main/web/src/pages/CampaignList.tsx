import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Search, Mail, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { useCampaignStore } from '../store';
import { useReportingScope } from '../lib/reportingScope';
import { ScopeNotice } from '../components/ScopeNotice';
import {
  Button,
  Card,
  CardContent,
  StatusBadge,
  PageLoader,
  EmptyState,
  Modal,
  useToast,
} from '../components/ui';
import type { Campaign, CampaignStatus } from '../types';
import { crmApi, type CrmTag } from '../lib/api';
import { useCrmEnabled } from '../lib/crmAccess';
import { TagList } from '../components/crm/TagChip';
import { formatDisplayDate } from '../lib/dateFormat';
import { campaignRecipientCount } from '../lib/apiFields';

type SortKey = 'name' | 'status' | 'recipients' | 'created';
const SORT_KEYS: SortKey[] = ['name', 'status', 'recipients', 'created'];
const PAGE_SIZE = 20;

const STATUS_TABS: { label: string; value: CampaignStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Sending', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Paused', value: 'paused' },
];

export function CampaignList() {
  const {
    campaigns,
    isLoading,
    fetchCampaigns,
    deleteCampaign,
  } = useCampaignStore();
  const { scopeSmtpProfileId, scopedCampaigns } = useReportingScope();
  const toast = useToast();

  // F-48: search, filters, sort and page live in the URL, so they survive a refresh and can be shared.
  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key: string, value: string | null, resetPage = true) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === '') next.delete(key);
      else next.set(key, value);
      if (resetPage) next.delete('page');
      return next;
    }, { replace: true });
  };
  const searchQuery = searchParams.get('q') ?? '';
  const setSearchQuery = (v: string) => setParam('q', v);
  const statusParam = searchParams.get('status') ?? 'all';
  const statusFilter = (STATUS_TABS.some((t) => t.value === statusParam) ? statusParam : 'all') as CampaignStatus | 'all';
  const setStatusFilter = (v: CampaignStatus | 'all') => setParam('status', v === 'all' ? null : v);
  const sortParam = searchParams.get('sort') as SortKey | null;
  const sortKey: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : 'created';
  const sortDir: 'asc' | 'desc' = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const toggleSort = (key: SortKey) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const dir = sortKey === key && sortDir === 'desc' ? 'asc' : 'desc';
      next.set('sort', key);
      next.set('dir', dir);
      next.delete('page');
      return next;
    }, { replace: true });
  };
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; campaign: Campaign | null }>({
    open: false,
    campaign: null,
  });
  const [isDeleting, setIsDeleting] = useState(false);
  // CRM step 5: campaign tags (chips + filter). Hidden when the plan has no CRM.
  const crmEnabled = useCrmEnabled();
  const [tagMap, setTagMap] = useState<{ tags: CrmTag[]; campaigns: Record<string, number[]> }>({ tags: [], campaigns: {} });
  const tagFilter = Number(searchParams.get('tag')) > 0 ? Number(searchParams.get('tag')) : null;
  const setTagFilter = (v: number | null) => setParam('tag', v == null ? null : String(v));
  const tagsOf = (campaignId: number): CrmTag[] =>
    (tagMap.campaigns[String(campaignId)] ?? [])
      .map((id) => tagMap.tags.find((t) => t.id === id))
      .filter((t): t is CrmTag => Boolean(t));

  useEffect(() => {
    if (!crmEnabled) return;
    crmApi.getCampaignTagMap().then(setTagMap).catch(() => undefined);
  }, [crmEnabled]);
  // Track whether the initial fetch has completed so background polls don't
  // trigger the full-page loader (isLoading goes true on every fetchCampaigns call).
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    void fetchCampaigns().then(() => setHasLoaded(true)).catch(() => setHasLoaded(true));
  }, [fetchCampaigns]);

  // Background poll every 10 s when any campaign is scheduled or sending.
  useEffect(() => {
    if (!hasLoaded) return;
    const needsPolling = campaigns.some(
      (c) => c.status === 'in_progress' || c.status === 'scheduled'
    );
    if (!needsPolling) return;
    const interval = setInterval(() => { void fetchCampaigns(); }, 10_000);
    return () => clearInterval(interval);
  }, [campaigns, hasLoaded, fetchCampaigns]);

  // F-37: leading/trailing spaces in the search box are ignored (same as Inbox).
  const searchTerm = searchQuery.trim().toLowerCase();
  const filteredCampaigns = scopedCampaigns
    .filter((campaign) => {
      const matchesSearch =
        campaign.name.toLowerCase().includes(searchTerm) ||
        campaign.subject.toLowerCase().includes(searchTerm);
      const matchesStatus = statusFilter === 'all' || campaign.status === statusFilter;
      const matchesTag = tagFilter == null || (tagMap.campaigns[String(campaign.id)] ?? []).includes(tagFilter);
      return matchesSearch && matchesStatus && matchesTag;
    })
    .sort((a, b) => {
      // F-26 / U-16: default is the Created column, newest first (ties by id, as createdAt may be a date only).
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      else if (sortKey === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortKey === 'recipients') cmp = (campaignRecipientCount(a) || 0) - (campaignRecipientCount(b) || 0);
      else cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id - b.id;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  const isFiltered = searchTerm !== '' || statusFilter !== 'all' || tagFilter != null;
  // U-16: pagination.
  const pageCount = Math.max(1, Math.ceil(filteredCampaigns.length / PAGE_SIZE));
  const currentPage = Math.min(pageCount, Math.max(1, Number(searchParams.get('page')) || 1));
  const pagedCampaigns = filteredCampaigns.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const sortHeader = (key: SortKey, label: string) => (
    <th
      className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider"
      aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-900">
        {label}
        {sortKey === key && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" aria-hidden /> : <ChevronDown className="w-3 h-3" aria-hidden />)}
      </button>
    </th>
  );

  const handleDelete = async () => {
    if (!deleteModal.campaign) return;
    setIsDeleting(true);
    try {
      await deleteCampaign(deleteModal.campaign.id);
      setDeleteModal({ open: false, campaign: null });
      toast.success('Campaign deleted successfully');
    } catch {
      toast.error('Failed to delete campaign. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const formatDate = (dateString: string) => formatDisplayDate(dateString);

  if (!hasLoaded && isLoading) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          <p className="text-gray-500 mt-1">
            {/* F-27: with a search / filter the header says how many match. */}
            {isFiltered ? (
              <>{filteredCampaigns.length} of {scopedCampaigns.length} campaigns</>
            ) : scopeSmtpProfileId == null ? (
              <>{campaigns.length} campaigns total</>
            ) : (
              <>
                {scopedCampaigns.length} of {campaigns.length} campaigns
              </>
            )}
          </p>
          <ScopeNotice className="mt-1" />
        </div>
        <Link to="/campaigns/create">
          <Button leftIcon={<Plus className="w-4 h-4" />}>New campaign</Button>
        </Link>
      </div>

      <Card>
        <CardContent className="pb-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                type="text"
                aria-label="Search campaigns"
                placeholder="Search campaigns..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent"
              />
            </div>
            {/* U-03: chips wrap instead of scrolling off-screen on small phones. */}
            <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label="Filter by status">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  aria-pressed={statusFilter === tab.value}
                  onClick={() => setStatusFilter(tab.value)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    statusFilter === tab.value
                      ? 'bg-gray-900 text-white rounded-full'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {crmEnabled && tagMap.tags.some((t) => t.scope !== 'contact') && (
              <select
                aria-label="Filter by tag"
                value={tagFilter ?? ''}
                onChange={(e) => setTagFilter(e.target.value ? Number(e.target.value) : null)}
                className="bg-white border border-gray-200 rounded-lg text-sm text-gray-700"
                style={{ height: 36, padding: '0 10px' }}
              >
                <option value="">All tags</option>
                {tagMap.tags
                  .filter((t) => t.scope !== 'contact')
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            )}
          </div>

          {filteredCampaigns.length > 0 ? (
            <>
              {/* ── Mobile card list (hidden on md+) ── */}
              <div className="md:hidden space-y-3 pb-3">
                {pagedCampaigns.map((campaign) => (
                  <div key={campaign.id} className="border border-gray-100 rounded-lg p-3 hover:bg-gray-50 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <Link to={`/campaigns/${campaign.id}`} className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 text-sm truncate">{campaign.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{campaign.subject}</p>
                        {tagsOf(campaign.id).length > 0 && (
                          <div className="mt-1"><TagList tags={tagsOf(campaign.id)} /></div>
                        )}
                      </Link>
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, campaign }); }}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                        title={`Delete ${campaign.name}`}
                        aria-label={`Delete campaign ${campaign.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                      <StatusBadge status={campaign.status} />
                      <span>{(campaignRecipientCount(campaign) || 0).toLocaleString()} recipients</span>
                      <span>{formatDate(campaign.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Desktop table (hidden below md, structure UNCHANGED) ── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    {sortHeader('name', 'Campaign')}
                    {sortHeader('status', 'Status')}
                    {sortHeader('recipients', 'Recipients')}
                    {sortHeader('created', 'Created')}
                    <th className="py-3 px-4"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedCampaigns.map((campaign) => (
                    <tr key={campaign.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4">
                        <Link to={`/campaigns/${campaign.id}`} className="block">
                          <p className="font-medium text-gray-900 text-sm hover:text-black">{campaign.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5 truncate max-w-sm">{campaign.subject}</p>
                        </Link>
                        {tagsOf(campaign.id).length > 0 && (
                          <div className="mt-1"><TagList tags={tagsOf(campaign.id)} max={4} /></div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge status={campaign.status} />
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-700">
                        {(campaignRecipientCount(campaign) || 0).toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-500">
                        {formatDate(campaign.createdAt)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteModal({ open: true, campaign });
                          }}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title={`Delete ${campaign.name}`}
                          aria-label={`Delete campaign ${campaign.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <nav className="flex items-center justify-between gap-3 py-3 text-sm text-gray-600" aria-label="Campaign pages">
                <span>
                  {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredCampaigns.length)} of {filteredCampaigns.length}
                </span>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={currentPage <= 1} onClick={() => setParam('page', String(currentPage - 1), false)}>
                    Previous
                  </Button>
                  <span>Page {currentPage} of {pageCount}</span>
                  <Button variant="secondary" size="sm" disabled={currentPage >= pageCount} onClick={() => setParam('page', String(currentPage + 1), false)}>
                    Next
                  </Button>
                </div>
              </nav>
            )}
            </>
          ) : (
            <EmptyState
              icon={<Mail className="w-8 h-8 text-gray-400" />}
              title="No campaigns found"
              description={
                scopeSmtpProfileId != null &&
                campaigns.length > 0 &&
                scopedCampaigns.length === 0 &&
                !searchQuery &&
                statusFilter === 'all'
                  ? 'No campaigns use the SMTP profile selected in Settings → Reports and inbox scope. Switch to “All SMTP accounts” or assign that SMTP to a campaign.'
                  : searchQuery || statusFilter !== 'all' || tagFilter != null
                    ? "Try adjusting your filters to find what you're looking for."
                    : 'Get started by creating your first email campaign.'
              }
              action={
                !searchQuery && statusFilter === 'all' && tagFilter == null && !(scopeSmtpProfileId != null && campaigns.length > 0 && scopedCampaigns.length === 0) ? (
                  <Link to="/campaigns/create">
                    <Button leftIcon={<Plus className="w-4 h-4" />}>Create Campaign</Button>
                  </Link>
                ) : undefined
              }
            />
          )}
        </CardContent>
      </Card>

      <Modal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, campaign: null })}
        title="Delete Campaign"
      >
        <div className="space-y-4">
          <p className="text-gray-600">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-gray-900">"{deleteModal.campaign?.name}"</span>? This
            action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <Button
              variant="secondary"
              onClick={() => setDeleteModal({ open: false, campaign: null })}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} isLoading={isDeleting} disabled={isDeleting}>
              Delete Campaign
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
