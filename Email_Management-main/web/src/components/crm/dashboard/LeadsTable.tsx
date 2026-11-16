import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import type { CrmContact, CrmStage, CrmTag } from '../../../lib/api';
import { ScoreBadge } from '../ScoreBadge';
import { TagList, TagPicker } from '../TagChip';
import { LabelDot } from '../ContactCard';
import { timeAgoShort, waitingShort } from './filters';

interface LeadsTableProps {
  rows: CrmContact[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  stages: CrmStage[];
  tags: CrmTag[];
  onPage: (page: number) => void;
  onOpen: (contactId: number) => void;
  onBulkMove: (ids: number[], stageId: number) => Promise<void>;
  onBulkTag: (ids: number[], tag: CrmTag) => Promise<void>;
  onCreateTag: (name: string) => Promise<CrmTag>;
}

/** Table view: same filters as the board, bulk select (move stage, add tag), pages of 50. */
export function LeadsTable({ rows, total, page, pageSize, loading, stages, tags, onPage, onOpen, onBulkMove, onBulkTag, onCreateTag }: LeadsTableProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => setSelected(new Set()), [page, rows]);

  const ids = [...selected];
  const allOn = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="crm-card" style={{ overflow: 'hidden' }}>
      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', borderBottom: '1px solid var(--crm-border)', background: 'var(--crm-surface-2)' }}>
          <span className="text-sm font-semibold">{selected.size} selected</span>
          <select
            className="crm-input"
            aria-label="Move selected leads to stage"
            value=""
            disabled={busy}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id) void run(() => onBulkMove(ids, id));
            }}
            style={{ height: 30, fontSize: 12, width: 180 }}
          >
            <option value="">Move to stage…</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <TagPicker tags={tags} target="contact" selectedIds={[]} disabled={busy} label="Add tag" onAdd={(t) => run(() => onBulkTag(ids, t))} onCreate={onCreateTag} />
          <button type="button" className="text-xs crm-muted" onClick={() => setSelected(new Set())} style={{ textDecoration: 'underline' }}>
            Clear
          </button>
          {busy && <Loader2 size={14} className="animate-spin crm-faint" />}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="crm-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" aria-label="Select all on this page" checked={allOn} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
              </th>
              <th>Lead</th>
              <th className="crm-hide-sm">Company</th>
              <th>Stage</th>
              <th>Reply</th>
              <th>Score</th>
              <th className="crm-hide-sm">Tags</th>
              <th className="crm-hide-sm">Last reply</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const waiting = c.needsReply ? waitingShort(c.needsReplySince) : null;
              return (
                <tr key={c.id} onClick={() => onOpen(c.id)} style={{ cursor: 'pointer' }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.email}`}
                      checked={selected.has(c.id)}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.id)) next.delete(c.id);
                          else next.add(c.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td style={{ maxWidth: 260 }}>
                    <div className="font-semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || c.email}</div>
                    {c.name && <div className="text-xs crm-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.email}</div>}
                    {waiting && <div className="text-xs" style={{ color: 'var(--crm-danger)', fontWeight: 600 }}>{waiting}</div>}
                  </td>
                  <td className="crm-hide-sm crm-muted">{c.company ?? ''}</td>
                  <td>
                    {c.stageName && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                        <span style={{ width: 8, height: 8, borderRadius: 999, background: c.stageColor ?? '#9ca3af' }} />
                        {c.stageName}
                      </span>
                    )}
                  </td>
                  <td><LabelDot label={c.lastReplyLabel} /></td>
                  <td><ScoreBadge score={c.score} tier={c.scoreTier} /></td>
                  <td className="crm-hide-sm"><TagList tags={c.tags} max={2} /></td>
                  <td className="crm-hide-sm crm-faint" style={{ whiteSpace: 'nowrap' }}>{timeAgoShort(c.lastInboundAt) ?? '—'}</td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="crm-muted" style={{ textAlign: 'center', padding: 28 }}>No leads match these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--crm-border)' }}>
        <span className="text-xs crm-muted" style={{ flex: 1 }}>
          {loading ? 'Loading…' : total === 0 ? '0 leads' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
        </span>
        <button type="button" className="crm-btn" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)} style={{ height: 30, padding: '0 8px' }}>
          <ChevronLeft size={14} />
        </button>
        <span className="text-xs crm-muted">{page} / {pages}</span>
        <button type="button" className="crm-btn" aria-label="Next page" disabled={page >= pages || loading} onClick={() => onPage(page + 1)} style={{ height: 30, padding: '0 8px' }}>
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
