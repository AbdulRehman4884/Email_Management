import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  Search,
  Mail,
  Trash2,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import {
  Button,
  Card,
  CardContent,
  StatusBadge,
  PageLoader,
  EmptyState,
  Modal,
} from '../components/ui';
import type { Campaign, CampaignStatus } from '../types';

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

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | 'all'>('all');
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; campaign: Campaign | null }>({
    open: false,
    campaign: null,
  });

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const filteredCampaigns = campaigns
    .filter((campaign) => {
      const matchesSearch =
        campaign.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        campaign.subject.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || campaign.status === statusFilter;
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => {
      const tb = new Date(b.updatedAt || b.createdAt).getTime();
      const ta = new Date(a.updatedAt || a.createdAt).getTime();
      return tb - ta;
    });

  const handleDelete = async () => {
    if (!deleteModal.campaign) return;
    try {
      await deleteCampaign(deleteModal.campaign.id);
      setDeleteModal({ open: false, campaign: null });
    } catch (error) {
      console.error('Failed to delete campaign:', error);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-CA');
  };

  if (isLoading && campaigns.length === 0) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
          <p className="text-gray-500 mt-1">{campaigns.length} campaigns total</p>
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
                placeholder="Search campaigns..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent"
              />
            </div>
            {/* Status tabs — scrollable on mobile, same appearance on desktop */}
            <div className="overflow-x-auto">
              <div className="flex items-center gap-0.5 min-w-max">
                {STATUS_TABS.map((tab) => (
                  <button
                    key={tab.value}
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
            </div>
          </div>

          {filteredCampaigns.length > 0 ? (
            <>
            {/* ── Mobile card view (hidden on md+) ── */}
            <div className="md:hidden space-y-2 pb-2">
              {filteredCampaigns.map((campaign) => (
                <div key={campaign.id} className="border border-gray-100 rounded-xl p-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/campaigns/${campaign.id}`} className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm leading-snug">{campaign.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{campaign.subject}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                        <span>{(campaign.recieptCount || 0).toLocaleString()} recipients</span>
                        <span>·</span>
                        <span>{formatDate(campaign.createdAt)}</span>
                      </div>
                    </Link>
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <StatusBadge status={campaign.status} />
                      <button
                        onClick={(e) => { e.stopPropagation(); setDeleteModal({ open: true, campaign }); }}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* ── Desktop table view (hidden below md, unchanged layout) ── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Campaign</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Recipients</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Created</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCampaigns.map((campaign) => (
                    <tr key={campaign.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4">
                        <Link to={`/campaigns/${campaign.id}`} className="block">
                          <p className="font-medium text-gray-900 text-sm hover:text-black">{campaign.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5 truncate max-w-sm">{campaign.subject}</p>
                        </Link>
                      </td>
                      <td className="py-3 px-4">
                        <StatusBadge status={campaign.status} />
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-700">
                        {(campaign.recieptCount || 0).toLocaleString()}
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
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          ) : (
            <EmptyState
              icon={<Mail className="w-8 h-8 text-gray-400" />}
              title="No campaigns found"
              description={
                searchQuery || statusFilter !== 'all'
                  ? "Try adjusting your filters to find what you're looking for."
                  : 'Get started by creating your first email campaign.'
              }
              action={
                !searchQuery && statusFilter === 'all' ? (
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
            <Button variant="danger" onClick={handleDelete}>
              Delete Campaign
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
