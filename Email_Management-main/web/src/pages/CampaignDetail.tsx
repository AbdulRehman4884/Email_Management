import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import axios from 'axios';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { formatLocalScheduleDisplay } from '../lib/localScheduleFormat';
import {
  ArrowLeft, Play, Pause, RotateCcw, Edit, Trash2, Upload, Send,
  AlertTriangle, Users, Mail, Clock, FileText, RefreshCw, MailOpen, MessageCircle,
  ChevronLeft, ChevronRight, X, Plus, Pencil,
} from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Card, CardContent, CardHeader, StatusBadge, PageLoader, StatsCard, Modal, Alert, useToast } from '../components/ui';
import type { CampaignStats, FollowUpTemplate, PlaceholderValidation } from '../types';
import { sanitizeHtmlForIframe, previewFollowUpBodyAsSrcDoc } from '../lib/emailPreview';
import { campaignApi, repliesApi } from '../lib/api';

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
  const toast = useToast();
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [validationModalOpen, setValidationModalOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<PlaceholderValidation | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const campaignId = Number(id);
  const totalPages = Math.max(1, Math.ceil(recipientsTotal / PAGE_SIZE));
  const [systemNotificationTotal, setSystemNotificationTotal] = useState(0);
  const [actualRepliesTotal, setActualRepliesTotal] = useState(0);
  const [recipientFilter, setRecipientFilter] = useState<'all' | 'delivered' | 'opened' | 'replied'>('all');
  const recipientsRef = useRef<HTMLDivElement>(null);

  const [fuModalOpen, setFuModalOpen] = useState(false);
  const [fuEditing, setFuEditing] = useState<FollowUpTemplate | null>(null);
  const [fuForm, setFuForm] = useState({ title: '', subject: '', body: '' });
  const [fuSaving, setFuSaving] = useState(false);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [conflictOtherName, setConflictOtherName] = useState('');
  const [pendingAction, setPendingAction] = useState<'start' | 'resume' | null>(null);

  const scrollRecipientsIntoView = () => {
    const run = () => {
      recipientsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
  };

  const handleFilterClick = (filter: 'all' | 'delivered' | 'opened' | 'replied') => {
    setRecipientFilter(filter);
    setCurrentPage(1);
    scrollRecipientsIntoView();
  };

  const fetchReplyTotals = async () => {
    try {
      const [systemResult, repliesResult] = await Promise.all([
        repliesApi.getReplies({ campaignId, page: 1, limit: 1, kind: 'system' }),
        repliesApi.getReplies({ campaignId, page: 1, limit: 1, kind: 'replies' }),
      ]);
      setSystemNotificationTotal(systemResult.total);
      setActualRepliesTotal(repliesResult.total);
    } catch {
      // Non-critical: card totals just fall back to 0.
      setSystemNotificationTotal(0);
      setActualRepliesTotal(0);
    }
  };

  // Reset list state when switching campaigns only (not when filter changes).
  useLayoutEffect(() => {
    setCurrentPage(1);
    setRecipientFilter('all');
  }, [campaignId]);

  useEffect(() => {
    if (!campaignId) return;
    fetchCampaign(campaignId);
    fetchStats(campaignId);
    return () => {
      clearCurrentCampaign();
    };
  }, [campaignId, fetchCampaign, fetchStats, clearCurrentCampaign]);

  useEffect(() => {
    if (!campaignId) return;
    void fetchReplyTotals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    const active = currentCampaign?.status === 'in_progress' || currentCampaign?.status === 'paused' || currentCampaign?.status === 'completed';
    if (active) {
      const interval = setInterval(() => {
        fetchStats(campaignId);
        fetchRecipients(campaignId, currentPage, PAGE_SIZE, recipientFilter);
        void fetchReplyTotals();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [currentCampaign?.status, campaignId, currentPage, fetchStats, fetchRecipients, recipientFilter]);

  useEffect(() => {
    if (campaignId) fetchRecipients(campaignId, currentPage, PAGE_SIZE, recipientFilter);
  }, [currentPage, campaignId, fetchRecipients, recipientFilter]);

  const handleRefresh = async () => { setRefreshing(true); await Promise.all([fetchCampaign(campaignId), fetchStats(campaignId), fetchRecipients(campaignId, currentPage, PAGE_SIZE, recipientFilter)]); setRefreshing(false); };
  const runStartOrResume = async (action: 'start' | 'resume', force: boolean) => {
    if (action === 'start') {
      try {
        const validation = await campaignApi.validatePlaceholders(campaignId);
        if (!validation.valid) {
          setValidationResult(validation);
          setValidationModalOpen(true);
          return;
        }
      } catch (e) {
        console.warn('Placeholder validation skipped:', e);
      }
      const result = await startCampaign(campaignId, force ? { force: true } : undefined);
      if (result.status === 'scheduled') {
        toast.info(result.message);
      } else {
        toast.success(result.message);
      }
    } else {
      await resumeCampaign(campaignId, force ? { force: true } : undefined);
      toast.success('Campaign resumed successfully');
    }
    await fetchCampaign(campaignId);
  };

  const handleAction = async (action: 'start' | 'pause' | 'resume', force = false) => {
    setActionLoading(true);
    try {
      if (action === 'pause') {
        await pauseCampaign(campaignId);
        toast.info('Campaign paused successfully');
        await fetchCampaign(campaignId);
      } else {
        try {
          await runStartOrResume(action, force);
        } catch (err: unknown) {
          if (axios.isAxiosError(err) && err.response?.status === 409) {
            const data = err.response.data as {
              code?: string;
              conflictCampaignName?: string;
            };
            if (data?.code === 'CAMPAIGN_CONFLICT') {
              setConflictOtherName(String(data.conflictCampaignName ?? 'Another campaign'));
              setPendingAction(action);
              setConflictModalOpen(true);
              setActionLoading(false);
              return;
            }
          }
          if (axios.isAxiosError(err) && err.response?.status === 400) {
            const data = err.response.data as { code?: string; error?: string };
            if (data?.code === 'SMTP_DAILY_LIMIT') {
              toast.error(data.error ?? 'Daily send limit reached for this SMTP profile.');
              setActionLoading(false);
              return;
            }
          }
          throw err;
        }
      }
    } catch {
      // store toast
    }
    setActionLoading(false);
  };

  const confirmConflictAndRun = async () => {
    if (!pendingAction) return;
    setConflictModalOpen(false);
    setActionLoading(true);
    try {
      await runStartOrResume(pendingAction, true);
    } catch {
      // handled
    }
    setPendingAction(null);
    setActionLoading(false);
  };
  const handleDelete = async () => { try { await deleteCampaign(campaignId); navigate('/campaigns'); } catch {} };
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) return;
    try { const result = await uploadRecipients(campaignId, file); toast.success(`Added ${result.addedCount} recipients successfully`); setCurrentPage(1); setRecipientFilter('all'); fetchRecipients(campaignId, 1, PAGE_SIZE, 'all'); } catch {}
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
      const newTotal = Math.max(recipientsTotal - 1, 0);
      const newTotalPages = Math.max(1, Math.ceil(newTotal / PAGE_SIZE));
      const targetPage = Math.min(currentPage, newTotalPages);
      await deleteRecipient(campaignId, recipientId, targetPage, PAGE_SIZE, recipientFilter);
      if (targetPage !== currentPage) setCurrentPage(targetPage);
    } catch {}
  };

  const openFuAdd = () => {
    setFuEditing(null);
    setFuForm({ title: '', subject: '', body: '' });
    setFuModalOpen(true);
  };

  const openFuEdit = (t: FollowUpTemplate) => {
    setFuEditing(t);
    setFuForm({ title: t.title, subject: t.subject, body: t.body });
    setFuModalOpen(true);
  };

  const handleToggleAlwaysConfirm = async (alwaysConfirm: boolean) => {
    try {
      await campaignApi.patchFollowUpSettings(campaignId, { followUpSkipConfirm: !alwaysConfirm });
      await fetchCampaign(campaignId);
      toast.success(alwaysConfirm ? 'Confirmation dialog enabled for follow-ups' : 'Quick-send enabled for follow-ups');
    } catch {
      toast.error('Could not update setting');
    }
  };

  const handleSaveFuTemplate = async () => {
    if (!currentCampaign) return;
    const title = fuForm.title.trim();
    const subject = fuForm.subject.trim();
    const body = fuForm.body.trim();
    if (!subject || !body) {
      toast.error('Subject and message are required');
      return;
    }
    setFuSaving(true);
    try {
      const list = [...(currentCampaign.followUpTemplates ?? [])];
      if (fuEditing) {
        const i = list.findIndex((x) => x.id === fuEditing.id);
        if (i >= 0) {
          const prev = list[i]!;
          list[i] = { id: prev.id, title, subject, body };
        }
      } else {
        list.push({ id: crypto.randomUUID(), title, subject, body });
      }
      await campaignApi.patchFollowUpSettings(campaignId, { followUpTemplates: list });
      await fetchCampaign(campaignId);
      toast.success('Follow-up template saved');
      setFuModalOpen(false);
    } catch {
      toast.error('Could not save template');
    } finally {
      setFuSaving(false);
    }
  };

  const deleteFuTemplate = async (templateId: string) => {
    if (!currentCampaign) return;
    try {
      const list = (currentCampaign.followUpTemplates ?? []).filter((t) => t.id !== templateId);
      await campaignApi.patchFollowUpSettings(campaignId, { followUpTemplates: list });
      await fetchCampaign(campaignId);
      toast.success('Template removed');
    } catch {
      toast.error('Could not remove template');
    }
  };

  const insertFuToken = (token: string, field: 'subject' | 'body') => {
    setFuForm((prev) =>
      field === 'subject' ? { ...prev, subject: prev.subject + token } : { ...prev, body: prev.body + token }
    );
  };

  const getDeliveryRate = (s: CampaignStats | null) => (!s || s.sentCount === 0) ? 0 : 100;

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
  const canEdit = currentCampaign.status === 'draft' || currentCampaign.status === 'paused';

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

      {currentCampaign.pauseReason === 'smtp_daily_limit' && (
        <Alert
          type="warning"
          message="Paused: daily send limit reached for this SMTP profile. Edit the campaign to choose another SMTP account, or wait until tomorrow."
        />
      )}
      {currentCampaign.pauseReason === 'daily_campaign_cap' && (
        <Alert type="warning" message="Paused: this campaign's daily send cap was reached. It can auto-resume on the next day at your scheduled time." />
      )}

      <Modal
        isOpen={conflictModalOpen}
        onClose={() => {
          setConflictModalOpen(false);
          setPendingAction(null);
        }}
        title="Another campaign is running"
      >
        <p className="text-gray-600 text-sm mb-4">
          <span className="font-medium">{conflictOtherName}</span> is currently in progress. Pause it and{' '}
          {pendingAction === 'resume' ? 'resume' : 'start'} this campaign instead?
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => { setConflictModalOpen(false); setPendingAction(null); }}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirmConflictAndRun()}>
            Pause other and continue
          </Button>
        </div>
      </Modal>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatsCard title="Recipients" value={currentCampaign.recieptCount || 0} icon={Users} iconColor="text-blue-500" iconBgColor="bg-blue-50" onClick={() => handleFilterClick('all')} />
        <StatsCard title="Delivered" value={currentStats?.sentCount || 0} icon={Send} iconColor="text-gray-500" iconBgColor="bg-gray-100" onClick={() => handleFilterClick('delivered')} />
        <StatsCard title="Opened" value={currentStats?.openedCount ?? 0} icon={MailOpen} iconColor="text-blue-500" iconBgColor="bg-blue-50" onClick={() => handleFilterClick('opened')} />
        {/* Replied: split Inbox-like counts into system notifications vs actual replies */}
        <div
          className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-sm transition-shadow cursor-pointer hover:border-gray-300"
          onClick={() => handleFilterClick('replied')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleFilterClick('replied'); }}
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Replied</p>
              <p className="mt-2 text-3xl font-bold text-gray-900">{actualRepliesTotal}</p>
              <p className="mt-1 text-xs text-gray-500">System notifications: {systemNotificationTotal}</p>
              <p className="mt-0.5 text-[11px] text-gray-400">Actual replies: {actualRepliesTotal}</p>
            </div>
            <div className="p-2 rounded-lg bg-green-50">
              <MessageCircle className="w-5 h-5 text-green-500" />
            </div>
          </div>
        </div>
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
              <div><p className="text-xs text-gray-500 uppercase tracking-wide">Scheduled</p><p className="text-gray-900 text-sm mt-0.5 flex items-center"><Clock className="w-3.5 h-3.5 mr-1 text-gray-400" />{formatLocalScheduleDisplay(currentCampaign.scheduledAt)}</p></div>
            )}
            {currentCampaign.pauseAt && (
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Auto-pauses at</p>
                <p className="text-gray-900 text-sm mt-0.5 flex items-center">
                  <Pause className="w-3.5 h-3.5 mr-1 text-gray-400" />
                  {formatLocalScheduleDisplay(currentCampaign.pauseAt)}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><h2 className="text-base font-semibold text-gray-900">Issues & Metrics</h2></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg"><p className="text-2xl font-bold text-red-500">{currentStats?.failedCount || 0}</p><p className="text-xs text-gray-500 mt-1">Failed</p></div>
              <div className="p-4 bg-gray-50 rounded-lg"><p className="text-2xl font-bold text-orange-500">{currentStats?.complainedCount || 0}</p><p className="text-xs text-gray-500 mt-1">Complaints</p></div>
              {/* <div className="p-4 bg-gray-50 rounded-lg col-span-2"><p className="text-2xl font-bold text-green-600">{getDeliveryRate(currentStats)}%</p><p className="text-xs text-gray-500 mt-1">Delivery Rate</p></div> */}
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
              srcDoc={sanitizeHtmlForIframe(currentCampaign.emailContent)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <h2 className="text-base font-semibold text-gray-900">Follow-up templates</h2>
            <Button type="button" size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={openFuAdd}>
              Add template
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-gray-500">
            Placeholders like {'{email}'}, {'{company}'}, and {'{name}'} use each recipient&apos;s data (same as your main campaign send).
          </p>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 rounded border-gray-300"
              checked={!currentCampaign.followUpSkipConfirm}
              onChange={(e) => void handleToggleAlwaysConfirm(e.target.checked)}
            />
            <span className="text-sm text-gray-700">
              Always confirm before sending follow-ups
              <span className="block text-xs text-gray-500 mt-0.5">
                Turn off if you want one-click follow-ups from Sent (you can turn this back on anytime).
              </span>
            </span>
          </label>

          {(currentCampaign.followUpTemplates ?? []).length === 0 ? (
            <p className="text-sm text-gray-500">No follow-up templates yet. Add one to pre-fill messages from the Sent tab.</p>
          ) : (
            <ul className="space-y-3">
              {(currentCampaign.followUpTemplates ?? []).map((t) => (
                <li
                  key={t.id}
                  className="flex items-start justify-between gap-3 p-3 border border-gray-200 rounded-lg bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{t.title || 'Untitled'}</p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">{t.subject}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openFuEdit(t)}
                      className="p-2 text-gray-500 hover:text-gray-900 hover:bg-white rounded-lg transition-colors"
                      title="Edit template"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteFuTemplate(t.id)}
                      className="p-2 text-gray-500 hover:text-red-600 hover:bg-white rounded-lg transition-colors"
                      title="Remove template"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {(currentCampaign.followUpTemplates ?? []).length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-700 mb-2">Template previews (tokens shown as-is)</p>
              <div className="space-y-4">
                {(currentCampaign.followUpTemplates ?? []).map((t) => (
                  <div key={`pv-${t.id}`}>
                    <p className="text-xs text-gray-500 mb-1">{t.title || 'Untitled'}</p>
                    <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
                      <iframe
                        title={`Follow-up preview ${t.title || t.id}`}
                        className="w-full min-h-[220px] border-0 bg-white"
                        sandbox="allow-same-origin"
                        srcDoc={previewFollowUpBodyAsSrcDoc(t.body)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal
        isOpen={fuModalOpen}
        onClose={() => !fuSaving && setFuModalOpen(false)}
        title={fuEditing ? 'Edit follow-up template' : 'Add follow-up template'}
        size="lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">Heading / label</label>
            <input
              type="text"
              value={fuForm.title}
              onChange={(e) => setFuForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="e.g. First follow-up"
              disabled={fuSaving}
              className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">Subject</label>
            <input
              type="text"
              value={fuForm.subject}
              onChange={(e) => setFuForm((f) => ({ ...f, subject: e.target.value }))}
              placeholder="Subject line"
              disabled={fuSaving}
              className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
            />
          </div>
          <div>
            <span className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">Insert tokens</span>
            <div className="flex flex-wrap gap-1.5">
              {['{email}', '{company}', '{name}', '{first_name}', '{last_name}'].map((tok) => (
                <button
                  key={tok}
                  type="button"
                  disabled={fuSaving}
                  onClick={() => insertFuToken(tok, 'body')}
                  className="px-2 py-1 text-xs font-mono rounded border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-800"
                >
                  {tok}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">Message</label>
            <textarea
              value={fuForm.body}
              onChange={(e) => setFuForm((f) => ({ ...f, body: e.target.value }))}
              placeholder="Write your follow-up… Plain text or HTML."
              rows={10}
              disabled={fuSaving}
              className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setFuModalOpen(false)} disabled={fuSaving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSaveFuTemplate()} isLoading={fuSaving}>
              Save template
            </Button>
          </div>
        </div>
      </Modal>

      <div ref={recipientsRef} className="scroll-mt-24">
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
            {/* Filter tabs */}
            <div className="flex items-center gap-1 mb-4 p-1 bg-gray-100 rounded-lg w-fit">
              {(['all', 'delivered', 'opened', 'replied'] as const).map((filter) => (
                <button
                  key={filter}
                  onClick={() => { setRecipientFilter(filter); setCurrentPage(1); }}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors capitalize ${
                    recipientFilter === filter
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>
            {recipients.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Email</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Delivered</th>
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
              <p className="text-gray-500 text-sm mb-3">
                {recipientFilter !== 'all' 
                  ? `No ${recipientFilter} recipients found`
                  : 'No recipients uploaded yet'}
              </p>
              {recipientFilter !== 'all' ? (
                <Button variant="secondary" size="sm" onClick={() => setRecipientFilter('all')}>Show All Recipients</Button>
              ) : (
                canEdit && <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} leftIcon={<Upload className="w-4 h-4" />}>Upload Recipients</Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      <Modal isOpen={deleteModalOpen} onClose={() => setDeleteModalOpen(false)} title="Delete Campaign">
        <div className="space-y-4">
          <p className="text-gray-600">Are you sure you want to delete <span className="font-semibold text-gray-900">"{currentCampaign.name}"</span>? This cannot be undone.</p>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleDelete}>Delete</Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={validationModalOpen} onClose={() => setValidationModalOpen(false)} title="Invalid Placeholders">
        <div className="space-y-4">
          <div className="p-4 bg-red-50 rounded-lg border border-red-200">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-red-800">Your email contains placeholders that don't exist in your recipient data:</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {validationResult?.missingColumns.map((col) => (
                    <span key={col} className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded font-mono">
                      {`{${col}}`}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          
          {validationResult && validationResult.availableColumns.length > 0 && (
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <p className="text-sm font-medium text-blue-800 mb-2">Available placeholders from your uploaded data:</p>
              <div className="flex flex-wrap gap-1.5">
                {validationResult.availableColumns.map((col) => (
                  <span key={col} className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded font-mono">
                    {`{${col}}`}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          <p className="text-sm text-gray-600">
            Please edit your campaign to fix the placeholders, or upload recipient data that includes these columns.
          </p>
          
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setValidationModalOpen(false)}>Close</Button>
            <Link to={`/campaigns/${campaignId}/edit`}>
              <Button leftIcon={<Edit className="w-4 h-4" />}>Edit Campaign</Button>
            </Link>
          </div>
        </div>
      </Modal>
    </div>
  );
}
