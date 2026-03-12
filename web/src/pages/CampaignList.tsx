import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus,
  Search,
  Filter,
  Mail,
  MoreVertical,
  Play,
  Pause,
  Trash2,
  Eye,
  Edit,
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

export function CampaignList() {
  const {
    campaigns,
    isLoading,
    fetchCampaigns,
    deleteCampaign,
    startCampaign,
    pauseCampaign,
    resumeCampaign,
  } = useCampaignStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<CampaignStatus | 'all'>('all');
  const [deleteModal, setDeleteModal] = useState<{ open: boolean; campaign: Campaign | null }>({
    open: false,
    campaign: null,
  });
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  useEffect(() => {
    fetchCampaigns();
  }, [fetchCampaigns]);

  const filteredCampaigns = campaigns.filter((campaign) => {
    const matchesSearch =
      campaign.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      campaign.subject.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || campaign.status === statusFilter;
    return matchesSearch && matchesStatus;
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

  const handleStartPause = async (campaign: Campaign) => {
    setActionLoading(campaign.id);
    try {
      if (campaign.status === 'draft' || campaign.status === 'scheduled') {
        await startCampaign(campaign.id);
      } else if (campaign.status === 'in_progress') {
        await pauseCampaign(campaign.id);
      } else if (campaign.status === 'paused') {
        await resumeCampaign(campaign.id);
      }
    } catch (error) {
      console.error('Failed to update campaign:', error);
    }
    setActionLoading(null);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (isLoading && campaigns.length === 0) {
    return <PageLoader />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Campaigns</h1>
          <p className="text-gray-400 mt-1">Manage and monitor your email campaigns</p>
        </div>
        <Link to="/campaigns/create">
          <Button leftIcon={<Plus className="w-4 h-4" />}>New Campaign</Button>
        </Link>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
              <input
                type="text"
                placeholder="Search campaigns..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-12 pr-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-5 h-5 text-gray-500" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as CampaignStatus | 'all')}
                className="px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">All Status</option>
                <option value="draft">Draft</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In Progress</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Campaign List */}
      {filteredCampaigns.length > 0 ? (
        <div className="grid gap-4">
          {filteredCampaigns.map((campaign) => (
            <Card key={campaign.id} hover>
              <CardContent>
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="flex items-start space-x-4">
                    <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Mail className="w-6 h-6 text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3 flex-wrap">
                        <Link
                          to={`/campaigns/${campaign.id}`}
                          className="text-lg font-semibold text-white hover:text-indigo-400 transition-colors truncate"
                        >
                          {campaign.name}
                        </Link>
                        <StatusBadge status={campaign.status} />
                      </div>
                      <p className="text-sm text-gray-400 mt-1 truncate">
                        Subject: {campaign.subject}
                      </p>
                      <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                        <span>{campaign.recieptCount || 0} recipients</span>
                        <span>•</span>
                        <span>Created {formatDate(campaign.createdAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 lg:flex-shrink-0">
                    {(campaign.status === 'draft' ||
                      campaign.status === 'scheduled' ||
                      campaign.status === 'paused') && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleStartPause(campaign)}
                        isLoading={actionLoading === campaign.id}
                        leftIcon={<Play className="w-4 h-4" />}
                      >
                        {campaign.status === 'paused' ? 'Resume' : 'Start'}
                      </Button>
                    )}
                    {campaign.status === 'in_progress' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleStartPause(campaign)}
                        isLoading={actionLoading === campaign.id}
                        leftIcon={<Pause className="w-4 h-4" />}
                      >
                        Pause
                      </Button>
                    )}
                    <Link to={`/campaigns/${campaign.id}`}>
                      <Button variant="ghost" size="sm" leftIcon={<Eye className="w-4 h-4" />}>
                        View
                      </Button>
                    </Link>
                    {campaign.status === 'draft' && (
                      <Link to={`/campaigns/${campaign.id}/edit`}>
                        <Button variant="ghost" size="sm" leftIcon={<Edit className="w-4 h-4" />}>
                          Edit
                        </Button>
                      </Link>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteModal({ open: true, campaign })}
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Mail className="w-8 h-8 text-gray-500" />}
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
        </Card>
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, campaign: null })}
        title="Delete Campaign"
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-white">"{deleteModal.campaign?.name}"</span>? This
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
