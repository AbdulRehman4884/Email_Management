import React, { useEffect, useState } from 'react';
import { Inbox as InboxIcon, Loader2, Send } from 'lucide-react';
import { repliesApi, type ReplyListItem, type ReplyDetail } from '../lib/api';
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
  } catch { return s; }
}

function formatFullDate(s: string) {
  try {
    const d = new Date(s);
    return d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return s; }
}

export function Inbox() {
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [sendReplyError, setSendReplyError] = useState<string | null>(null);
  const limit = 20;

  useEffect(() => {
    setLoading(true);
    repliesApi.getReplies({ page, limit })
      .then(({ replies: list, total: t }) => { setReplies(list); setTotal(t); })
      .catch(() => setReplies([]))
      .finally(() => setLoading(false));
  }, [page]);

  const openDetail = (id: number) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setReplyText('');
    setSendReplyError(null);
    repliesApi.getReplyById(id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  };

  const handleSendReply = async () => {
    if (!detail || !replyText.trim() || isSendingReply) return;
    setIsSendingReply(true);
    setSendReplyError(null);
    try {
      await repliesApi.sendReply(detail.id, replyText.trim());
      setReplyText('');
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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Inbox</h1>
        <p className="text-gray-500 mt-0.5 text-sm">{total} unread replies</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      ) : replies.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl">
          <EmptyState
            icon={<InboxIcon className="w-8 h-8 text-gray-400" />}
            title="No replies yet"
            description="When recipients reply to your campaign emails, they'll show up here."
          />
        </div>
      ) : (
        <div className="flex gap-0 bg-white border border-gray-200 rounded-xl overflow-hidden" style={{ minHeight: '500px' }}>
          {/* Left: Email List */}
          <div className="w-80 lg:w-96 border-r border-gray-200 flex-shrink-0 overflow-y-auto">
            {replies.map((r) => (
              <button
                key={r.id}
                onClick={() => openDetail(r.id)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                  selectedId === r.id ? 'bg-gray-50' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(r.fromEmail)}`}>
                    <span className="text-white text-xs font-semibold">{getInitials(r.fromEmail)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900 text-sm truncate">
                        {r.fromEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </p>
                      <span className="text-xs text-gray-400 flex-shrink-0">{formatShortDate(r.receivedAt)}</span>
                    </div>
                    <p className="text-xs text-gray-600 truncate mt-0.5">{r.subject}</p>
                    <p className="text-xs text-gray-400 truncate mt-0.5">{r.snippet}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Right: Email Detail */}
          <div className="flex-1 flex flex-col min-w-0">
            {detailLoading ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
              </div>
            ) : detail ? (
              <>
                <div className="p-5 border-b border-gray-200">
                  <h2 className="text-lg font-semibold text-gray-900">{detail.subject}</h2>
                  <div className="flex items-center gap-3 mt-3">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${getAvatarColor(detail.fromEmail)}`}>
                      <span className="text-white text-xs font-semibold">{getInitials(detail.fromEmail)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">
                        {detail.fromEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </p>
                      <p className="text-xs text-gray-500">{detail.fromEmail}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-gray-500">{formatFullDate(detail.receivedAt)}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{detail.campaignName}</p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 p-5 overflow-y-auto">
                  {detail.bodyHtml ? (
                    <div className="prose prose-sm max-w-none text-gray-700" dangerouslySetInnerHTML={{ __html: detail.bodyHtml }} />
                  ) : (
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{detail.bodyText || '(no content)'}</p>
                  )}
                </div>

                <div className="p-4 border-t border-gray-200">
                  <textarea
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    placeholder="Write a reply..."
                    rows={3}
                    className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent resize-none"
                  />
                  {sendReplyError && (
                    <p className="mt-2 text-sm text-red-600">{sendReplyError}</p>
                  )}
                  <div className="flex justify-end mt-2">
                    <Button
                      size="sm"
                      leftIcon={<Send className="w-3.5 h-3.5" />}
                      onClick={handleSendReply}
                      disabled={!replyText.trim() || isSendingReply}
                      isLoading={isSendingReply}
                    >
                      Send reply
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
                Select an email to view
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
