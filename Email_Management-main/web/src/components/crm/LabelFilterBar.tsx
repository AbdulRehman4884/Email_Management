import React from 'react';
import { REPLY_LABELS, REPLY_LABEL_META, type ReplyLabel } from '../../lib/replyLabels';

export type ReplySortMode = 'interested' | 'newest';

interface LabelFilterBarProps {
  selected: ReplyLabel[];
  onChange: (labels: ReplyLabel[]) => void;
  sort: ReplySortMode;
  onSortChange: (sort: ReplySortMode) => void;
}

const chipBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  border: '1px solid #e5e7eb',
  backgroundColor: '#ffffff',
  color: '#4b5563',
};

/** Label filter chips + sort toggle for the Inbox (CRM step 2). Several labels can be picked at once. */
export function LabelFilterBar({ selected, onChange, sort, onSortChange }: LabelFilterBarProps) {
  const toggle = (l: ReplyLabel) => {
    onChange(selected.includes(l) ? selected.filter((x) => x !== l) : [...selected, l]);
  };
  const allActive = selected.length === 0;

  return (
    <div className="mobile-filter-scroll-inner" style={{ gap: 6, alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => onChange([])}
        aria-pressed={allActive}
        style={{
          ...chipBase,
          ...(allActive ? { backgroundColor: '#111827', borderColor: '#111827', color: '#ffffff' } : {}),
        }}
      >
        All labels
      </button>
      {REPLY_LABELS.map((l) => {
        const m = REPLY_LABEL_META[l];
        const active = selected.includes(l);
        return (
          <button
            key={l}
            type="button"
            onClick={() => toggle(l)}
            aria-pressed={active}
            style={{
              ...chipBase,
              ...(active
                ? { backgroundColor: `${m.color}1f`, borderColor: m.color, color: '#111827', fontWeight: 600 }
                : {}),
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: m.color }} />
            {m.name}
          </button>
        );
      })}
      <span style={{ width: 1, alignSelf: 'stretch', backgroundColor: '#e5e7eb', margin: '0 4px', flexShrink: 0 }} />
      <button
        type="button"
        onClick={() => onSortChange(sort === 'interested' ? 'newest' : 'interested')}
        title="Change the order of the list"
        style={chipBase}
      >
        {sort === 'interested' ? 'Sort: Interested first' : 'Sort: Newest first'}
      </button>
    </div>
  );
}
