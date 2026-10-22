import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { REPLY_LABELS, REPLY_LABEL_META, isReplyLabel, type ReplyLabel } from '../../lib/replyLabels';

interface ReplyLabelChipProps {
  label: string | null | undefined;
  /** 'keyword' | 'ai' | 'manual' — shown in the tooltip. */
  source?: string | null;
  confidence?: number | null;
  /** When set, the chip opens a menu to change the label. Do not use inside another <button>. */
  onChange?: (label: ReplyLabel) => Promise<void> | void;
  size?: 'sm' | 'md';
}

const SOURCE_TEXT: Record<string, string> = {
  keyword: 'Labeled automatically',
  ai: 'Labeled by AI',
  manual: 'Labeled by you',
};

function tooltip(label: ReplyLabel | null, source?: string | null, confidence?: number | null): string {
  if (!label) return 'No label yet';
  const parts = [REPLY_LABEL_META[label].name];
  if (source && SOURCE_TEXT[source]) {
    parts.push(
      SOURCE_TEXT[source] + (source !== 'manual' && confidence != null ? ` (${Math.round(confidence * 100)}% sure)` : '')
    );
  }
  return parts.join(' · ');
}

/** Colored reply label (CRM step 2). Read-only unless `onChange` is given. */
export function ReplyLabelChip({ label, source, confidence, onChange, size = 'sm' }: ReplyLabelChipProps) {
  const current = isReplyLabel(label) ? label : null;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Menu is position:fixed so chat bubbles with overflow:hidden never cut it off. */
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const menuWidth = 200;
      const menuHeight = 7 * 32 + 8;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
      const below = rect.bottom + 4;
      const top = below + menuHeight > window.innerHeight - 8 ? Math.max(8, rect.top - menuHeight - 4) : below;
      setMenuPos({ top, left });
    }
    setOpen(true);
  };

  if (!current && !onChange) return null;

  const meta = current ? REPLY_LABEL_META[current] : null;
  const fontSize = size === 'sm' ? 10 : 12;
  const pillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: size === 'sm' ? '1px 7px' : '2px 9px',
    borderRadius: 999,
    fontSize,
    fontWeight: 600,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    color: '#374151',
    backgroundColor: meta ? `${meta.color}1f` : 'transparent',
    border: meta ? `1px solid ${meta.color}66` : '1px dashed #d1d5db',
  };
  const dot = (color: string) => (
    <span style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: color, flexShrink: 0 }} />
  );

  const content = (
    <>
      {meta ? dot(meta.color) : null}
      <span>{meta ? meta.name : 'Add label'}</span>
      {onChange ? (saving ? <Loader2 size={fontSize} className="animate-spin" /> : <ChevronDown size={fontSize} />) : null}
    </>
  );

  if (!onChange) {
    return (
      <span style={pillStyle} title={tooltip(current, source, confidence)}>
        {content}
      </span>
    );
  }

  const choose = async (next: ReplyLabel) => {
    setOpen(false);
    if (next === current) return;
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={buttonRef}
        type="button"
        style={{ ...pillStyle, cursor: saving ? 'wait' : 'pointer' }}
        title={`${tooltip(current, source, confidence)} — click to change`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation();
          toggleMenu();
        }}
      >
        {content}
      </button>
      {open && menuPos && (
        <div
          role="listbox"
          style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            zIndex: 1000,
            width: 200,
            padding: 4,
            borderRadius: 8,
            backgroundColor: '#ffffff',
            border: '1px solid #e5e7eb',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          }}
        >
          {REPLY_LABELS.map((l) => {
            const m = REPLY_LABEL_META[l];
            const active = l === current;
            return (
              <button
                key={l}
                type="button"
                role="option"
                aria-selected={active}
                onClick={(e) => {
                  e.stopPropagation();
                  void choose(l);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 13,
                  textAlign: 'left',
                  color: '#111827',
                  fontWeight: active ? 600 : 400,
                  backgroundColor: active ? '#f3f4f6' : 'transparent',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f3f4f6')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = active ? '#f3f4f6' : 'transparent')}
              >
                {dot(m.color)}
                {m.name}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
