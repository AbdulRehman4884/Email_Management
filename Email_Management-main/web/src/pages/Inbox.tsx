import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Inbox as InboxIcon, Loader2, Send, ArrowLeft, Mail, MailOpen, MessageCircle, CheckCircle, AlertTriangle,
  Search, ChevronDown,
} from 'lucide-react';
import { repliesApi, campaignApi, type ReplyListItem, type ReplyThread, type SentEmailItem } from '../lib/api';
import type { Campaign } from '../types';
import { replacePlaceholders } from '../lib/replacePlaceholders';
import { useCampaignStore } from '../store';
import { sanitizeInboundEmailHtmlForDisplay } from '../lib/sanitizeEmailHtml';
import { Button, EmptyState, Modal, useToast } from '../components/ui';

type SentFilter = 'all' | 'delivered' | 'opened' | 'replied' | 'failed';
const FAILED_STATUSES = new Set(['failed', 'bounced', 'complained']);

const AVATAR_COLORS = ['bg-red-500', 'bg-blue-500', 'bg-green-500', 'bg-purple-500', 'bg-orange-500', 'bg-cyan-500', 'bg-pink-500'];

function getAvatarColor(email: string) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) hash = email.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(email: string) {
  const name = email.split('@')[0];
  const parts = name.split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatShortDate(s: string) {
  try {
    const d = new Date(s);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return s;
  }
}

function formatFullDate(s: string) {
  try {
    const d = new Date(s);
    return d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return s;
  }
}

function displayNameFromEmail(email: string) {
  return email
    .split('@')[0]
    .replace(/[._-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function htmlToPlainText(html: string | null): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

type InboxTab = 'replies' | 'system' | 'sent';
const INBOX_ACTIVE_THREAD_STORAGE_KEY = 'inbox-active-thread-root-id';
const INBOX_ACTIVE_TAB_STORAGE_KEY = 'inbox-active-tab';

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortRepliesByNewest(list: ReplyListItem[]): ReplyListItem[] {
  return [...list].sort((a, b) => parseTimestamp(b.receivedAt) - parseTimestamp(a.receivedAt));
}

export function Inbox() {
  const toast = useToast();
  const { campaigns, fetchCampaigns } = useCampaignStore();
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [sentEmails, setSentEmails] = useState<SentEmailItem[]>([]);
  const [total, setTotal] = useState(0);
  const [tabTotals, setTabTotals] = useState<{ replies: number; system: number; sent: number }>({ replies: 0, system: 0, sent: 0 });
  const [activeTab, setActiveTab] = useState<InboxTab>('replies');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedThreadRootId, setSelectedThreadRootId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyThread | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [sendReplyError, setSendReplyError] = useState<string | null>(null);
  const [readThreadOverrides, setReadThreadOverrides] = useState<Record<number, boolean>>({});
  // mobile: toggle between list and chat view (no effect on desktop)
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const campaignMenuRef = useRef<HTMLDivElement | null>(null);
  const limit = 20;
  const currentKind = activeTab === 'replies' ? 'replies' : 'system';

  // Search + campaign filter (applies to active tab: replies / system / sent)
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<number[]>([]);
  const [campaignMenuOpen, setCampaignMenuOpen] = useState(false);
  const [campaignPickerSearch, setCampaignPickerSearch] = useState('');

  // Sent-tab filter state
  const [sentFilter, setSentFilter] = useState<SentFilter>('all');
  const [sentCounts, setSentCounts] = useState<{ all: number; delivered: number; opened: number; replied: number; failed: number }>({
    all: 0,
    delivered: 0,
    opened: 0,
    replied: 0,
    failed: 0,
  });

  /** Sent-tab follow-up count filter only */
  const [followUpFilter, setFollowUpFilter] = useState<'all' | number | '5plus'>('all');
  const [replySendAnchorId, setReplySendAnchorId] = useState<number | null>(null);

  // Follow-up modal state
  const [followUpTarget, setFollowUpTarget] = useState<SentEmailItem | null>(null);
  const [followUpSubject, setFollowUpSubject] = useState('');
  const [followUpBody, setFollowUpBody] = useState('');
  const [followUpSending, setFollowUpSending] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpCampaign, setFollowUpCampaign] = useState<Campaign | null>(null);
  const [followUpSelectedTemplateId, setFollowUpSelectedTemplateId] = useState('');
  const [followUpNeverAgain, setFollowUpNeverAgain] = useState(false);
  const [followUpRecipient, setFollowUpRecipient] = useState<{
    email: string;
    name: string | null;
    customFields: string | null;
  } | null>(null);

  const [selectedSentEmail, setSelectedSentEmail] = useState<SentEmailItem | null>(null);

  const filteredSentEmails = sentEmails;

  const openFollowUp = async (row: SentEmailItem) => {
    setFollowUpError(null);
    try {
      const [c, recipientRow] = await Promise.all([
        campaignApi.getById(row.campaignId),
        campaignApi.getRecipientById(row.campaignId, row.id),
      ]);
      const templates = c.followUpTemplates ?? [];
      if (c.followUpSkipConfirm && templates.length > 0) {
        const tpl = templates[0];
        setFollowUpSending(true);
        try {
          await campaignApi.sendFollowUp(row.campaignId, row.id, {
            subject: tpl.subject,
            body: tpl.body,
            templateId: tpl.id,
          });
          toast.success('Follow-up sent');
          await fetchList(page, 'sent', debouncedSearch, selectedCampaignIds, followUpApiOpts);
          await refreshTabTotals();
        } catch (e: unknown) {
          const msg =
            e && typeof e === 'object' && 'response' in e &&
            (e as { response?: { data?: { error?: string } } }).response?.data?.error;
          toast.error(typeof msg === 'string' && msg.length > 0 ? msg : 'Failed to send follow-up');
        } finally {
          setFollowUpSending(false);
        }
        return;
      }
      const tokens = {
        email: recipientRow.email,
        name: recipientRow.name ?? row.name,
        customFields: recipientRow.customFields,
      };
      setFollowUpRecipient(recipientRow);
      setFollowUpTarget(row);
      setFollowUpCampaign(c);
      const defaultIdx = Math.min(row.followUpCount ?? 0, Math.max(0, templates.length - 1));
      const tpl = templates[defaultIdx] ?? templates[0];
      if (tpl) {
        setFollowUpSelectedTemplateId(tpl.id);
        setFollowUpSubject(replacePlaceholders(tpl.subject, tokens));
        setFollowUpBody(replacePlaceholders(tpl.body, tokens));
      } else {
        setFollowUpSelectedTemplateId('');
        setFollowUpSubject(`Follow-up: ${row.campaignName}`);
        setFollowUpBody('');
      }
      setFollowUpNeverAgain(false);
    } catch {
      toast.error('Could not load campaign');
    }
  };

  const followUpTokens = useMemo(() => {
    if (!followUpTarget) return null;
    if (followUpRecipient) {
      return {
        email: followUpRecipient.email,
        name: followUpRecipient.name ?? followUpTarget.name,
        customFields: followUpRecipient.customFields,
      };
    }
    return {
      email: followUpTarget.email,
      name: followUpTarget.name,
      customFields: null as string | null,
    };
  }, [followUpTarget, followUpRecipient]);

  const closeFollowUp = () => {
    if (followUpSending) return;
    setFollowUpTarget(null);
    setFollowUpSubject('');
    setFollowUpBody('');
    setFollowUpError(null);
    setFollowUpCampaign(null);
    setFollowUpSelectedTemplateId('');
    setFollowUpNeverAgain(false);
    setFollowUpRecipient(null);
  };

  const toggleCampaignFilter = (id: number) => {
    setSelectedCampaignIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSendFollowUp = async () => {
    if (!followUpTarget) return;
    const subject = followUpSubject.trim();
    const body = followUpBody.trim();
    if (!subject) {
      setFollowUpError('Subject is required');
      return;
    }
    if (!body) {
      setFollowUpError('Message body is required');
      return;
    }
    setFollowUpSending(true);
    setFollowUpError(null);
    try {
      if (followUpNeverAgain) {
        await campaignApi.patchFollowUpSettings(followUpTarget.campaignId, { followUpSkipConfirm: true });
      }
      await campaignApi.sendFollowUp(followUpTarget.campaignId, followUpTarget.id, {
        subject,
        body,
        ...(followUpSelectedTemplateId ? { templateId: followUpSelectedTemplateId } : {}),
      });
      toast.success('Follow-up sent');
      closeFollowUp();
      await fetchList(page, 'sent', debouncedSearch, selectedCampaignIds, followUpApiOpts);
      await refreshTabTotals();
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e &&
        (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      setFollowUpError(typeof msg === 'string' && msg.length > 0 ? msg : 'Failed to send follow-up');
    } finally {
      setFollowUpSending(false);
    }
  };

  const selectedRow = useMemo((): ReplyListItem | null => {
    if (activeTab === 'sent' && selectedSentEmail && detail != null) {
      if (detail.recipientId !== selectedSentEmail.id) {
        return null;
      }
      const m0 = detail.messages[0];
      return {
        id: m0?.id ?? detail.threadRootId,
        threadRootId: detail.threadRootId,
        campaignId: detail.campaignId,
        recipientId: detail.recipientId,
        campaignName: detail.campaignName,
        recipientEmail: detail.recipientEmail,
        fromEmail: '',
        direction: 'outbound',
        isUnread: false,
        isSystemNotification: false,
        subject: detail.subject,
        snippet: '',
        receivedAt: m0?.receivedAt ?? '',
        followUpCount: selectedSentEmail.followUpCount ?? 0,
      };
    }
    if (selectedThreadRootId == null) return null;
    if (
      selectedThreadRootId < 0 &&
      detail != null &&
      detail.threadRootId === selectedThreadRootId
    ) {
      const m0 = detail.messages[0];
      return {
        id: m0?.id ?? selectedThreadRootId,
        threadRootId: selectedThreadRootId,
        campaignId: detail.campaignId,
        recipientId: detail.recipientId,
        campaignName: detail.campaignName,
        recipientEmail: detail.recipientEmail,
        fromEmail: '',
        direction: 'outbound',
        isUnread: false,
        isSystemNotification: false,
        subject: detail.subject,
        snippet: '',
        receivedAt: m0?.receivedAt ?? '',
        followUpCount: 0,
      };
    }
    const fromList = replies.find((r) => r.threadRootId === selectedThreadRootId);
    if (fromList) return fromList;
    if (
      detail != null &&
      detail.threadRootId === selectedThreadRootId &&
      replySendAnchorId != null
    ) {
      return {
        id: replySendAnchorId,
        threadRootId: selectedThreadRootId,
        campaignId: detail.campaignId,
        recipientId: detail.recipientId,
        campaignName: detail.campaignName,
        recipientEmail: detail.recipientEmail,
        fromEmail: '',
        direction: 'inbound',
        isUnread: false,
        isSystemNotification: detail.isSystemNotification,
        subject: detail.subject,
        snippet: '',
        receivedAt: '',
        followUpCount: 0,
      };
    }
    return null;
  }, [activeTab, selectedSentEmail, replies, selectedThreadRootId, detail, replySendAnchorId]);

  useEffect(() => {
    if (activeTab !== 'sent') {
      setSelectedSentEmail(null);
    }
  }, [activeTab]);

  /** Clear Sent thread selection when filters/search/campaign scope change — not on list pagination. */
  const campaignScopeKey = [...selectedCampaignIds].sort((a, b) => a - b).join(',');
  const sentFilterEpoch = useRef({
    debouncedSearch,
    campaignKey: campaignScopeKey,
    followUpFilter,
    sentFilter,
  });
  useEffect(() => {
    const next = {
      debouncedSearch,
      campaignKey: campaignScopeKey,
      followUpFilter,
      sentFilter,
    };
    if (activeTab !== 'sent') {
      sentFilterEpoch.current = next;
      return;
    }
    const prev = sentFilterEpoch.current;
    const unchanged =
      prev.debouncedSearch === next.debouncedSearch &&
      prev.campaignKey === next.campaignKey &&
      prev.followUpFilter === next.followUpFilter &&
      prev.sentFilter === next.sentFilter;
    sentFilterEpoch.current = next;
    if (unchanged) return;
    setSelectedSentEmail(null);
    setSelectedThreadRootId(null);
    setDetail(null);
    setReplySendAnchorId(null);
  }, [debouncedSearch, campaignScopeKey, followUpFilter, sentFilter, activeTab]);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 400);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, selectedCampaignIds, activeTab, followUpFilter]);

  useEffect(() => {
    if (activeTab !== 'sent') return;
    setPage(1);
  }, [sentFilter, activeTab]);

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

  const inboxPickerQuery = campaignPickerSearch.trim().toLowerCase();
  const campaignsForInboxPicker = useMemo(() => {
    if (!inboxPickerQuery) return campaigns;
    return campaigns.filter((c) => {
      const name = (c.name || '').toLowerCase();
      const subject = (c.subject || '').toLowerCase();
      const idStr = String(c.id);
      return (
        name.includes(inboxPickerQuery)
        || subject.includes(inboxPickerQuery)
        || idStr.includes(inboxPickerQuery)
      );
    });
  }, [campaigns, inboxPickerQuery]);

  // Lock page scroll while Inbox is mounted — all scrolling happens inside the component
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prev; };
  }, []);

  const refreshTabTotals = async () => {
    try {
      const cf = selectedCampaignIds.length > 0 ? { campaignIds: selectedCampaignIds } : {};
      const [repliesResult, systemResult, sentResult] = await Promise.all([
        repliesApi.getReplies({ page: 1, limit: 1, kind: 'replies', ...cf }),
        repliesApi.getReplies({ page: 1, limit: 1, kind: 'system', ...cf }),
        campaignApi.getSentEmails(1, 1, { ...cf, sentFilter: 'all' }),
      ]);
      setTabTotals({ replies: repliesResult.total, system: systemResult.total, sent: sentResult.total });
    } catch {
      setTabTotals({ replies: 0, system: 0, sent: 0 });
    }
  };

  const followUpApiOpts = useMemo(() => {
    if (followUpFilter === 'all') return {};
    if (followUpFilter === '5plus') return { followUpCountMin: 5 };
    return { followUpCount: followUpFilter };
  }, [followUpFilter]);

  const fetchList = async (
    pageNum: number,
    kind: InboxTab,
    searchQ: string,
    campaignIds: number[],
    followOpts?: { followUpCount?: number; followUpCountMin?: number },
  ) => {
    setLoading(true);
    try {
      const searchOpt = searchQ ? { search: searchQ } : {};
      const cf = campaignIds.length > 0 ? { campaignIds } : {};
      const fu = kind === 'sent' ? (followOpts ?? followUpApiOpts) : {};
      if (kind === 'sent') {
        const { emails, total: t, counts } = await campaignApi.getSentEmails(pageNum, limit, {
          ...searchOpt,
          ...cf,
          ...fu,
          sentFilter,
        });
        setSentEmails(emails);
        setTotal(t);
        setSentCounts(counts);
        setReplies([]);
      } else {
        const { replies: list, total: t } = await repliesApi.getReplies({
          page: pageNum,
          limit,
          kind: kind === 'replies' ? 'replies' : 'system',
          ...searchOpt,
          ...cf,
          ...fu,
        });
        setReplies(sortRepliesByNewest(list));
        setTotal(t);
        setReadThreadOverrides({});
        setSentEmails([]);
      }
    } catch {
      setReplies([]);
      setSentEmails([]);
      setTotal(0);
      setSelectedThreadRootId(null);
      setDetail(null);
      setReplySendAnchorId(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchList(page, activeTab, debouncedSearch, selectedCampaignIds);
  }, [page, activeTab, debouncedSearch, selectedCampaignIds, followUpApiOpts, sentFilter]);

  useEffect(() => {
    void refreshTabTotals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedCampaignIds]);

  useEffect(() => {
    const storedTab = window.localStorage.getItem(INBOX_ACTIVE_TAB_STORAGE_KEY);
    if (storedTab === 'replies' || storedTab === 'system' || storedTab === 'sent') {
      setActiveTab(storedTab);
    }
    const storedThreadId = window.localStorage.getItem(INBOX_ACTIVE_THREAD_STORAGE_KEY);
    if (!storedThreadId) return;
    const parsedThreadId = Number(storedThreadId);
    if (!Number.isFinite(parsedThreadId) || parsedThreadId < 0) {
      window.localStorage.removeItem(INBOX_ACTIVE_THREAD_STORAGE_KEY);
      return;
    }
    setSelectedThreadRootId(parsedThreadId);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(INBOX_ACTIVE_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (selectedThreadRootId == null) {
      window.localStorage.removeItem(INBOX_ACTIVE_THREAD_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(INBOX_ACTIVE_THREAD_STORAGE_KEY, String(selectedThreadRootId));
  }, [selectedThreadRootId]);

  const openDetail = (row: ReplyListItem) => {
    setReadThreadOverrides((prev) => ({ ...prev, [row.threadRootId]: true }));
    setSelectedThreadRootId(row.threadRootId);
    setReplySendAnchorId(row.id);
    setDetail(null);
    setDetailLoading(true);
    setReplyText('');
    setSendReplyError(null);
    setMobileShowChat(true);
    repliesApi
      .getReplyById(row.id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  };

  const loadSentThread = async (row: SentEmailItem) => {
    setSelectedSentEmail(row);
    setSelectedThreadRootId(null);
    setDetail(null);
    setDetailLoading(true);
    setReplyText('');
    setSendReplyError(null);
    setMobileShowChat(true);
    try {
      const { threadRootId } = await repliesApi.getThreadRoot(row.campaignId, row.id);
      if (threadRootId == null) {
        try {
          const [campaign, recipient] = await Promise.all([
            campaignApi.getById(row.campaignId),
            campaignApi.getRecipientById(row.campaignId, row.id),
          ]);
          const syntheticRootId = -row.id;
          const sentAtIso = row.sentAt
            ? new Date(row.sentAt).toISOString()
            : new Date().toISOString();
          const hasHtml = Boolean(campaign.emailContent?.trim());

          const resolvedSubject = replacePlaceholders(campaign.subject ?? '', {
            email: recipient.email,
            name: recipient.name,
            customFields: recipient.customFields,
          });
          const resolvedHtml = hasHtml
            ? replacePlaceholders(campaign.emailContent, {
              email: recipient.email,
              name: recipient.name,
              customFields: recipient.customFields,
            })
            : campaign.emailContent;
          const synthetic: ReplyThread = {
            threadRootId: syntheticRootId,
            campaignId: row.campaignId,
            recipientId: row.id,
            campaignName: row.campaignName,
            recipientEmail: row.email,
            isSystemNotification: false,
            subject: resolvedSubject || campaign.subject,
            messages: [
              {
                id: -row.id,
                direction: 'outbound',
                fromEmail: campaign.fromEmail,
                subject: resolvedSubject || campaign.subject,
                bodyText: hasHtml ? null : '(No content in campaign template.)',
                bodyHtml: hasHtml ? resolvedHtml : null,
                receivedAt: sentAtIso,
              },
            ],
          };
          setSelectedThreadRootId(syntheticRootId);
          setReplySendAnchorId(null);
          setDetail(synthetic);
        } catch {
          toast.error('Could not load sent email');
          setDetail(null);
          setSelectedThreadRootId(null);
        } finally {
          setDetailLoading(false);
        }
        return;
      }
      setSelectedThreadRootId(threadRootId);
      setReplySendAnchorId(null);
      setDetailLoading(true);
      const thread = await repliesApi.getReplyThreadByRoot(threadRootId);
      setDetail(thread);
      setReplySendAnchorId(thread.messages[0]?.id ?? null);
    } catch {
      toast.error('Could not open conversation');
      setDetail(null);
      setSelectedThreadRootId(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSendReply = async () => {
    const anchorId = selectedRow?.id ?? replySendAnchorId;
    if (!detail || detail.threadRootId < 0 || !replyText.trim() || isSendingReply || anchorId == null || anchorId < 0) return;
    setIsSendingReply(true);
    setSendReplyError(null);
    try {
      await repliesApi.sendReply(anchorId, replyText.trim());
      setReplyText('');
      const searchOpt = debouncedSearch ? { search: debouncedSearch } : {};
      const cf = selectedCampaignIds.length > 0 ? { campaignIds: selectedCampaignIds } : {};
      const { replies: list, total: t } = await repliesApi.getReplies({
        page: 1,
        limit,
        kind: currentKind,
        ...searchOpt,
        ...cf,
      });
      const sortedList = sortRepliesByNewest(list);
      setPage(1);
      setReplies(sortedList);
      setTotal(t);
      const latestThreadRow = sortedList.find((r) => r.threadRootId === detail.threadRootId) ?? sortedList[0];
      if (latestThreadRow) {
        setSelectedThreadRootId(latestThreadRow.threadRootId);
        const refreshedThread = await repliesApi.getReplyById(latestThreadRow.id);
        setDetail(refreshedThread);
      } else {
        setDetail(null);
      }
      await refreshTabTotals();
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e && (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      setSendReplyError(typeof msg === 'string' && msg.length > 0 ? msg : 'Failed to send reply');
    } finally {
      setIsSendingReply(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'replies') return;
    if (selectedThreadRootId != null && selectedThreadRootId < 0) return;
    if (replies.length === 0) {
      if (selectedThreadRootId == null) setDetail(null);
      return;
    }
    const selectedRowInList = selectedThreadRootId != null
      ? replies.find((r) => r.threadRootId === selectedThreadRootId)
      : null;
    if (selectedRowInList) {
      openDetail(selectedRowInList);
      return;
    }
    if (selectedThreadRootId != null) return;
    const firstReply = replies[0];
    if (firstReply) openDetail(firstReply);
  }, [replies, selectedThreadRootId, activeTab]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || !detail) return;
    el.scrollTop = el.scrollHeight;
  }, [detail, detail?.messages.length]);

  const isSyntheticSentPreview = selectedThreadRootId != null && selectedThreadRootId < 0;

  const canReplyInThread =
    !isSyntheticSentPreview &&
    (selectedRow != null || replySendAnchorId != null) &&
    (selectedRow == null || !selectedRow.isSystemNotification);

  const showComposer =
    activeTab === 'replies' &&
    detail != null &&
    !detailLoading &&
    !detail.isSystemNotification &&
    canReplyInThread;
  const showComposerLoadingShell =
    activeTab === 'replies' &&
    detailLoading &&
    canReplyInThread &&
    selectedThreadRootId != null &&
    !isSyntheticSentPreview;

  return (
    // Full viewport height, no page scroll — everything scrolls inside
    <div className="flex flex-col overflow-hidden" style={{ height: 'calc(100vh - 4rem)' }}>

      {/* ── Title bar ── */}
      <div className="flex-shrink-0">
        <h1 className="text-2xl font-bold text-gray-900">Inbox</h1>
        <p className="text-gray-500 mt-0.5 text-sm">{total} conversation{total === 1 ? '' : 's'}</p>
      </div>

      <div className="flex-shrink-0 mt-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[min(100%,220px)] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <input
            type="search"
            placeholder={
              activeTab === 'sent'
                ? 'Search recipient or campaign…'
                : 'Search subject, email, campaign…'
            }
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          />
        </div>
        <div className="relative" ref={campaignMenuRef}>
          <button
            type="button"
            onClick={() => setCampaignMenuOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 min-w-[10rem] justify-between"
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
              <div className="max-h-[11rem] min-h-0 overflow-y-auto overscroll-contain py-1">
                {campaigns.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-500">No campaigns</p>
                ) : campaignsForInboxPicker.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-500">No matches</p>
                ) : (
                  campaignsForInboxPicker.map((c) => {
                    const checked = selectedCampaignIds.includes(c.id);
                    return (
                      <label
                        key={c.id}
                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCampaignFilter(c.id)}
                          className="rounded border-gray-300"
                        />
                        <span className="min-w-0 flex-1 truncate" title={c.subject}>{c.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
              {selectedCampaignIds.length > 0 && (
                <button
                  type="button"
                  className="shrink-0 border-t border-gray-100 px-3 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-50"
                  onClick={() => setSelectedCampaignIds([])}
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex-shrink-0 mt-2 inline-flex rounded-lg border border-gray-200 bg-white p-1" style={{ alignSelf: 'flex-start', width: 'fit-content' }}>
        <button
          type="button"
          onClick={() => { setActiveTab('replies'); setPage(1); setSelectedThreadRootId(null); setReplySendAnchorId(null); setMobileShowChat(false); }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            activeTab === 'replies' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          Replies ({tabTotals.replies})
        </button>
        <button
          type="button"
          onClick={() => { setActiveTab('system'); setPage(1); setSelectedThreadRootId(null); setReplySendAnchorId(null); setMobileShowChat(false); }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            activeTab === 'system' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          System Notifications ({tabTotals.system})
        </button>
        <button
          type="button"
          onClick={() => { setActiveTab('sent'); setPage(1); setSelectedThreadRootId(null); setReplySendAnchorId(null); setMobileShowChat(false); }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            activeTab === 'sent' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          Sent ({tabTotals.sent})
        </button>
      </div>

      {/* ── Follow-up count filter (Sent tab only) ── */}
      {activeTab === 'sent' && (
        <div className="flex-shrink-0 mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-gray-500 w-full sm:w-auto sm:mr-1">Follow-ups sent</span>
          {(
            [
              { v: 'all' as const, label: 'All' },
              { v: 0 as const, label: '0' },
              { v: 1 as const, label: '1' },
              { v: 2 as const, label: '2' },
              { v: 3 as const, label: '3' },
              { v: 4 as const, label: '4' },
              { v: '5plus' as const, label: '5+' },
            ] as const
          ).map(({ v, label }) => {
            const active = followUpFilter === v;
            return (
              <button
                key={String(v)}
                type="button"
                onClick={() => setFollowUpFilter(v)}
                className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                  active
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Sent filter chips (only on Sent tab) ── */}
      {activeTab === 'sent' && (
        <div className="flex-shrink-0 mt-2 flex flex-wrap items-center gap-2">
          {([
            { id: 'all' as const, label: 'All', count: sentCounts.all, icon: Mail },
            { id: 'delivered' as const, label: 'Delivered', count: sentCounts.delivered, icon: CheckCircle },
            { id: 'opened' as const, label: 'Opened', count: sentCounts.opened, icon: MailOpen },
            { id: 'replied' as const, label: 'Replied', count: sentCounts.replied, icon: MessageCircle },
            { id: 'failed' as const, label: 'Failed', count: sentCounts.failed, icon: AlertTriangle },
          ]).map((chip) => {
            const Icon = chip.icon;
            const active = sentFilter === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setSentFilter(chip.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                  active
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {chip.label} ({chip.count})
              </button>
            );
          })}
        </div>
      )}

      {/* ── Main content — fills remaining height ── */}
      <div className="flex-1 min-h-0 overflow-hidden mt-2">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          </div>
        ) : activeTab === 'sent' ? (
          /* ── Sent emails view ── */
          sentEmails.length === 0 ? (
            <div className="h-full bg-white border border-gray-200 rounded-xl overflow-hidden">
              <EmptyState
                icon={<Send className="w-8 h-8 text-gray-400" />}
                title="No sent emails"
                description="When you send campaign emails, they'll appear here with their delivery status."
              />
            </div>
          ) : filteredSentEmails.length === 0 ? (
            <div className="h-full bg-white border border-gray-200 rounded-xl overflow-hidden">
              <EmptyState
                icon={<Send className="w-8 h-8 text-gray-400" />}
                title={`No ${sentFilter} emails`}
                description={`Switch to a different filter to see other sent emails.`}
              />
            </div>
          ) : (
            <div className="h-full flex bg-white border border-gray-200 rounded-xl overflow-hidden min-h-0">
              <div
                className={`${mobileShowChat ? 'hidden' : 'flex'} h-full min-h-0 w-full flex-shrink-0 flex-col overflow-hidden border-r border-gray-200`}
              >
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto overscroll-contain">
                <table className="w-full min-w-[640px]">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr className="border-b border-gray-200">
                      <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Recipient</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Campaign</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Sent At</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Status</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase">Follow-ups</th>
                      <th className="py-3 px-4"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSentEmails.map((email) => {
                      const isFailed = FAILED_STATUSES.has(String(email.status));
                      const rowSelected = selectedSentEmail?.id === email.id;
                      return (
                      <tr
                        key={email.id}
                        onClick={() => void loadSentThread(email)}
                        className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors ${rowSelected ? 'bg-gray-100' : ''}`}
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(email.email)}`}>
                              <span className="text-white text-xs font-semibold">{getInitials(email.email)}</span>
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{email.name || displayNameFromEmail(email.email)}</p>
                              <p className="text-xs text-gray-500 truncate">{email.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <p className="text-sm text-gray-600 truncate max-w-[200px]" title={email.campaignName}>{email.campaignName}</p>
                        </td>
                        <td className="py-3 px-4">
                          <p className="text-sm text-gray-500">{formatShortDate(email.sentAt)}</p>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2 flex-wrap">
                            {isFailed ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                                <AlertTriangle className="w-3 h-3" />
                                {String(email.status).charAt(0).toUpperCase() + String(email.status).slice(1)}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
                                <CheckCircle className="w-3 h-3" />
                                Sent
                              </span>
                            )}
                            {email.openedAt && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                                <MailOpen className="w-3 h-3" />
                                Opened
                              </span>
                            )}
                            {email.repliedAt && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
                                <MessageCircle className="w-3 h-3" />
                                Replied
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-sm text-gray-600 tabular-nums">{email.followUpCount ?? 0}</span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void openFollowUp(email); }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 text-white hover:bg-gray-800 transition-colors"
                            title="Send follow-up email"
                          >
                            <Send className="w-3.5 h-3.5" />
                            Follow up
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>

              <div className={`${mobileShowChat ? 'flex' : 'hidden'} h-full min-h-0 w-full flex-1 flex-col overflow-hidden min-w-0`}>
                {/* While a row is opening, threadRootId is cleared before the new thread loads — check loading first */}
                {selectedSentEmail != null && detailLoading && detail == null ? (
                  <div className="flex flex-1 min-h-[12rem] items-center justify-center px-4">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                  </div>
                ) : selectedThreadRootId == null ? (
                  <div className="flex items-center justify-center flex-1 min-h-[12rem] text-gray-400 text-sm px-4 text-center">
                    Select a sent email to view the thread
                  </div>
                ) : detail == null || selectedRow == null ? (
                  <div className="flex flex-1 min-h-[12rem] items-center justify-center text-gray-400 text-sm px-4">
                    Loading conversation…
                  </div>
                ) : (
                  <>
                    <div className="flex-shrink-0 px-5 py-4 border-b border-gray-200 bg-white overflow-hidden">
                      <button
                        type="button"
                        className="mb-2 flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 transition-colors"
                        onClick={() => setMobileShowChat(false)}
                      >
                        <ArrowLeft className="w-4 h-4" />
                        Back to list
                      </button>
                      <h2
                        className="text-base font-semibold text-gray-900 truncate"
                        title={detail?.subject ?? selectedRow.subject}
                      >
                        {detail?.subject ?? selectedRow.subject}
                      </h2>
                      {(detail?.isSystemNotification ?? selectedRow.isSystemNotification) && (
                        <div className="mt-1.5">
                          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                            System Generated
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-2 overflow-hidden" style={{ minWidth: 0 }}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(detail?.recipientEmail ?? selectedRow.recipientEmail)}`}>
                          <span className="text-white text-xs font-semibold">
                            {getInitials(detail?.recipientEmail ?? selectedRow.recipientEmail)}
                          </span>
                        </div>
                        <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {displayNameFromEmail(detail?.recipientEmail ?? selectedRow.recipientEmail)}
                          </p>
                          <p className="text-xs text-gray-500 truncate" title={detail?.recipientEmail ?? selectedRow.recipientEmail}>
                            {detail?.recipientEmail ?? selectedRow.recipientEmail}
                          </p>
                        </div>
                        <div style={{ flexShrink: 0, maxWidth: '200px', overflow: 'hidden' }} className="text-right">
                          <p className="text-xs text-gray-400 truncate" title={detail?.campaignName ?? selectedRow.campaignName}>
                            {detail?.campaignName ?? selectedRow.campaignName}
                          </p>
                        </div>
                      </div>
                      <p className="text-[10px] text-gray-400 mt-2 tabular-nums">
                        Follow-ups sent: {selectedSentEmail?.followUpCount ?? selectedRow.followUpCount ?? 0}
                      </p>
                    </div>

                    <div
                      ref={messagesContainerRef}
                      className="flex-1 min-h-0 p-5 overflow-y-auto overflow-x-hidden overscroll-contain space-y-4 bg-gray-50/50"
                    >
                      {detailLoading ? (
                        <div className="flex items-center justify-center py-16">
                          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                        </div>
                      ) : detail ? (
                        detail.messages.map((m) => {
                          const outbound = m.direction === 'outbound';
                          const inboundSystem = detail.isSystemNotification && !outbound;
                          const outboundText = m.bodyText || htmlToPlainText(m.bodyHtml) || '(no content)';
                          return (
                            <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                              <div
                                className={`rounded-xl px-4 py-3 shadow-sm border overflow-hidden ${
                                  outbound
                                    ? m.bodyHtml
                                      ? 'max-w-[90%] bg-gray-50 border-gray-200'
                                      : 'max-w-[90%]'
                                    : inboundSystem
                                      ? 'bg-amber-50 border-amber-200 text-amber-900 max-w-[90%]'
                                      : 'bg-white border-gray-200 text-gray-900 max-w-[90%]'
                                }`}
                                style={
                                  outbound && !m.bodyHtml
                                    ? { backgroundColor: '#2563eb', borderColor: '#1d4ed8' }
                                    : undefined
                                }
                              >
                                <div
                                  className="flex items-center justify-between gap-3 mb-2 text-xs"
                                  style={
                                    outbound && !m.bodyHtml
                                      ? { color: '#bfdbfe' }
                                      : { color: '#6b7280' }
                                  }
                                >
                                  <span className="font-medium truncate">
                                    {outbound ? 'You' : displayNameFromEmail(m.fromEmail)}
                                  </span>
                                  <span className="flex-shrink-0" style={{ opacity: 0.9 }}>{formatFullDate(m.receivedAt)}</span>
                                </div>
                                {outbound ? (
                                  m.bodyHtml ? (
                                    <div className="rounded-lg bg-white text-gray-900 max-w-full overflow-x-auto prose prose-sm border border-gray-200">
                                      <div
                                        dangerouslySetInnerHTML={{
                                          __html: sanitizeInboundEmailHtmlForDisplay(m.bodyHtml),
                                        }}
                                      />
                                    </div>
                                  ) : (
                                    <div style={{ color: '#ffffff', fontSize: '0.875rem', lineHeight: '1.25rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                      {outboundText}
                                    </div>
                                  )
                                ) : m.bodyHtml ? (
                                  <div
                                    className="prose prose-sm text-gray-700 overflow-x-auto max-w-full"
                                    dangerouslySetInnerHTML={{
                                      __html: sanitizeInboundEmailHtmlForDisplay(m.bodyHtml),
                                    }}
                                  />
                                ) : (
                                  <p className="text-sm whitespace-pre-wrap text-gray-700 break-words">
                                    {m.bodyText || '(no content)'}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        ) : replies.length === 0 &&
          !(
            selectedThreadRootId != null &&
            selectedThreadRootId < 0 &&
            detail != null
          ) ? (
          <div className="h-full bg-white border border-gray-200 rounded-xl overflow-hidden">
            <EmptyState
              icon={<InboxIcon className="w-8 h-8 text-gray-400" />}
              title={activeTab === 'system' ? 'No system notifications' : 'No replies yet'}
              description={
                activeTab === 'system'
                  ? 'Mailer Daemon / Postmaster notifications will show up here.'
                  : "When recipients reply to your campaign emails, they'll show up here."
              }
            />
          </div>
        ) : (
          /* ── Split panel: left list + right chat ── */
          <div className="h-full flex bg-white border border-gray-200 rounded-xl overflow-hidden">

            {/* Left: recipient list — independent scroll
                desktop: fixed sidebar unchanged | mobile: full-width, hidden when chat open */}
            <div className={`${mobileShowChat ? 'hidden md:flex' : 'flex'} w-full md:w-80 flex-shrink-0 border-r border-gray-200 flex-col overflow-hidden`}>
              <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
                {replies.map((r) => {
                  const isUnread = r.isUnread && readThreadOverrides[r.threadRootId] !== true;
                  return (
                  <button
                    key={r.id}
                    onClick={() => openDetail(r)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors overflow-hidden ${
                      selectedThreadRootId === r.threadRootId ? 'bg-gray-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(r.recipientEmail)}`}>
                        <span className="text-white text-xs font-semibold">{getInitials(r.recipientEmail)}</span>
                      </div>
                      <div className="min-w-0 flex-1 overflow-hidden">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`text-sm truncate ${isUnread ? 'font-bold text-gray-900' : 'font-semibold text-gray-900'}`}>
                            {displayNameFromEmail(r.recipientEmail)}
                          </p>
                          <span className={`text-xs flex-shrink-0 ${isUnread ? 'font-bold text-gray-600' : 'text-gray-400'}`}>
                            {formatShortDate(r.receivedAt)}
                          </span>
                        </div>
                        {r.isSystemNotification && (
                          <div className="mt-1">
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              Delivery Failure
                            </span>
                          </div>
                        )}
                        <p
                          className={`text-xs truncate mt-0.5 ${isUnread ? 'font-bold line-through text-gray-700' : 'text-gray-600'}`}
                          title={r.subject}
                        >
                          {r.subject}
                        </p>
                        <p
                          className={`text-xs truncate mt-0.5 ${isUnread ? 'font-bold line-through text-gray-500' : 'text-gray-400'}`}
                          title={r.snippet}
                        >
                          {r.snippet}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5 tabular-nums">
                          Follow-ups sent: {r.followUpCount ?? 0}
                        </p>
                      </div>
                    </div>
                  </button>
                  );
                })}
              </div>
            </div>

            {/* Right: chat area — fixed, independent scroll
                desktop: flex-1 remainder unchanged | mobile: full-width, hidden when list shown */}
            <div className={`${mobileShowChat ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0 overflow-hidden`}>
              {selectedThreadRootId == null ? (
                <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
                  Select an email to view
                </div>
              ) : detailLoading && detail == null ? (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                </div>
              ) : detail == null || selectedRow == null ? (
                <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
                  Select an email to view
                </div>
              ) : (
                <>
                  {/* Chat header — never scrolls */}
                  <div className="flex-shrink-0 px-5 py-4 border-b border-gray-200 bg-white overflow-hidden">
                    {/* back button — only visible on mobile */}
                    <button
                      className="md:hidden flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 mb-2 transition-colors"
                      onClick={() => setMobileShowChat(false)}
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back
                    </button>
                    <h2
                      className="text-base font-semibold text-gray-900 truncate"
                      title={detail?.subject ?? selectedRow.subject}
                    >
                      {detail?.subject ?? selectedRow.subject}
                    </h2>
                    {(detail?.isSystemNotification ?? selectedRow.isSystemNotification) && (
                      <div className="mt-1.5">
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                          System Generated
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-2 overflow-hidden" style={{ minWidth: 0 }}>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(detail?.recipientEmail ?? selectedRow.recipientEmail)}`}>
                        <span className="text-white text-xs font-semibold">
                          {getInitials(detail?.recipientEmail ?? selectedRow.recipientEmail)}
                        </span>
                      </div>
                      <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {displayNameFromEmail(detail?.recipientEmail ?? selectedRow.recipientEmail)}
                        </p>
                        <p className="text-xs text-gray-500 truncate" title={detail?.recipientEmail ?? selectedRow.recipientEmail}>
                          {detail?.recipientEmail ?? selectedRow.recipientEmail}
                        </p>
                      </div>
                      {/* Campaign name — hard pixel max so truncate works reliably */}
                      <div style={{ flexShrink: 0, maxWidth: '200px', overflow: 'hidden' }} className="text-right">
                        <p className="text-xs text-gray-400 truncate" title={detail?.campaignName ?? selectedRow.campaignName}>
                          {detail?.campaignName ?? selectedRow.campaignName}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Messages — only this scrolls */}
                  <div
                    ref={messagesContainerRef}
                    className="flex-1 min-h-0 p-5 overflow-y-auto overflow-x-hidden overscroll-contain space-y-4 bg-gray-50/50"
                  >
                    {detailLoading ? (
                      <div className="flex items-center justify-center py-16">
                        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                      </div>
                    ) : detail ? (
                      detail.messages.map((m) => {
                        const outbound = m.direction === 'outbound';
                        const inboundSystem = detail.isSystemNotification && !outbound;
                        const outboundText = m.bodyText || htmlToPlainText(m.bodyHtml) || '(no content)';
                        return (
                          <div key={m.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                            <div
                              className={`rounded-xl px-4 py-3 shadow-sm border overflow-hidden ${
                                outbound
                                  ? m.bodyHtml
                                    ? 'max-w-[90%] bg-gray-50 border-gray-200'
                                    : 'max-w-[90%]'
                                  : inboundSystem
                                    ? 'bg-amber-50 border-amber-200 text-amber-900 max-w-[90%]'
                                    : 'bg-white border-gray-200 text-gray-900 max-w-[90%]'
                              }`}
                              style={
                                outbound && !m.bodyHtml
                                  ? { backgroundColor: '#2563eb', borderColor: '#1d4ed8' }
                                  : undefined
                              }
                            >
                              <div
                                className="flex items-center justify-between gap-3 mb-2 text-xs"
                                style={
                                  outbound && !m.bodyHtml
                                    ? { color: '#bfdbfe' }
                                    : { color: '#6b7280' }
                                }
                              >
                                <span className="font-medium truncate">
                                  {outbound ? 'You' : displayNameFromEmail(m.fromEmail)}
                                </span>
                                <span className="flex-shrink-0" style={{ opacity: 0.9 }}>{formatFullDate(m.receivedAt)}</span>
                              </div>
                              {outbound ? (
                                m.bodyHtml ? (
                                  <div className="rounded-lg bg-white text-gray-900 max-w-full overflow-x-auto prose prose-sm border border-gray-200">
                                    <div
                                      dangerouslySetInnerHTML={{
                                        __html: sanitizeInboundEmailHtmlForDisplay(m.bodyHtml),
                                      }}
                                    />
                                  </div>
                                ) : (
                                  <div style={{ color: '#ffffff', fontSize: '0.875rem', lineHeight: '1.25rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                    {outboundText}
                                  </div>
                                )
                              ) : m.bodyHtml ? (
                                /* overflow-x-auto so wide HTML email tables scroll inside the bubble, not the page */
                                <div
                                  className="prose prose-sm text-gray-700 overflow-x-auto max-w-full"
                                  dangerouslySetInnerHTML={{
                                    __html: sanitizeInboundEmailHtmlForDisplay(m.bodyHtml),
                                  }}
                                />
                              ) : (
                                <p className="text-sm whitespace-pre-wrap text-gray-700 break-words">
                                  {m.bodyText || '(no content)'}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : null}
                  </div>

                  {/* Composer / footer — never scrolls */}
                  {showComposer ? (
                    <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-white">
                      <textarea
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' || e.shiftKey) return;
                          e.preventDefault();
                          void handleSendReply();
                        }}
                        placeholder="Write a reply…"
                        title="Press Enter to send · Shift+Enter for new line"
                        rows={3}
                        className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent resize-none"
                      />
                      {sendReplyError && <p className="mt-2 text-sm text-red-600">{sendReplyError}</p>}
                      <div className="flex justify-end mt-2">
                        <Button
                          size="sm"
                          leftIcon={<Send className="w-3.5 h-3.5" />}
                          onClick={() => void handleSendReply()}
                          disabled={!replyText.trim() || isSendingReply}
                          isLoading={isSendingReply}
                        >
                          Send reply
                        </Button>
                      </div>
                    </div>
                  ) : showComposerLoadingShell ? (
                    <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-white">
                      <textarea
                        disabled
                        placeholder="Loading conversation…"
                        rows={3}
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 text-sm resize-none cursor-wait"
                      />
                    </div>
                  ) : detailLoading ? (
                    <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50 text-sm text-gray-500">
                      <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                      Loading conversation…
                    </div>
                  ) : detail?.isSystemNotification ? (
                    <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-amber-50 text-sm text-amber-800">
                      System notifications are read-only.
                    </div>
                  ) : null}
                </>
              )}
            </div>

          </div>
        )}
      </div>

      {/* ── Pagination (list only) ── */}
      <div className="flex-shrink-0 mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          {total <= 0
            ? 'Showing 0'
            : `Showing ${Math.min((page - 1) * limit + 1, total)}–${Math.min(page * limit, total)} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={loading || page * limit >= total}
            onClick={() => setPage((p) => (p * limit >= total ? p : p + 1))}
          >
            Next
          </Button>
        </div>
      </div>

      {/* ── Follow-up compose modal ── */}
      <Modal
        isOpen={followUpTarget != null}
        onClose={closeFollowUp}
        title="Send follow-up email"
        size="lg"
      >
        {followUpTarget && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(followUpTarget.email)}`}>
                <span className="text-white text-xs font-semibold">{getInitials(followUpTarget.email)}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500 uppercase tracking-wide">To</p>
                <p className="text-sm font-medium text-gray-900 truncate">
                  {followUpTarget.name || displayNameFromEmail(followUpTarget.email)}
                </p>
                <p className="text-xs text-gray-500 truncate">{followUpTarget.email}</p>
              </div>
              <div className="text-right flex-shrink-0 max-w-[180px]">
                <p className="text-xs text-gray-500 uppercase tracking-wide">Campaign</p>
                <p className="text-xs text-gray-700 truncate" title={followUpTarget.campaignName}>
                  {followUpTarget.campaignName}
                </p>
              </div>
            </div>

            {followUpCampaign && (followUpCampaign.followUpTemplates ?? []).length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">
                  Template
                </label>
                <select
                  value={followUpSelectedTemplateId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setFollowUpSelectedTemplateId(id);
                    const t = (followUpCampaign.followUpTemplates ?? []).find((x) => x.id === id);
                    if (t && followUpTokens) {
                      setFollowUpSubject(replacePlaceholders(t.subject, followUpTokens));
                      setFollowUpBody(replacePlaceholders(t.body, followUpTokens));
                    } else if (t) {
                      setFollowUpSubject(t.subject);
                      setFollowUpBody(t.body);
                    }
                  }}
                  disabled={followUpSending}
                  className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:bg-gray-50"
                >
                  {(followUpCampaign.followUpTemplates ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title?.trim() ? t.title : t.subject}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">
                Subject
              </label>
              <input
                type="text"
                value={followUpSubject}
                onChange={(e) => setFollowUpSubject(e.target.value)}
                placeholder="Subject"
                disabled={followUpSending}
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 uppercase tracking-wide mb-1">
                Message
              </label>
              <textarea
                value={followUpBody}
                onChange={(e) => setFollowUpBody(e.target.value)}
                placeholder="Write your follow-up message…"
                rows={8}
                disabled={followUpSending}
                className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent resize-none disabled:bg-gray-50 disabled:cursor-not-allowed"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Tokens like {'{company}'}, {'{name}'} use this recipient&apos;s CSV columns and name.
              </p>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 rounded border-gray-300"
                checked={followUpNeverAgain}
                onChange={(e) => setFollowUpNeverAgain(e.target.checked)}
                disabled={followUpSending}
              />
              <span className="text-sm text-gray-700">
                Never ask again for this campaign
                <span className="block text-xs text-gray-500 mt-0.5">
                  Next time, follow-ups send immediately using the first template (you can turn confirmations back on from Campaign detail).
                </span>
              </span>
            </label>

            {followUpError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {followUpError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={closeFollowUp} disabled={followUpSending}>
                Cancel
              </Button>
              <Button
                leftIcon={<Send className="w-3.5 h-3.5" />}
                onClick={() => void handleSendFollowUp()}
                disabled={!followUpSubject.trim() || !followUpBody.trim() || followUpSending}
                isLoading={followUpSending}
              >
                Send follow-up
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
