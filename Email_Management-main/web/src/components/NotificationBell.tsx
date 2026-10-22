import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, GitBranch, MessageSquareReply, XCircle } from 'lucide-react';
import type { UserNotificationRow } from '../lib/api';
import { describeNotification, timeAgo } from '../lib/notifications';

interface NotificationBellProps {
  notifications: UserNotificationRow[];
  unreadCount: number;
  onMarkRead: (id: number) => void;
  onMarkAllRead: () => void;
  /** Bell color on a dark or light header. */
  className?: string;
}

const TONE_ICON = {
  reply: { Icon: MessageSquareReply, color: '#dc2626', bg: '#fef2f2' },
  crm: { Icon: GitBranch, color: '#16a34a', bg: '#f0fdf4' },
  warning: { Icon: AlertTriangle, color: '#d97706', bg: '#fffbeb' },
  error: { Icon: XCircle, color: '#dc2626', bg: '#fef2f2' },
} as const;

/** Bell with the unread count. Clicking a "needs reply" notification opens that conversation in the Inbox. */
export function NotificationBell({ notifications, unreadCount, onMarkRead, onMarkAllRead, className }: NotificationBellProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const width = Math.min(380, window.innerWidth - 16);
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
    }
    setOpen(true);
  };

  const shown = notifications.slice(0, 30);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        title="Notifications"
        className={`hover:bg-gray-100 rounded-lg ${className ?? ''}`}
        style={{ position: 'relative', padding: 7, color: '#4b5563', display: 'inline-flex' }}
      >
        <Bell size={19} />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -6,
              right: -12,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 999,
              background: '#dc2626',
              color: '#fff',
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
              textAlign: 'center',
              border: '2px solid #fff',
              boxSizing: 'content-box',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Notifications"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: 'min(380px, calc(100vw - 16px))',
              maxHeight: 'min(520px, calc(100vh - 80px))',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 80,
              background: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              boxShadow: '0 14px 40px rgba(0,0,0,.16)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #f3f4f6' }}>
              <span className="text-sm font-semibold text-gray-900" style={{ flex: 1 }}>
                Notifications {unreadCount > 0 && <span className="text-gray-400" style={{ fontWeight: 400 }}>· {unreadCount} unread</span>}
              </span>
              {unreadCount > 0 && (
                <button type="button" onClick={onMarkAllRead} className="text-xs text-gray-600 hover:bg-gray-50 rounded-lg" style={{ padding: '3px 6px' }}>
                  Mark all read
                </button>
              )}
            </div>
            <div style={{ overflowY: 'auto' }}>
              {shown.length === 0 && <p className="text-sm text-gray-500" style={{ padding: 24, textAlign: 'center' }}>No notifications yet</p>}
              {shown.map((n) => {
                const v = describeNotification(n);
                const unread = n.readAt == null;
                const { Icon, color, bg } = TONE_ICON[v.tone];
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => {
                      if (unread) onMarkRead(n.id);
                      setOpen(false);
                      if (v.href) navigate(v.href);
                    }}
                    className="hover:bg-gray-50"
                    style={{
                      display: 'flex',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 14px',
                      borderBottom: '1px solid #f9fafb',
                      background: unread ? '#f9fafb' : '#fff',
                    }}
                  >
                    <span style={{ width: 30, height: 30, borderRadius: 999, background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon size={15} color={color} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="text-sm text-gray-900" style={{ display: 'block', fontWeight: unread ? 600 : 400 }}>
                        {v.title}
                        {v.high && (
                          <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#b91c1c', background: '#fee2e2', borderRadius: 999, padding: '1px 6px', verticalAlign: 1 }}>
                            HIGH
                          </span>
                        )}
                      </span>
                      {v.body && (
                        <span className="text-xs text-gray-500" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: 2 }}>
                          {v.body}
                        </span>
                      )}
                      <span className="text-xs text-gray-400" style={{ display: 'block', marginTop: 2 }}>{timeAgo(n.createdAtIso ?? n.createdAt)}</span>
                    </span>
                    {unread && <span style={{ width: 8, height: 8, borderRadius: 999, background: '#dc2626', marginTop: 6, flexShrink: 0 }} />}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
