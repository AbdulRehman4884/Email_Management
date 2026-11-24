/**
 * src/components/ChatSidebar.tsx
 *
 * The AI Agent's chats, always visible next to the chat (like ChatGPT's sidebar): New chat + Search, then
 * "Pinned" (at most 3) and "Recent". Each chat has a ⋯ menu: Pin / Unpin, Rename, Delete.
 * The server keeps every chat for 30 days after its last message; pinned chats until they are unpinned.
 * On phones the sidebar is a drawer opened with the ☰ button.
 */

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react';
import type { AgentChatSummary } from '../lib/api';

export const MAX_PINNED_CHATS = 3;
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
  onOpenSearch?: () => void;
  onPinChat?: (chat: AgentChatSummary, pinned: boolean) => void;
  /** Resolves true when the new name was saved. */
  onRenameChat?: (chat: AgentChatSummary, title: string) => Promise<boolean>;
}

export function ChatSidebar(props: ChatSidebarProps) {
  const { chats, activeSessionId, disabled, open, collapsed = false, onClose, onNewChat, onOpenSearch } = props;
  const all = Array.isArray(chats) ? chats : [];
  const pinned = all.filter((c) => c.pinned);
  const recent = all.filter((c) => !c.pinned);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const rows = (list: AgentChatSummary[]) => (
    <ul className="chat-sidebar-list">
      {list.map((chat) => (
        <ChatRow
          {...props}
          key={chat.sessionId}
          chat={chat}
          active={chat.sessionId === activeSessionId}
          disabled={disabled}
          menuOpen={menuFor === chat.sessionId}
          renaming={renaming === chat.sessionId}
          canPin={pinned.length < MAX_PINNED_CHATS}
          onToggleMenu={() => setMenuFor((m) => (m === chat.sessionId ? null : chat.sessionId))}
          onCloseMenu={() => setMenuFor(null)}
          onStartRename={() => {
            setMenuFor(null);
            setRenaming(chat.sessionId);
          }}
          onEndRename={() => setRenaming(null)}
        />
      ))}
    </ul>
  );

  return (
    <>
      {open && <div className="chat-sidebar-backdrop" data-testid="chat-sidebar-backdrop" onClick={onClose} />}
      <aside
        className="chat-sidebar"
        data-open={open ? 'true' : 'false'}
        data-collapsed={collapsed ? 'true' : 'false'}
        data-testid="chat-sidebar"
        aria-label="Chats"
      >
        <div className="chat-sidebar-top">
          <button type="button" className="chat-sidebar-new" data-testid="sidebar-new-chat" disabled={disabled} onClick={onNewChat}>
            <Plus className="w-4 h-4" /> New chat
          </button>
          {onOpenSearch && (
            <button
              type="button"
              className="chat-sidebar-icon"
              data-testid="sidebar-search"
              aria-label="Search chats"
              title="Search chats"
              disabled={disabled || chats === false}
              onClick={onOpenSearch}
            >
              <Search className="w-4 h-4" />
            </button>
          )}
          <button type="button" className="chat-sidebar-close" aria-label="Close chats" data-testid="sidebar-close" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="chat-sidebar-scroll">
          {chats === null ? (
            <>
              <p className="chat-sidebar-heading">Recent</p>
              <p className="chat-sidebar-note" data-testid="sidebar-loading">Loading…</p>
            </>
          ) : chats === false ? (
            <>
              <p className="chat-sidebar-heading">Recent</p>
              <p className="chat-sidebar-note" data-testid="sidebar-unavailable">
                Chat history isn&apos;t available right now. This chat is kept in this browser.
              </p>
            </>
          ) : (
            <>
              {pinned.length > 0 && (
                <section data-testid="sidebar-pinned">
                  <p className="chat-sidebar-heading">Pinned</p>
                  {rows(pinned)}
                </section>
              )}
              <section data-testid="sidebar-recent">
                <p className="chat-sidebar-heading">Recent</p>
                {recent.length === 0 ? (
                  <p className="chat-sidebar-note" data-testid="sidebar-empty">
                    {pinned.length ? 'No other chats.' : 'No chats yet. Your chats appear here once you send a message.'}
                  </p>
                ) : (
                  rows(recent)
                )}
              </section>
            </>
          )}
        </div>

        <p className="chat-sidebar-footer">
          Chats are kept for {RETENTION_DAYS} days after the last message. Pinned chats stay until you unpin them.
        </p>
      </aside>
    </>
  );
}

function ChatRow(
  p: ChatSidebarProps & {
    chat: AgentChatSummary;
    active: boolean;
    menuOpen: boolean;
    renaming: boolean;
    canPin: boolean;
    onToggleMenu: () => void;
    onCloseMenu: () => void;
    onStartRename: () => void;
    onEndRename: () => void;
  },
) {
  const { chat, active, disabled, menuOpen, renaming } = p;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState(chat.title);
  const [saving, setSaving] = useState(false);

  // Close the menu on a click outside it or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) p.onCloseMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onCloseMenu();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, p]);

  useEffect(() => {
    if (renaming) setDraft(chat.title);
  }, [renaming, chat.title]);

  const saveName = async () => {
    const name = draft.replace(/\s+/g, ' ').trim();
    if (!name || name === chat.title || !p.onRenameChat) {
      p.onEndRename();
      return;
    }
    setSaving(true);
    const ok = await p.onRenameChat(chat, name);
    setSaving(false);
    if (ok) p.onEndRename();
  };

  return (
    <li className="chat-sidebar-row" data-active={active ? 'true' : 'false'} data-menu-open={menuOpen ? 'true' : 'false'} data-testid="chat-history-item">
      {renaming ? (
        <input
          className="chat-sidebar-rename"
          aria-label="Chat name"
          autoFocus
          value={draft}
          maxLength={80}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void saveName();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              p.onEndRename();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="chat-sidebar-item"
          disabled={disabled}
          aria-current={active ? 'true' : undefined}
          title={chat.title}
          onClick={() => p.onOpenChat(chat.sessionId)}
        >
          <span className="chat-sidebar-title">
            {chat.pinned && <Pin className="chat-sidebar-pin-icon" aria-label="Pinned" />}
            {chat.title}
          </span>
          <span className="chat-sidebar-time">{relativeTime(chat.updatedAt)}</span>
        </button>
      )}
      {!renaming && (
        <div className="chat-sidebar-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="chat-sidebar-more"
            aria-label={`Chat options for ${chat.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={disabled}
            onClick={p.onToggleMenu}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="chat-sidebar-menu" role="menu" data-testid="chat-menu">
              {p.onPinChat && (
                <button
                  type="button"
                  role="menuitem"
                  disabled={!chat.pinned && !p.canPin}
                  title={!chat.pinned && !p.canPin ? `You can pin up to ${MAX_PINNED_CHATS} chats. Unpin one first.` : undefined}
                  onClick={() => {
                    p.onCloseMenu();
                    p.onPinChat?.(chat, !chat.pinned);
                  }}
                >
                  {chat.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                  {chat.pinned ? 'Unpin' : 'Pin'}
                </button>
              )}
              {p.onRenameChat && (
                <button type="button" role="menuitem" onClick={p.onStartRename}>
                  <Pencil className="w-4 h-4" /> Rename
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="chat-sidebar-menu-danger"
                aria-label={`Delete chat ${chat.title}`}
                onClick={() => {
                  p.onCloseMenu();
                  p.onDeleteChat(chat);
                }}
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
