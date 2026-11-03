import { useCallback, useEffect, useRef, useState } from 'react';
import { userApi, type UserNotificationRow } from './api';

/** "waiting 45 min" / "waiting 5 hours" / "waiting 2 days" (same wording as the backend). */
export function waitingText(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return 'waiting';
  if (hours < 1) return `waiting ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) {
    const h = Math.floor(hours);
    return `waiting ${h} hour${h === 1 ? '' : 's'}`;
  }
  return `waiting ${Math.floor(hours / 24)} days`;
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export interface NotificationView {
  title: string;
  body: string | null;
  /** Where clicking it goes. */
  href: string | null;
  tone: 'reply' | 'crm' | 'warning' | 'error';
  high: boolean;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** How one notification is shown in the bell and in toasts. */
export function describeNotification(n: UserNotificationRow): NotificationView {
  const p = n.payload ?? {};
  switch (n.type) {
    case 'needs_reply': {
      const who = str(p.name) ?? str(p.email) ?? 'A lead';
      const thread = num(p.threadRootId);
      const reply = num(p.replyId);
      const hours = num(p.waitingHours);
      return {
        title: `${who} is ${hours != null ? waitingText(hours) : 'waiting'} for your reply`,
        body: str(p.replySnippet),
        href: thread != null ? `/inbox?tab=needs_reply&thread=${thread}${reply != null ? `&reply=${reply}` : ''}` : '/inbox?tab=needs_reply',
        tone: 'reply',
        high: p.priority === 'high',
      };
    }
    case 'crm_rule': {
      // CRM-07: open the conversation when the rule came from a reply, else the lead's panel.
      const thread = num(p.threadRootId);
      const reply = num(p.replyId);
      const lead = num(p.contactId);
      const href =
        thread != null ? `/inbox?thread=${thread}${reply != null ? `&reply=${reply}` : ''}`
          : lead != null ? `/crm?lead=${lead}`
            : '/crm';
      return { title: str(p.message) ?? 'A lead moved to a new stage', body: null, href, tone: 'crm', high: false };
    }
    case 'crm_digest_failed':
      return { title: 'Daily reply digest was not sent', body: str(p.message), href: '/settings', tone: 'error', high: false };
    case 'smtp_daily_limit':
    case 'daily_campaign_cap':
    case 'send_window_closed': {
      const id = num(p.campaignId);
      const title =
        n.type === 'smtp_daily_limit' ? 'SMTP daily limit reached, campaign paused'
          : n.type === 'daily_campaign_cap' ? 'Campaign daily cap reached, campaign paused'
            : 'Campaign paused outside its send window';
      return { title, body: null, href: id != null ? `/campaigns/${id}` : '/campaigns', tone: 'warning', high: false };
    }
    default:
      return { title: str(p.message) ?? 'Notification', body: null, href: null, tone: 'warning', high: false };
  }
}

const POLL_MS = 60_000;

/**
 * The logged-in user's notifications for the bell (CRM step 6). Polls every minute.
 * `onNew` is called once for each unread notification that arrived since the last poll
 * (remembered per user in localStorage, so a reload does not repeat old toasts).
 */
export function useNotifications(userId: number | null, onNew: (items: UserNotificationRow[]) => void) {
  const [notifications, setNotifications] = useState<UserNotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;
  const key = userId ? `notif-last-seen-${userId}` : null;

  const refresh = useCallback(async () => {
    if (!userId || !key) return;
    try {
      const r = await userApi.getNotifications();
      setNotifications(r.notifications);
      setUnreadCount(r.unreadCount);
      let lastSeen = 0;
      try {
        lastSeen = Number(window.localStorage.getItem(key)) || 0;
      } catch {
        // storage blocked: toasts may repeat after a reload, nothing else breaks
      }
      const fresh = r.notifications.filter((n) => n.readAt == null && n.id > lastSeen);
      const maxId = r.notifications.reduce((m, n) => Math.max(m, n.id), lastSeen);
      if (maxId > lastSeen) {
        try {
          window.localStorage.setItem(key, String(maxId));
        } catch {
          // ignore
        }
      }
      if (fresh.length) onNewRef.current(fresh);
    } catch {
      // non-blocking: the bell just keeps the last data
    }
  }, [userId, key]);

  useEffect(() => {
    if (!userId) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [userId, refresh]);

  const markRead = useCallback(async (id: number) => {
    setNotifications((list) => list.map((n) => (n.id === id && n.readAt == null ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await userApi.markNotificationRead(id);
    } catch {
      void refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    setNotifications((list) => list.map((n) => (n.readAt == null ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount(0);
    try {
      await userApi.markNotificationsReadAll();
    } catch {
      void refresh();
    }
  }, [refresh]);

  return { notifications, unreadCount, refresh, markRead, markAllRead };
}
