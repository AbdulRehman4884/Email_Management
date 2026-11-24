import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Pin, X } from 'lucide-react';
import { agentChatsApi, type AgentChatSummary } from '../lib/api';
import { relativeTime } from './ChatSidebar';

/** Search chats by name (like ChatGPT's search): empty box = recent chats; click opens the chat. */
export function ChatSearchDialog(props: { open: boolean; onClose: () => void; onOpenChat: (sessionId: string) => void }) {
  const { open, onClose, onOpenChat } = props;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AgentChatSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults(null);
    setFailed(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Server search, a short moment after typing stops.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      const chats = await agentChatsApi.list(query.trim() || undefined);
      if (mine !== seq.current) return;
      setFailed(chats === null);
      setResults(chats ?? []);
    }, query ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="chat-search-backdrop" data-testid="chat-search-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="chat-search-dialog" role="dialog" aria-modal="true" aria-label="Search chats" data-testid="chat-search-dialog">
        <div className="chat-search-top">
          <input
            ref={inputRef}
            type="search"
            aria-label="Search chats"
            placeholder="Search chats…"
            value={query}
            maxLength={100}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" aria-label="Close search" data-testid="chat-search-close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="chat-search-heading">{query.trim() ? 'Results' : 'Recent chats'}</p>
        <div className="chat-search-results">
          {results === null ? (
            <p className="chat-search-note">Searching…</p>
          ) : failed ? (
            <p className="chat-search-note">Chat history isn&apos;t available right now.</p>
          ) : results.length === 0 ? (
            <p className="chat-search-note" data-testid="chat-search-empty">
              {query.trim() ? `No chats named “${query.trim()}”.` : 'No chats yet.'}
            </p>
          ) : (
            <ul>
              {results.map((c) => (
                <li key={c.sessionId}>
                  <button
                    type="button"
                    data-testid="chat-search-result"
                    onClick={() => {
                      onClose();
                      onOpenChat(c.sessionId);
                    }}
                  >
                    {c.pinned ? <Pin className="w-4 h-4 flex-shrink-0" /> : <MessageCircle className="w-4 h-4 flex-shrink-0" />}
                    <span className="chat-search-title">{c.title}</span>
                    <span className="chat-search-time">{relativeTime(c.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
