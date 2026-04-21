import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Inbox as InboxIcon, Loader2, Send } from 'lucide-react';
import { repliesApi, type ReplyListItem, type ReplyThread } from '../lib/api';
import { Button, EmptyState } from '../components/ui';

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

type InboxTab = 'replies' | 'system';

export function Inbox() {
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [tabTotals, setTabTotals] = useState<{ replies: number; system: number }>({ replies: 0, system: 0 });
  const [activeTab, setActiveTab] = useState<InboxTab>('replies');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyThread | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [sendReplyError, setSendReplyError] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const limit = 20;
  const currentKind = activeTab === 'replies' ? 'replies' : 'system';

  const selectedRow = useMemo(
    () => (selectedId != null ? replies.find((r) => r.id === selectedId) ?? null : null),
    [replies, selectedId],
  );

  const refreshTabTotals = async () => {
    try {
      const [repliesResult, systemResult] = await Promise.all([
        repliesApi.getReplies({ page: 1, limit: 1, kind: 'replies' }),
        repliesApi.getReplies({ page: 1, limit: 1, kind: 'system' }),
      ]);
      setTabTotals({ replies: repliesResult.total, system: systemResult.total });
    } catch {
      setTabTotals({ replies: 0, system: 0 });
    }
  };

  const fetchList = async (pageNum: number, kind: InboxTab) => {
    setLoading(true);
    try {
      const { replies: list, total: t } = await repliesApi.getReplies({
        page: pageNum,
        limit,
        kind: kind === 'replies' ? 'replies' : 'system',
      });
      setReplies(list);
      setTotal(t);
      if (!list.some((r) => r.id === selectedId)) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch {
      setReplies([]);
      setTotal(0);
      setSelectedId(null);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchList(page, activeTab);
  }, [page, activeTab]);

  useEffect(() => {
    void refreshTabTotals();
  }, [activeTab]);

  const openDetail = (id: number) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setReplyText('');
    setSendReplyError(null);
    repliesApi
      .getReplyById(id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  };

  const handleSendReply = async () => {
    if (!detail || !replyText.trim() || isSendingReply || selectedId == null) return;
    setIsSendingReply(true);
    setSendReplyError(null);
    try {
      await repliesApi.sendReply(selectedId, replyText.trim());
      setReplyText('');
      const { replies: list, total: t } = await repliesApi.getReplies({ page, limit, kind: currentKind });
      setReplies(list);
      setTotal(t);
      const latestThreadRow = list.find((r) => r.id === selectedId) ?? list[0];
      if (latestThreadRow) {
        setSelectedId(latestThreadRow.id);
        const refreshedThread = await repliesApi.getReplyById(latestThreadRow.id);
        setDetail(refreshedThread);
      } else {
        setDetail(null);
      }
      await refreshTabTotals();
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e && (e as { response?: { data?: { error?: string } } }).response?.data?.error;
      setSendReplyError(msg || 'Failed to send reply');
    } finally {
      setIsSendingReply(false);
    }
  };

  useEffect(() => {
    if (replies.length > 0 && !selectedId) openDetail(replies[0].id);
  }, [replies]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el || !detail) return;
    el.scrollTop = el.scrollHeight;
  }, [detail, detail?.messages.length]);

  const showComposer =
    activeTab === 'replies' && detail != null && !detailLoading && !detail.isSystemNotification;
  const showComposerLoadingShell =
    activeTab === 'replies' && detailLoading && selectedRow != null && !selectedRow.isSystemNotification;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Inbox</h1>
        <p className="text-gray-500 mt-0.5 text-sm">{total} conversation{total === 1 ? '' : 's'}</p>
      </div>

      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
        <button
          type="button"
          onClick={() => {
            setActiveTab('replies');
            setPage(1);
            setSelectedId(null);
          }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            activeTab === 'replies' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          Replies ({tabTotals.replies})
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveTab('system');
            setPage(1);
            setSelectedId(null);
          }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            activeTab === 'system' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          System Notifications ({tabTotals.system})
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      ) : replies.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl">
          <EmptyState
            icon={<InboxIcon className="w-8 h-8 text-gray-400" />}
            title={activeTab === 'system' ? 'No system notifications' : 'No replies yet'}
            description={
              activeTab === 'system'
                ? "Mailer Daemon / Postmaster notifications will show up here."
                : "When recipients reply to your campaign emails, they'll show up here."
            }
          />
        </div>
      ) : (
        <div className="flex items-stretch gap-0 bg-white border border-gray-200 rounded-xl overflow-hidden min-h-[500px] h-[calc(100vh-14rem)]">
          <div className="w-80 lg:w-96 border-r border-gray-200 flex flex-col flex-shrink-0 min-h-0 min-w-0">
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain">
            {replies.map((r) => (
              <button
                key={r.id}
                onClick={() => openDetail(r.id)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                  selectedId === r.id ? 'bg-gray-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(r.recipientEmail)}`}
                  >
                    <span className="text-white text-xs font-semibold">{getInitials(r.recipientEmail)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900 text-sm truncate">{displayNameFromEmail(r.recipientEmail)}</p>
                      <span className="text-xs text-gray-400 flex-shrink-0">{formatShortDate(r.receivedAt)}</span>
                    </div>
                    {r.isSystemNotification && (
                      <div className="mt-1">
                        <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                          Delivery Failure
                        </span>
                      </div>
                    )}
                    <p className="text-xs text-gray-600 truncate mt-0.5">{r.subject}</p>
                    <p className="text-xs text-gray-400 truncate mt-0.5">{r.snippet}</p>
                  </div>
                </div>
              </button>
            ))}
            </div>
          </div>

          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            {selectedId == null || selectedRow == null ? (
              <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">Select an email to view</div>
            ) : (
              <>
                <div className="flex-shrink-0 p-5 border-b border-gray-200 bg-white">
                  <h2 className="text-lg font-semibold text-gray-900 truncate" title={detail?.subject ?? selectedRow.subject}>
                    {detail?.subject ?? selectedRow.subject}
                  </h2>
                  {(detail?.isSystemNotification ?? selectedRow.isSystemNotification) && (
                    <div className="mt-2">
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                        System Generated
                      </span>
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-3 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(
                        detail?.recipientEmail ?? selectedRow.recipientEmail,
                      )}`}
                    >
                      <span className="text-white text-xs font-semibold">
                        {getInitials(detail?.recipientEmail ?? selectedRow.recipientEmail)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {displayNameFromEmail(detail?.recipientEmail ?? selectedRow.recipientEmail)}
                      </p>
                      <p className="text-xs text-gray-500 truncate" title={detail?.recipientEmail ?? selectedRow.recipientEmail}>
                        {detail?.recipientEmail ?? selectedRow.recipientEmail}
                      </p>
                    </div>
                    <div className="flex-shrink-0 min-w-0 max-w-[42%] text-right">
                      <p
                        className="text-xs text-gray-400 mt-0.5 truncate"
                        title={detail?.campaignName ?? selectedRow.campaignName}
                      >
                        {detail?.campaignName ?? selectedRow.campaignName}
                      </p>
                    </div>
                  </div>
                </div>

                <div ref={messagesContainerRef} className="flex-1 min-h-0 p-5 overflow-y-auto overscroll-y-contain space-y-4 bg-gray-50/50">
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
                          style={outbound ? { backgroundColor: '#2563eb', borderColor: '#1d4ed8', color: '#ffffff', maxWidth: 'min(100%, 36rem)' } : { maxWidth: 'min(100%, 36rem)' }}
                          className={`rounded-xl px-4 py-3 shadow-sm border ${
                            outbound
                              ? ''
                              : inboundSystem
                                ? 'bg-amber-50 border-amber-200 text-amber-900'
                                : 'bg-white border-gray-200 text-gray-900'
                          }`}
                        >
                          <div
                            style={outbound ? { color: '#bfdbfe' } : undefined}
                            className={`flex items-center justify-between gap-3 mb-2 ${outbound ? '' : 'text-gray-500'}`}
                          >
                            <span className="text-xs font-medium">
                              {outbound ? 'You' : displayNameFromEmail(m.fromEmail)}
                            </span>
                            <span className="text-xs" style={{ opacity: 0.9 }}>{formatFullDate(m.receivedAt)}</span>
                          </div>
                          {outbound ? (
                            <div style={{ color: '#ffffff', fontSize: '0.875rem', lineHeight: '1.25rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              {outboundText}
                            </div>
                          ) : m.bodyHtml ? (
                            <div
                              className="prose prose-sm max-w-none text-gray-700"
                              dangerouslySetInnerHTML={{ __html: m.bodyHtml }}
                            />
                          ) : (
                            <p className="text-sm whitespace-pre-wrap text-gray-700">
                              {m.bodyText || '(no content)'}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                    })
                  ) : null}
                </div>

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
                      placeholder="Write a reply..."
                      title="Press Enter to send, Shift+Enter for a new line"
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
                      placeholder="Loading conversation..."
                      rows={3}
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 text-sm resize-none cursor-wait"
                    />
                  </div>
                ) : detailLoading ? (
                  <div className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50 text-sm text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
                    Loading conversation…
                  </div>
                ) : (
                  <div className="flex-shrink-0 p-4 border-t border-gray-200 bg-amber-50 text-sm text-amber-800">
                    System notifications are read-only.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
