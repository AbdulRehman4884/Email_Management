import React, { useEffect, useState } from 'react';
import { Inbox as InboxIcon, Loader2 } from 'lucide-react';
import { repliesApi, type ReplyListItem, type ReplyDetail } from '../lib/api';
import { Button, Card, CardContent, EmptyState, Modal } from '../components/ui';

function formatDate(s: string) {
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch {
    return s;
  }
}

export function Inbox() {
  const [replies, setReplies] = useState<ReplyListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<ReplyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const limit = 20;

  useEffect(() => {
    setLoading(true);
    repliesApi
      .getReplies({ page, limit })
      .then(({ replies: list, total: t }) => {
        setReplies(list);
        setTotal(t);
      })
      .catch(() => setReplies([]))
      .finally(() => setLoading(false));
  }, [page]);

  const openDetail = (id: number) => {
    setDetail(null);
    setDetailLoading(true);
    repliesApi
      .getReplyById(id)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Inbox</h1>
        <p className="text-gray-400 mt-1">Replies to your campaign emails</p>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
            </div>
          ) : replies.length === 0 ? (
            <EmptyState
              icon={<InboxIcon className="w-12 h-12 text-gray-500" />}
              title="No replies yet"
              description="When recipients reply to your campaign emails, they will appear here. Configure your inbound email provider to POST to /api/webhooks/inbound-email."
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Campaign</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">From</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Subject</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Date</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {replies.map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => openDetail(r.id)}
                        className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4 text-white font-medium">{r.campaignName}</td>
                        <td className="py-3 px-4 text-gray-300">{r.fromEmail}</td>
                        <td className="py-3 px-4 text-gray-300 max-w-xs truncate" title={r.subject}>
                          {r.subject}
                        </td>
                        <td className="py-3 px-4 text-gray-500 text-sm">{formatDate(r.receivedAt)}</td>
                        <td className="py-3 px-4">
                          <Button variant="ghost" size="sm">
                            View
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between py-3 px-4 border-t border-gray-800">
                  <p className="text-sm text-gray-400">
                    Page {page} of {totalPages} ({total} replies)
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Modal
        isOpen={detail !== null || detailLoading}
        onClose={() => {
          setDetail(null);
          setDetailLoading(false);
        }}
        title={detail ? detail.subject : 'Loading…'}
        size="xl"
      >
        {detailLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Campaign</span>
                <p className="text-white font-medium">{detail.campaignName}</p>
              </div>
              <div>
                <span className="text-gray-500">Recipient</span>
                <p className="text-white">{detail.recipientEmail}</p>
              </div>
              <div>
                <span className="text-gray-500">From</span>
                <p className="text-white">{detail.fromEmail}</p>
              </div>
              <div>
                <span className="text-gray-500">Date</span>
                <p className="text-white">{formatDate(detail.receivedAt)}</p>
              </div>
            </div>
            <div>
              <span className="text-gray-500 text-sm block mb-1">Message</span>
              {detail.bodyHtml ? (
                <div
                  className="prose prose-invert prose-sm max-h-96 overflow-y-auto rounded-lg bg-gray-800/50 p-4"
                  dangerouslySetInnerHTML={{ __html: detail.bodyHtml }}
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm text-gray-300 bg-gray-800/50 rounded-lg p-4 max-h-96 overflow-y-auto">
                  {detail.bodyText || '(no content)'}
                </pre>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
