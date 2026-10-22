import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlarmClock, Check, ChevronDown, Clock, Reply } from 'lucide-react';
import type { CrmWaitingLead } from '../../lib/api';
import { waitingText } from '../../lib/notifications';
import { ReplyLabelChip } from './ReplyLabelChip';

interface NeedsReplyListProps {
  leads: CrmWaitingLead[];
  snoozed: CrmWaitingLead[];
  loading: boolean;
  error: string | null;
  selectedThreadRootId: number | null;
  onOpen: (lead: CrmWaitingLead) => void;
  onSnooze: (lead: CrmWaitingLead, until: Date) => void;
  onDone: (lead: CrmWaitingLead) => void;
}

/** Snooze choices: 1 hour, tomorrow 9:00 (local time), 3 days. */
export function snoozeOptions(now = new Date()): Array<{ label: string; until: Date }> {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: '1 hour', until: new Date(now.getTime() + 3600_000) },
    { label: 'Tomorrow 9:00', until: tomorrow },
    { label: '3 days', until: new Date(now.getTime() + 3 * 86400_000) },
  ];
}

function SnoozeButton({ onPick }: { onPick: (until: Date) => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos(pos ? null : { top: Math.min(r.bottom + 4, window.innerHeight - 140), left: Math.max(8, Math.min(r.left, window.innerWidth - 168)) });
        }}
        className="hover:bg-gray-100 rounded-md text-xs text-gray-600"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 6px', border: '1px solid #e5e7eb' }}
      >
        <AlarmClock size={12} /> Snooze <ChevronDown size={11} />
      </button>
      {pos &&
        createPortal(
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 79 }} onClick={() => setPos(null)} />
            <div
              role="menu"
              style={{ position: 'fixed', top: pos.top, left: pos.left, width: 160, zIndex: 80, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,.12)', padding: 4 }}
            >
              {snoozeOptions().map((o) => (
                <button
                  key={o.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPos(null);
                    onPick(o.until);
                  }}
                  className="hover:bg-gray-50 text-sm text-gray-800"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px', borderRadius: 6 }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </>
  );
}

const fmtUntil = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Left list of the Inbox "Needs reply" tab (CRM step 6). */
export function NeedsReplyList({ leads, snoozed, loading, error, selectedThreadRootId, onOpen, onSnooze, onDone }: NeedsReplyListProps) {
  const [showSnoozed, setShowSnoozed] = useState(false);

  if (error) return <p className="text-sm text-gray-500" style={{ padding: 16 }}>{error}</p>;
  if (loading && leads.length === 0) return <p className="text-sm text-gray-400" style={{ padding: 16 }}>Loading…</p>;

  const row = (l: CrmWaitingLead, isSnoozed: boolean) => {
    const selected = l.threadRootId != null && l.threadRootId === selectedThreadRootId;
    const badgeColor = l.overdue ? { bg: '#fee2e2', fg: '#b91c1c', bd: '#fecaca' } : { bg: '#fef3c7', fg: '#92400e', bd: '#fde68a' };
    return (
      <div
        key={l.contactId}
        role="button"
        tabIndex={0}
        onClick={() => onOpen(l)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpen(l);
        }}
        className={selected ? 'bg-gray-50' : 'hover:bg-gray-50'}
        style={{ padding: '12px 14px', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', opacity: isSnoozed ? 0.75 : 1 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <p className="text-sm font-semibold text-gray-900 truncate" style={{ flex: 1, minWidth: 0 }}>{l.name || l.email}</p>
          {isSnoozed && l.snoozedUntil ? (
            <span className="text-xs text-gray-500" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
              <Clock size={11} /> {fmtUntil(l.snoozedUntil)}
            </span>
          ) : (
            <span
              title={l.overdue ? 'Overdue: reply soon' : `Reminder after ${l.dueHours}h`}
              style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: badgeColor.bg, color: badgeColor.fg, border: `1px solid ${badgeColor.bd}`, whiteSpace: 'nowrap' }}
            >
              {waitingText(l.waitingHours)}
            </span>
          )}
        </div>
        {l.name && <p className="text-xs text-gray-500 truncate">{l.email}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
          {l.label && <ReplyLabelChip label={l.label} />}
          {l.priority === 'high' && (
            <span style={{ fontSize: 10, fontWeight: 700, color: '#b91c1c', background: '#fee2e2', borderRadius: 999, padding: '1px 6px' }}>HIGH</span>
          )}
          {l.stageName && <span className="text-xs text-gray-400">{l.stageName}</span>}
        </div>
        {l.snippet && <p className="text-xs text-gray-600" style={{ marginTop: 5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{l.snippet}</p>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => onOpen(l)}
            className="rounded-md text-xs"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', background: '#111827', color: '#fff' }}
          >
            <Reply size={12} /> Reply
          </button>
          <SnoozeButton onPick={(until) => onSnooze(l, until)} />
          <button
            type="button"
            onClick={() => onDone(l)}
            title="No reply needed"
            className="hover:bg-gray-100 rounded-md text-xs text-gray-600"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 6px', border: '1px solid #e5e7eb' }}
          >
            <Check size={12} /> Done
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      {leads.length === 0 ? (
        <div style={{ padding: '28px 18px', textAlign: 'center' }}>
          <p className="text-sm font-semibold text-gray-900">Nobody is waiting for your reply</p>
          <p className="text-xs text-gray-500 mt-1">Leads show up here when they reply and you have not answered yet.</p>
        </div>
      ) : (
        leads.map((l) => row(l, false))
      )}
      {snoozed.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowSnoozed((v) => !v)}
            className="text-xs text-gray-500 hover:bg-gray-50"
            style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', padding: '10px 14px', borderBottom: '1px solid #f3f4f6' }}
          >
            <AlarmClock size={12} /> Snoozed ({snoozed.length}) {showSnoozed ? '▲' : '▼'}
          </button>
          {showSnoozed && snoozed.map((l) => row(l, true))}
        </>
      )}
    </div>
  );
}
