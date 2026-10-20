import React, { useEffect, useRef, useState } from 'react';
import { Check, Plus, Tag as TagIcon, X } from 'lucide-react';
import type { CrmTag } from '../../lib/api';

/** #f00 -> #ff0000, so "color + alpha" (e.g. #ff00001a) is always a valid CSS color. */
export function hex6(color: string): string {
  return /^#[0-9a-f]{3}$/i.test(color) ? `#${color.slice(1).split('').map((x) => x + x).join('')}` : color;
}

/** One colored tag. With `onRemove` it shows a small × button. */
export function TagChip({ tag, onRemove, size = 'sm' }: { tag: Pick<CrmTag, 'id' | 'name' | 'color'>; onRemove?: () => void; size?: 'xs' | 'sm' }) {
  const small = size === 'xs';
  const color = hex6(tag.color);
  return (
    <span
      title={tag.name}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: 180,
        padding: small ? '0 6px' : '1px 8px',
        borderRadius: 999,
        fontSize: small ? 11 : 12,
        lineHeight: small ? '18px' : '20px',
        fontWeight: 500,
        background: `${color}1a`,
        border: `1px solid ${color}59`,
        color: 'var(--crm-text, #1f2937)',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${tag.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{ display: 'inline-flex', marginRight: -3, color: '#6b7280', padding: 1, borderRadius: 999 }}
          className="hover:bg-gray-100"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/** Up to `max` chips, then "+N". */
export function TagList({ tags, max = 3, size = 'xs' }: { tags: Array<Pick<CrmTag, 'id' | 'name' | 'color'>>; max?: number; size?: 'xs' | 'sm' }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const more = tags.length - shown.length;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {shown.map((t) => (
        <TagChip key={t.id} tag={t} size={size} />
      ))}
      {more > 0 && (
        <span className="text-xs text-gray-500" title={tags.slice(max).map((t) => t.name).join(', ')}>
          +{more}
        </span>
      )}
    </span>
  );
}

interface TagPickerProps {
  /** All tags the user has. */
  tags: CrmTag[];
  /** Tags already set (shown with a check; clicking them calls onRemove when given). */
  selectedIds: number[];
  onAdd: (tag: CrmTag) => void | Promise<void>;
  onRemove?: (tag: CrmTag) => void | Promise<void>;
  /** Makes a new tag from the typed name and returns it. Hidden when not given. */
  onCreate?: (name: string) => Promise<CrmTag>;
  /** Where the tag will go: hides tags that are only for the other kind. */
  target: 'contact' | 'campaign';
  label?: string;
  disabled?: boolean;
}

/** "+ Tag" button with a searchable menu. The menu is position:fixed so drawers and tables never cut it off. */
export function TagPicker({ tags, selectedIds, onAdd, onRemove, onCreate, target, label = 'Tag', disabled }: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase on window + stopPropagation: Escape closes only this menu, not the drawer/modal around it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (wrapRef.current && e.target instanceof Node && wrapRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) {
      const width = 240;
      const height = 290;
      // Open below the button, or above it when there is no room (e.g. the bulk bar at the bottom).
      const top = r.bottom + 4 + height <= window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - height - 4);
      setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
    }
    setSearch('');
    setOpen(true);
  };

  const usable = tags.filter((t) => (t.scope ?? 'both') === 'both' || t.scope === target);
  const q = search.trim().toLowerCase();
  const list = usable.filter((t) => !q || t.name.toLowerCase().includes(q));
  const exact = tags.some((t) => t.name.toLowerCase() === q);

  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span ref={wrapRef} style={{ display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className="hover:bg-gray-50"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '1px 8px',
          borderRadius: 999,
          border: '1px dashed #d1d5db',
          fontSize: 12,
          lineHeight: '20px',
          color: '#4b5563',
          background: '#fff',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Plus size={12} /> {label}
      </button>
      {open && pos && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: 240,
            zIndex: 70,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,.12)',
            padding: 6,
          }}
        >
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={onCreate ? 'Search or create a tag' : 'Search tags'}
            maxLength={50}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onCreate && q && !exact) {
                e.preventDefault();
                void run(async () => {
                  const t = await onCreate(search.trim());
                  await onAdd(t);
                  setSearch('');
                });
              }
            }}
            style={{ width: '100%', height: 30, padding: '0 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, marginBottom: 4 }}
          />
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {list.map((t) => {
              const on = selectedIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy || (on && !onRemove)}
                  onClick={() => void run(() => (on ? onRemove?.(t) : onAdd(t)))}
                  className="hover:bg-gray-50"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 13, textAlign: 'left', color: '#111827' }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: 999, background: t.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                  {on && <Check size={14} color="#16a34a" />}
                </button>
              );
            })}
            {list.length === 0 && !onCreate && <p className="text-xs text-gray-500" style={{ padding: '6px 8px' }}>No tags found</p>}
            {onCreate && q && !exact && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const t = await onCreate(search.trim());
                    await onAdd(t);
                    setSearch('');
                  })
                }
                className="hover:bg-gray-50"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 13, color: '#111827' }}
              >
                <TagIcon size={13} /> Create “{search.trim()}”
              </button>
            )}
            {onCreate && !q && usable.length === 0 && (
              <p className="text-xs text-gray-500" style={{ padding: '6px 8px' }}>Type a name to create your first tag</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
