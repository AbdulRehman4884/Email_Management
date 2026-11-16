import React from 'react';
import type { CrmContact } from '../../lib/api';
import { REPLY_LABEL_META, isReplyLabel } from '../../lib/replyLabels';
import { TagList } from './TagChip';
import { ScoreBadge } from './ScoreBadge';

/** Small dot + name of the lead's latest reply label. */
export function LabelDot({ label, showName = true }: { label: string | null | undefined; showName?: boolean }) {
  if (!isReplyLabel(label)) {
    return showName ? <span className="text-xs text-gray-400">No reply yet</span> : null;
  }
  const meta = REPLY_LABEL_META[label];
  return (
    <span title={`Latest reply: ${meta.name}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--crm-text-2, #374151)', whiteSpace: 'nowrap' }}>
      <span style={{ width: 9, height: 9, borderRadius: 999, background: meta.color, flexShrink: 0 }} />
      {showName && meta.name}
    </span>
  );
}

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return null;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

interface ContactCardProps {
  contact: CrmContact;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}

/** One lead in the leads grid: name, latest reply color, stage, tags. Click opens the drawer. */
export function ContactCard({ contact, selected, onToggle, onOpen }: ContactCardProps) {
  const labelColor = isReplyLabel(contact.lastReplyLabel) ? REPLY_LABEL_META[contact.lastReplyLabel].color : '#e5e7eb';
  const last = timeAgo(contact.lastInboundAt);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className="bg-white rounded-xl hover:bg-gray-50"
      style={{
        position: 'relative',
        // Separate sides (not `border` + `borderLeft`) so React never mixes shorthand and longhand.
        borderTop: `1px solid ${selected ? '#111827' : '#e5e7eb'}`,
        borderRight: `1px solid ${selected ? '#111827' : '#e5e7eb'}`,
        borderBottom: `1px solid ${selected ? '#111827' : '#e5e7eb'}`,
        borderLeft: `4px solid ${labelColor}`,
        boxShadow: selected ? '0 0 0 1px #111827' : undefined,
        padding: '12px 12px 12px 14px',
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${contact.email}`}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggle}
          style={{ marginTop: 3, flexShrink: 0, width: 15, height: 15 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <p className="text-sm font-semibold text-gray-900 truncate" style={{ flex: 1, minWidth: 0 }}>{contact.name || contact.email}</p>
            <ScoreBadge score={contact.score} tier={contact.scoreTier} />
          </div>
          {contact.name && <p className="text-xs text-gray-500 truncate">{contact.email}</p>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <LabelDot label={contact.lastReplyLabel} />
            {contact.stageName && (
              <span
                style={{
                  fontSize: 11,
                  padding: '0 7px',
                  lineHeight: '18px',
                  borderRadius: 999,
                  background: `${contact.stageColor ?? '#6b7280'}1f`,
                  border: `1px solid ${contact.stageColor ?? '#6b7280'}55`,
                  color: 'var(--crm-text, #1f2937)',
                  whiteSpace: 'nowrap',
                }}
              >
                {contact.stageName}
              </span>
            )}
            {last && <span className="text-xs text-gray-400">{last}</span>}
          </div>
          {contact.tags.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <TagList tags={contact.tags} max={3} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
