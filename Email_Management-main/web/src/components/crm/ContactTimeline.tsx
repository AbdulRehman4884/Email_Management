import React, { useState } from 'react';
import { ArrowRightLeft, Eye, Gauge, Mail, MessageSquare, Reply, Send } from 'lucide-react';
import type { CrmTimelineItem } from '../../lib/api';
import { REPLY_LABEL_META, isReplyLabel } from '../../lib/replyLabels';

const ICON: Record<CrmTimelineItem['type'], { Icon: typeof Mail; color: string; name: string }> = {
  sent: { Icon: Send, color: '#6366f1', name: 'Email sent' },
  opened: { Icon: Eye, color: '#0ea5e9', name: 'Opened' },
  reply: { Icon: MessageSquare, color: '#16a34a', name: 'Reply' },
  you_replied: { Icon: Reply, color: '#0d9488', name: 'You replied' },
  follow_up: { Icon: Mail, color: '#a855f7', name: 'Follow-up sent' },
  stage: { Icon: ArrowRightLeft, color: '#f59e0b', name: 'Stage' },
  score: { Icon: Gauge, color: '#64748b', name: 'Score' },
};

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Lead timeline (CRM step 8): emails, opens, replies, stage moves and score changes, newest first. */
export function ContactTimeline({ items }: { items: CrmTimelineItem[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 12);
  if (items.length === 0) return <p className="text-xs text-gray-400">Nothing yet</p>;
  return (
    <div>
      <ol style={{ position: 'relative', paddingLeft: 26 }}>
        <span style={{ position: 'absolute', left: 10, top: 4, bottom: 4, width: 1, background: 'var(--crm-border, #e5e7eb)' }} />
        {shown.map((t, i) => {
          const meta = ICON[t.type] ?? ICON.score;
          const label = t.type === 'reply' && isReplyLabel(t.label) ? REPLY_LABEL_META[t.label] : null;
          return (
            <li key={`${t.type}-${t.at}-${i}`} style={{ position: 'relative', paddingBottom: 10 }}>
              <span
                style={{
                  position: 'absolute',
                  left: -26,
                  top: 0,
                  width: 21,
                  height: 21,
                  borderRadius: 999,
                  background: 'var(--crm-surface, #fff)',
                  border: `1px solid ${meta.color}55`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <meta.Icon size={11} color={meta.color} />
              </span>
              <div className="text-xs text-gray-400" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: meta.color }}>{meta.name}</span>
                {label && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'inherit' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: label.color }} /> {label.name}
                  </span>
                )}
                {t.points != null && (
                  <span style={{ fontWeight: 700, color: t.points >= 0 ? '#15803d' : '#b91c1c' }}>{t.points > 0 ? '+' : ''}{t.points}</span>
                )}
                <span>· {fmt(t.at)}</span>
              </div>
              <p className="text-sm text-gray-900" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</p>
              {t.detail && (
                <p className="text-xs text-gray-500" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.detail}</p>
              )}
            </li>
          );
        })}
      </ol>
      {items.length > 12 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-gray-600" style={{ textDecoration: 'underline' }}>
          {all ? 'Show less' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
