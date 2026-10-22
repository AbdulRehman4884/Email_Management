import React, { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { CrmContact, CrmStage } from '../../../lib/api';
import type { BoardColumn } from '../../../store/crmStore';
import { ScoreBadge } from '../ScoreBadge';
import { TagList } from '../TagChip';
import { REPLY_LABEL_META, isReplyLabel } from '../../../lib/replyLabels';
import { waitingShort } from './filters';

interface KanbanBoardProps {
  stages: CrmStage[];
  columns: Record<number, BoardColumn>;
  avgDays: Map<number, number | null>;
  onOpen: (contactId: number) => void;
  onMove: (contact: CrmContact, toStageId: number) => void;
  onLoadMore: (stageId: number) => void;
}

function LeadCard({
  contact,
  stages,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  contact: CrmContact;
  stages: CrmStage[];
  onOpen: () => void;
  onMove: (toStageId: number) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const label = isReplyLabel(contact.lastReplyLabel) ? REPLY_LABEL_META[contact.lastReplyLabel] : null;
  const waiting = contact.needsReply ? waitingShort(contact.needsReplySince) : null;
  return (
    <div
      className={`crm-lead${dragging ? ' crm-dragging' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-label={`Lead ${contact.name || contact.email}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span
          title={label ? `Latest reply: ${label.name}` : 'No reply yet'}
          style={{ width: 9, height: 9, borderRadius: 999, marginTop: 5, flexShrink: 0, background: label?.color ?? 'transparent', border: label ? 'none' : '1.5px solid var(--crm-border-strong)' }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="text-sm font-semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.name || contact.email}</p>
          {contact.name && <p className="text-xs crm-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.email}</p>}
          {contact.company && <p className="text-xs crm-faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.company}</p>}
        </div>
        <ScoreBadge score={contact.score} tier={contact.scoreTier} showName={false} />
      </div>
      {(contact.tags.length > 0 || waiting) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {waiting && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--crm-danger)', background: 'var(--crm-danger-bg)', borderRadius: 999, padding: '0 7px', lineHeight: '18px' }}>
              {waiting}
            </span>
          )}
          <TagList tags={contact.tags} max={2} />
        </div>
      )}
      {/* Touch screens cannot drag: a "Move" menu instead (hidden where a mouse can drag). */}
      <select
        className="crm-move crm-input"
        aria-label={`Move ${contact.email} to stage`}
        value=""
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => e.target.value && onMove(Number(e.target.value))}
        style={{ marginTop: 8, height: 28, fontSize: 12, width: '100%' }}
      >
        <option value="">Move to…</option>
        {stages.filter((s) => s.id !== contact.stageId).map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    </div>
  );
}

/** One column per stage. Drag a card to another column to move the lead; columns load more cards on scroll. */
export function KanbanBoard({ stages, columns, avgDays, onOpen, onMove, onLoadMore }: KanbanBoardProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overStage, setOverStage] = useState<number | null>(null);
  const dragged = useRef<CrmContact | null>(null);

  return (
    <div className="crm-board" aria-label="Pipeline board">
      {stages.map((stage) => {
        const col = columns[stage.id];
        const days = avgDays.get(stage.id);
        return (
          <section
            key={stage.id}
            className={`crm-column${overStage === stage.id && dragged.current?.stageId !== stage.id ? ' crm-drop-target' : ''}`}
            aria-label={`Stage ${stage.name}`}
            onDragOver={(e) => {
              if (!dragged.current) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overStage !== stage.id) setOverStage(stage.id);
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOverStage((s) => (s === stage.id ? null : s));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const c = dragged.current;
              dragged.current = null;
              setDragId(null);
              setOverStage(null);
              if (c && c.stageId !== stage.id) onMove(c, stage.id);
            }}
          >
            <div className="crm-column-head">
              <span style={{ width: 10, height: 10, borderRadius: 999, background: stage.color, flexShrink: 0 }} />
              <span className="text-sm font-semibold" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {stage.name}
                {stage.type !== 'normal' && <span className="text-xs crm-faint" style={{ fontWeight: 400 }}> · {stage.type === 'won' ? 'Won' : 'Lost'}</span>}
              </span>
              {days != null && <span className="text-xs crm-faint" title="Average days in this stage">{days}d</span>}
              <span className="text-xs font-semibold" style={{ background: 'var(--crm-surface)', border: '1px solid var(--crm-border)', borderRadius: 999, padding: '0 8px' }}>
                {col ? col.total : '…'}
              </span>
            </div>
            <div
              className="crm-column-body"
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) onLoadMore(stage.id);
              }}
            >
              {col?.contacts.map((c) => (
                <LeadCard
                  key={c.id}
                  contact={c}
                  stages={stages}
                  dragging={dragId === c.id}
                  onOpen={() => onOpen(c.id)}
                  onMove={(to) => onMove(c, to)}
                  onDragStart={(e) => {
                    dragged.current = c;
                    setDragId(c.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(c.id));
                  }}
                  onDragEnd={() => {
                    dragged.current = null;
                    setDragId(null);
                    setOverStage(null);
                  }}
                />
              ))}
              {col && !col.loading && col.contacts.length === 0 && <p className="text-xs crm-faint" style={{ textAlign: 'center', padding: '16px 0' }}>No leads</p>}
              {col?.error && <p className="text-xs" style={{ color: 'var(--crm-danger)' }}>{col.error}</p>}
              {(!col || col.loading) && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
                  <Loader2 size={16} className="animate-spin crm-faint" />
                </div>
              )}
              {col && !col.loading && col.contacts.length < col.total && (
                <button type="button" className="crm-btn" onClick={() => onLoadMore(stage.id)} style={{ justifyContent: 'center', height: 30, fontSize: 12 }}>
                  Load more ({col.total - col.contacts.length})
                </button>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
