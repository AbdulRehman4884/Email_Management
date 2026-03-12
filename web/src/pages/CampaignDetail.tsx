import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Edit,
  Trash2,
  Upload,
  Send,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Users,
  Mail,
  Clock,
  FileText,
  RefreshCw,
  MailOpen,
  MessageCircle,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  StatusBadge,
  PageLoader,
  StatsCard,
  Modal,
  Alert,
} from '../components/ui';
import type { CampaignStats } from '../types';

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    currentCampaign,
    currentStats,
    recipients,
    recipientsTotal,
    isLoading,
    error,
    fetchCampaign,
    fetchStats,
    fetchRecipients,
    startCampaign,
    pauseCampaign,
    resumeCampaign,
    deleteCampaign,
    uploadRecipients,
    markRecipientReplied,
    clearError,
    clearCurrentCampaign,
  } = useCampaignStore();

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const campaignId = Number(id);

  useEffect(() => {
    if (campaignId) {
      fetchCampaign(campaignId);
      fetchStats(campaignId);
      fetchRecipients(campaignId);
    }

    return () => {
      clearCurrentCampaign();
    };
  }, [campaignId, fetchCampaign, fetchStats, fetchRecipients, clearCurrentCampaign]);

  // Auto-refresh stats and recipients for live open/reply updates
  useEffect(() => {
    const active = currentCampaign?.status === 'in_progress' || currentCampaign?.status === 'paused' || currentCampaign?.status === 'completed';
    if (active) {
      const interval = setInterval(() => {
        fetchStats(campaignId);
        fetchRecipients(campaignId);
      }, 5000); // Every 5 seconds for near-live updates
      return () => clearInterval(interval);
    }
  }, [currentCampaign?.status, campaignId, fetchStats, fetchRecipients]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      fetchCampaign(campaignId),
      fetchStats(campaignId),
      fetchRecipients(campaignId),
    ]);
    setRefreshing(false);
  };

  const handleAction = async (action: 'start' | 'pause' | 'resume') => {
    setActionLoading(true);
    try {
      switch (action) {
        case 'start':
          await startCampaign(campaignId);
          break;
        case 'pause':
          await pauseCampaign(campaignId);
          break;
        case 'resume':
          await resumeCampaign(campaignId);
          break;
      }
    } catch (err) {
      // Error handled by store
    }
    setActionLoading(false);
  };

  const handleDelete = async () => {
    try {
      await deleteCampaign(campaignId);
      navigate('/campaigns');
    } catch (err) {
      // Error handled by store
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    try {
      const result = await uploadRecipients(campaignId, file);
      setUploadSuccess(`Successfully added ${result.addedCount} recipients`);
      fetchRecipients(campaignId);
      setTimeout(() => setUploadSuccess(null), 5000);
    } catch (err) {
      // Error handled by store
    }
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const getDeliveryRate = (stats: CampaignStats | null) => {
    if (!stats || stats.sentCount === 0) return 0;
    return Math.round((stats.delieveredCount / stats.sentCount) * 100);
  };

  if (isLoading && !currentCampaign) {
    return <PageLoader />;
  }

  if (!currentCampaign) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-white mb-2">Campaign not found</h2>
        <p className="text-gray-400 mb-4">The campaign you're looking for doesn't exist.</p>
        <Link to="/campaigns">
          <Button>Back to Campaigns</Button>
        </Link>
      </div>
    );
  }

  const canStart = currentCampaign.status === 'draft' || currentCampaign.status === 'scheduled';
  const canPause = currentCampaign.status === 'in_progress';
  const canResume = currentCampaign.status === 'paused';
  const canEdit = currentCampaign.status === 'draft';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <button
            onClick={() => navigate('/campaigns')}
            className="flex items-center text-gray-400 hover:text-white mb-2 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Campaigns
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white">{currentCampaign.name}</h1>
            <StatusBadge status={currentCampaign.status} />
          </div>
          <p className="text-gray-400 mt-1">
            Created on {formatDate(currentCampaign.createdAt)}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            isLoading={refreshing}
            leftIcon={<RefreshCw className="w-4 h-4" />}
          >
            Refresh
          </Button>

          {canStart && (
            <Button
              onClick={() => handleAction('start')}
              isLoading={actionLoading}
              leftIcon={<Play className="w-4 h-4" />}
            >
              Start Campaign
            </Button>
          )}

          {canPause && (
            <Button
              variant="secondary"
              onClick={() => handleAction('pause')}
              isLoading={actionLoading}
              leftIcon={<Pause className="w-4 h-4" />}
            >
              Pause
            </Button>
          )}

          {canResume && (
            <Button
              onClick={() => handleAction('resume')}
              isLoading={actionLoading}
              leftIcon={<RotateCcw className="w-4 h-4" />}
            >
              Resume
            </Button>
          )}

          {canEdit && (
            <Link to={`/campaigns/${campaignId}/edit`}>
              <Button variant="secondary" leftIcon={<Edit className="w-4 h-4" />}>
                Edit
              </Button>
            </Link>
          )}

          <Button
            variant="ghost"
            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
            onClick={() => setDeleteModalOpen(true)}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {error && <Alert type="error" message={error} onClose={clearError} />}
      {uploadSuccess && <Alert type="success" message={uploadSuccess} />}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatsCard
          title="Total Recipients"
          value={currentCampaign.recieptCount || 0}
          icon={Users}
          iconColor="text-blue-400"
          iconBgColor="bg-blue-500/20"
        />
        <StatsCard
          title="Emails Sent"
          value={currentStats?.sentCount || 0}
          icon={Send}
          iconColor="text-indigo-400"
          iconBgColor="bg-indigo-500/20"
        />
        <StatsCard
          title="Delivered"
          value={currentStats?.delieveredCount || 0}
          change={currentStats ? `${getDeliveryRate(currentStats)}% delivery rate` : undefined}
          changeType="positive"
          icon={CheckCircle}
          iconColor="text-green-400"
          iconBgColor="bg-green-500/20"
        />
        <StatsCard
          title="Opened"
          value={currentStats?.openedCount ?? 0}
          icon={MailOpen}
          iconColor="text-cyan-400"
          iconBgColor="bg-cyan-500/20"
        />
        <StatsCard
          title="Replied"
          value={currentStats?.repliedCount ?? 0}
          icon={MessageCircle}
          iconColor="text-emerald-400"
          iconBgColor="bg-emerald-500/20"
        />
        <StatsCard
          title="Bounced"
          value={currentStats?.bouncedCount || 0}
          icon={XCircle}
          iconColor="text-red-400"
          iconBgColor="bg-red-500/20"
        />
      </div>

      {/* Additional Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Campaign Details */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-white flex items-center">
              <Mail className="w-5 h-5 mr-2 text-indigo-400" />
              Campaign Details
            </h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-gray-400 mb-1">Subject</p>
              <p className="text-white">{currentCampaign.subject}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-400 mb-1">From Name</p>
                <p className="text-white">{currentCampaign.fromName}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">From Email</p>
                <p className="text-white">{currentCampaign.fromEmail}</p>
              </div>
            </div>
            {currentCampaign.scheduledAt && (
              <div>
                <p className="text-sm text-gray-400 mb-1">Scheduled For</p>
                <p className="text-white flex items-center">
                  <Clock className="w-4 h-4 mr-2 text-gray-500" />
                  {formatDate(currentCampaign.scheduledAt)}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Performance Metrics */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-white flex items-center">
              <AlertTriangle className="w-5 h-5 mr-2 text-yellow-400" />
              Issues & Metrics
            </h2>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-gray-800/50 rounded-xl">
                <p className="text-2xl font-bold text-red-400">
                  {currentStats?.failedCount || 0}
                </p>
                <p className="text-sm text-gray-400">Failed</p>
              </div>
              <div className="p-4 bg-gray-800/50 rounded-xl">
                <p className="text-2xl font-bold text-orange-400">
                  {currentStats?.complainedCount || 0}
                </p>
                <p className="text-sm text-gray-400">Complaints</p>
              </div>
              <div className="p-4 bg-gray-800/50 rounded-xl col-span-2">
                <p className="text-2xl font-bold text-green-400">
                  {getDeliveryRate(currentStats)}%
                </p>
                <p className="text-sm text-gray-400">Delivery Rate</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Email Content Preview */}
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-white flex items-center">
            <FileText className="w-5 h-5 mr-2 text-purple-400" />
            Email Content Preview
          </h2>
        </CardHeader>
        <CardContent>
          <div className="bg-gray-800 rounded-xl p-4 overflow-auto max-h-96">
            <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono">
              {currentCampaign.emailContent}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Recipients Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white flex items-center">
              <Users className="w-5 h-5 mr-2 text-blue-400" />
              Recipients ({recipientsTotal})
            </h2>
            {canEdit && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  isLoading={isLoading}
                  leftIcon={<Upload className="w-4 h-4" />}
                >
                  Upload CSV
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {recipients.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Email</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Name</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Status</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Sent At</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Opened</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Replied</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-gray-400"></th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.slice(0, 10).map((recipient) => (
                    <tr key={recipient.id} className="border-b border-gray-800/50">
                      <td className="py-3 px-4 text-white">{recipient.email}</td>
                      <td className="py-3 px-4 text-gray-400">{recipient.name || '-'}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-lg ${
                            recipient.status === 'sent' || recipient.status === 'delivered'
                              ? 'bg-green-500/20 text-green-400'
                              : recipient.status === 'pending'
                              ? 'bg-yellow-500/20 text-yellow-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {recipient.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-gray-500">
                        {recipient.sentAt ? formatDate(recipient.sentAt) : '-'}
                      </td>
                      <td className="py-3 px-4 text-gray-500">
                        {recipient.openedAt ? formatDate(recipient.openedAt) : '-'}
                      </td>
                      <td className="py-3 px-4 text-gray-500">
                        {recipient.repliedAt ? formatDate(recipient.repliedAt) : '-'}
                      </td>
                      <td className="py-3 px-4">
                        {(recipient.status === 'sent' || recipient.status === 'delivered') && !recipient.repliedAt && (
                          <button
                            type="button"
                            onClick={() => markRecipientReplied(campaignId, recipient.id)}
                            className="text-xs text-indigo-400 hover:text-indigo-300"
                          >
                            Mark replied
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {recipientsTotal > 10 && (
                <p className="text-center text-gray-500 text-sm mt-4">
                  Showing 10 of {recipientsTotal} recipients
                </p>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <Users className="w-12 h-12 text-gray-600 mx-auto mb-4" />
              <p className="text-gray-400 mb-4">No recipients uploaded yet</p>
              {canEdit && (
                <Button
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  leftIcon={<Upload className="w-4 h-4" />}
                >
                  Upload Recipients
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Modal */}
      <Modal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Campaign"
      >
        <div className="space-y-4">
          <p className="text-gray-300">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-white">"{currentCampaign.name}"</span>? This
            action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>
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
