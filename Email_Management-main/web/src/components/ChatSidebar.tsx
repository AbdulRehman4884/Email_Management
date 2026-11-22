/**
 * src/components/ChatSidebar.tsx
 *
 * The AI Agent's recent chats, always visible next to the chat (like ChatGPT's sidebar).
 * Only the latest MAX_RECENT_CHATS are shown; the server keeps at most 10 chats and deletes any chat
 * 30 days after its last message. On phones the sidebar is a drawer opened with the ☰ button.
 */

import { Plus, Trash2, X } from 'lucide-react';
import type { AgentChatSummary } from '../lib/api';

export const MAX_RECENT_CHATS = 10;
export const RETENTION_DAYS = 30;

/** "Just now", "5m ago", "3h ago", "Yesterday", "4 days ago". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const minutes = Math.floor((now.getTime() - t.getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && t.toDateString() === now.toDateString()) return `${hours}h ago`;
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  return `${days} days ago`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

interface ChatSidebarProps {
  /** null = loading; false = history unavailable (the chat stays in this browser only). */
  chats: AgentChatSummary[] | null | false;
  activeSessionId: string | undefined;
  /** A reply is on its way (or an approval waits): switching chats is locked. */
  disabled: boolean;
  /** Phone drawer state. */
  open: boolean;
  /** Large screens: the sidebar is collapsed (hidden) by the toggle above the chat. */
  collapsed?: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onOpenChat: (sessionId: string) => void;
  onDeleteChat: (chat: AgentChatSummary) => void;
}

export function ChatSidebar({ chats, activeSessionId, disabled, open, collapsed = false, onClose, onNewChat, onOpenChat, onDeleteChat }: ChatSidebarProps) {
  const recent = Array.isArray(chats) ? chats.slice(0, MAX_RECENT_CHATS) : [];
  return (
    <>
      {open && <div className="chat-sidebar-backdrop" data-testid="chat-sidebar-backdrop" onClick={onClose} />}
      <aside
        className="chat-sidebar"
        data-open={open ? 'true' : 'false'}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-testid="chat-sidebar"
        aria-label="Recent chats"
      >
        <div className="chat-sidebar-top">
          <button type="button" className="chat-sidebar-new" data-testid="sidebar-new-chat" disabled={disabled} onClick={onNewChat}>
            <Plus className="w-4 h-4" /> New chat
          </button>
          <button type="button" className="chat-sidebar-close" aria-label="Close recent chats" data-testid="sidebar-close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="chat-sidebar-heading">Recent</p>

        {chats === null ? (
          <p className="chat-sidebar-note" data-testid="sidebar-loading">Loading…</p>
        ) : chats === false ? (
          <p className="chat-sidebar-note" data-testid="sidebar-unavailable">
            Chat history isn&apos;t available right now. This chat is kept in this browser.
          </p>
        ) : recent.length === 0 ? (
          <p className="chat-sidebar-note" data-testid="sidebar-empty">No chats yet. Your chats appear here once you send a message.</p>
        ) : (
          <ul className="chat-sidebar-list">
            {recent.map((chat) => {
              const active = chat.sessionId === activeSessionId;
              return (
                <li key={chat.sessionId} className="chat-sidebar-row" data-active={active ? 'true' : 'false'} data-testid="chat-history-item">
                  <button
                    type="button"
                    className="chat-sidebar-item"
                    disabled={disabled}
                    aria-current={active ? 'true' : undefined}
                    title={chat.title}
                    onClick={() => onOpenChat(chat.sessionId)}
                  >
                    <span className="chat-sidebar-title">{chat.title}</span>
                    <span className="chat-sidebar-time">{relativeTime(chat.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="chat-sidebar-delete"
                    aria-label={`Delete chat ${chat.title}`}
                    disabled={disabled}
                    onClick={() => onDeleteChat(chat)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="chat-sidebar-footer">
          Your last {MAX_RECENT_CHATS} chats are kept for {RETENTION_DAYS} days, then deleted.
        </p>
      </aside>
    </>
  );
}
