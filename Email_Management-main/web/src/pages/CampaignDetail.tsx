import React, { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, Play, Pause, RotateCcw, Edit, Trash2, Upload, Send, CheckCircle,
  AlertTriangle, Users, Mail, Clock, FileText, RefreshCw, MailOpen, MessageCircle,
  ChevronLeft, ChevronRight, X,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Card, CardContent, CardHeader, StatusBadge, PageLoader, StatsCard, Modal, Alert } from '../components/ui';
import type { CampaignStats } from '../types';

export function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    currentCampaign, currentStats, recipients, recipientsTotal, isLoading, error,
    fetchCampaign, fetchStats, fetchRecipients, startCampaign, pauseCampaign,
    resumeCampaign, deleteCampaign, uploadRecipients, markRecipientReplied,
    deleteRecipient, clearError, clearCurrentCampaign,
  } = useCampaignStore();

  const PAGE_SIZE = 50;
  const [currentPage, setCurrentPage] = useState(1);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const campaignId = Number(id);
  const totalPages = Math.max(1, Math.ceil(recipientsTotal / PAGE_SIZE));

  useEffect(() => {
    if (campaignId) { fetchCampaign(campaignId); fetchStats(campaignId); fetchRecipients(campaignId, 1, PAGE_SIZE); }
    return () => { clearCurrentCampaign(); };
  }, [campaignId, fetchCampaign, fetchStats, fetchRecipients, clearCurrentCampaign]);

  useEffect(() => {
    const active = currentCampaign?.status === 'in_progress' || currentCampaign?.status === 'paused' || currentCampaign?.status === 'completed';
    if (active) {
      const interval = setInterval(() => { fetchStats(campaignId); fetchRecipients(campaignId, currentPage, PAGE_SIZE); }, 5000);
      return () => clearInterval(interval);
    }
  }, [currentCampaign?.status, campaignId, currentPage, fetchStats, fetchRecipients]);

  useEffect(() => {
    if (campaignId) fetchRecipients(campaignId, currentPage, PAGE_SIZE);
  }, [currentPage, campaignId, fetchRecipients]);

  const handleRefresh = async () => { setRefreshing(true); await Promise.all([fetchCampaign(campaignId), fetchStats(campaignId), fetchRecipients(campaignId, currentPage, PAGE_SIZE)]); setRefreshing(false); };
  const handleAction = async (action: 'start' | 'pause' | 'resume') => {
    setActionLoading(true);
    try { if (action === 'start') await startCampaign(campaignId); else if (action === 'pause') await pauseCampaign(campaignId); else await resumeCampaign(campaignId); } catch {}
    setActionLoading(false);
  };
  const handleDelete = async () => { try { await deleteCampaign(campaignId); navigate('/campaigns'); } catch {} };
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) return;
    try { const result = await uploadRecipients(campaignId, file); setUploadSuccess(`Added ${result.addedCount} recipients`); setCurrentPage(1); fetchRecipients(campaignId, 1, PAGE_SIZE); setTimeout(() => setUploadSuccess(null), 5000); } catch {}
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const formatDate = (d: string, withTime = true) => {
    const normalized = d.replace(' ', 'T');
    const isDateOnly = normalized.length <= 10;
    if (isDateOnly) {
      const [y, m, day] = normalized.split('-');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${months[parseInt(m!) - 1]} ${parseInt(day!)}, ${y}`;
    }
    return new Date(normalized).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    });
  };
  const handleDeleteRecipient = async (recipientId: number) => {
    try {
      await deleteRecipient(campaignId, recipientId);
      const newTotal = recipientsTotal - 1;
      const newTotalPages = Math.max(1, Math.ceil(newTotal / PAGE_SIZE));
      if (currentPage > newTotalPages) setCurrentPage(newTotalPages);
    } catch {}
  };

  const getDeliveryRate = (s: CampaignStats | null) => (!s || s.sentCount === 0) ? 0 : Math.round((s.delieveredCount / s.sentCount) * 100);

  if (isLoading && !currentCampaign) return <PageLoader />;
  if (!currentCampaign) return (
    <div className="text-center py-12">
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Campaign not found</h2>
      <p className="text-gray-500 mb-4">The campaign you're looking for doesn't exist.</p>
      <Link to="/campaigns"><Button>Back to Campaigns</Button></Link>
    </div>
  );

  const canStart = currentCampaign.status === 'draft' || currentCampaign.status === 'scheduled';
  const canPause = currentCampaign.status === 'in_progress';
  const canResume = currentCampaign.status === 'paused';
  const canEdit = currentCampaign.status === 'draft';

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <button onClick={() => navigate('/campaigns')} className="flex items-center text-gray-500 hover:text-gray-900 mb-2 text-sm transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Campaigns
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{currentCampaign.name}</h1>
            <StatusBadge status={currentCampaign.status} />
          </div>
          <p className="text-gray-500 mt-1 text-sm">Created on {formatDate(currentCampaign.createdAt)}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={handleRefresh} isLoading={refreshing} leftIcon={<RefreshCw className="w-4 h-4" />}>Refresh</Button>
          {canStart && <Button size="sm" onClick={() => handleAction('start')} isLoading={actionLoading} leftIcon={<Play className="w-4 h-4" />}>Start</Button>}
          {canPause && <Button variant="secondary" size="sm" onClick={() => handleAction('pause')} isLoading={actionLoading} leftIcon={<Pause className="w-4 h-4" />}>Pause</Button>}
          {canResume && <Button size="sm" onClick={() => handleAction('resume')} isLoading={actionLoading} leftIcon={<RotateCcw className="w-4 h-4" />}>Resume</Button>}
          {canEdit && <Link to={`/campaigns/${campaignId}/edit`}><Button variant="secondary" size="sm" leftIcon={<Edit className="w-4 h-4" />}>Edit</Button></Link>}
          <button onClick={() => setDeleteModalOpen(true)} className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><Trash2 className="w-4 h-4" /></button>
        </div>
      </div>

      {error && <Alert type="error" message={error} onClose={clearError} />}
      {uploadSuccess && <Alert type="success" message={uploadSuccess} />}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatsCard title="Recipients" value={currentCampaign.recieptCount || 0} icon={Users} iconColor="text-blue-500" iconBgColor="bg-blue-50" />
        <StatsCard title="Sent" value={currentStats?.sentCount || 0} icon={Send} iconColor="text-gray-500" iconBgColor="bg-gray-100" />
        <StatsCard title="Delivered" value={currentStats?.delieveredCount || 0} change={currentStats ? `${getDeliveryRate(currentStats)}%` : undefined} changeType="positive" icon={CheckCircle} iconColor="text-green-500" iconBgColor="bg-green-50" />
        <StatsCard title="Opened" value={currentStats?.openedCount ?? 0} icon={MailOpen} iconColor="text-blue-500" iconBgColor="bg-blue-50" />
        <StatsCard title="Replied" value={currentStats?.repliedCount ?? 0} icon={MessageCircle} iconColor="text-green-500" iconBgColor="bg-green-50" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><h2 className="text-base font-semibold text-gray-900">Campaign Details</h2></CardHeader>
          <CardContent className="space-y-3">
            <div><p className="text-xs text-gray-500 uppercase tracking-wide">Subject</p><p className="text-gray-900 text-sm mt-0.5">{currentCampaign.subject}</p></div>
            <div className="grid grid-cols-2 gap-4">
              <div><p className="text-xs text-gray-500 uppercase tracking-wide">From Name</p><p className="text-gray-900 text-sm mt-0.5">{currentCampaign.fromName}</p></div>
              <div><p className="text-xs text-gray-500 uppercase tracking-wide">From Email</p><p className="text-gray-900 text-sm mt-0.5">{currentCampaign.fromEmail}</p></div>
            </div>
            {currentCampaign.scheduledAt && (
              <div><p className="text-xs text-gray-500 uppercase tracking-wide">Scheduled</p><p className="text-gray-900 text-sm mt-0.5 flex items-center"><Clock className="w-3.5 h-3.5 mr-1 text-gray-400" />{formatDate(currentCampaign.scheduledAt)}</p></div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><h2 className="text-base font-semibold text-gray-900">Issues & Metrics</h2></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg"><p className="text-2xl font-bold text-red-500">{currentStats?.failedCount || 0}</p><p className="text-xs text-gray-500 mt-1">Failed</p></div>
              <div className="p-4 bg-gray-50 rounded-lg"><p className="text-2xl font-bold text-orange-500">{currentStats?.complainedCount || 0}</p><p className="text-xs text-gray-500 mt-1">Complaints</p></div>
              <div className="p-4 bg-gray-50 rounded-lg col-span-2"><p className="text-2xl font-bold text-green-600">{getDeliveryRate(currentStats)}%</p><p className="text-xs text-gray-500 mt-1">Delivery Rate</p></div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><h2 className="text-base font-semibold text-gray-900">Email Content</h2></CardHeader>
        <CardContent>
          <p className="text-xs text-gray-500 mb-2">Preview of the message recipients will receive.</p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
            <iframe
              title="Campaign email preview"
              className="w-full min-h-[400px] border-0 bg-white"
              sandbox="allow-same-origin"
              srcDoc={currentCampaign.emailContent}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Recipients ({recipientsTotal})</h2>
            {canEdit && (
              <>
                <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} className="hidden" />
                <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} isLoading={isLoading} leftIcon={<Upload className="w-4 h-4" />}>Upload CSV</Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {recipients.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Email</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Sent</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Opened</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Replied</th>
                  <th className="py-2 px-3"></th>
                </tr></thead>
                <tbody>
                  {recipients.map((r) => (
                    <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 px-3 text-sm text-gray-900">{r.email}</td>
                      <td className="py-2 px-3 text-sm text-gray-500">{r.name || '-'}</td>
                      <td className="py-2 px-3">
                        <span className={`text-xs font-medium ${r.status === 'sent' || r.status === 'delivered' ? 'text-green-600' : r.status === 'pending' ? 'text-yellow-600' : 'text-red-500'}`}>{r.status}</span>
                      </td>
                      <td className="py-2 px-3 text-xs text-gray-500">{r.sentAt ? formatDate(r.sentAt) : '-'}</td>
                      <td className="py-2 px-3 text-xs text-gray-500">{r.openedAt ? formatDate(r.openedAt) : '-'}</td>
                      <td className="py-2 px-3 text-xs text-gray-500">{r.repliedAt ? formatDate(r.repliedAt) : '-'}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2 justify-end">
                          {(r.status === 'sent' || r.status === 'delivered') && !r.repliedAt && (
                            <button onClick={() => markRecipientReplied(campaignId, r.id)} className="text-xs text-blue-600 hover:text-blue-800">Mark replied</button>
                          )}
                          {canEdit && (
                            <button onClick={() => handleDeleteRecipient(r.id)} className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors" title="Remove recipient">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {recipientsTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between pt-3 border-t border-gray-100 mt-1">
                  <p className="text-xs text-gray-500">
                    Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, recipientsTotal)} of {recipientsTotal}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-gray-700 font-medium px-1">Page {currentPage} of {totalPages}</span>
                    <button
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      disabled={currentPage >= totalPages}
                      className="p-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <Users className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 text-sm mb-3">No recipients uploaded yet</p>
              {canEdit && <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} leftIcon={<Upload className="w-4 h-4" />}>Upload Recipients</Button>}
            </div>
          )}
        </CardContent>
      </Card>

      <Modal isOpen={deleteModalOpen} onClose={() => setDeleteModalOpen(false)} title="Delete Campaign">
        <div className="space-y-4">
          <p className="text-gray-600">Are you sure you want to delete <span className="font-semibold text-gray-900">"{currentCampaign.name}"</span>? This cannot be undone.</p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
