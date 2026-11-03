import React, { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { CrmPipelineSummary, CrmStage, CrmTag } from '../../../lib/api';
import { REPLY_LABELS, REPLY_LABEL_META } from '../../../lib/replyLabels';
import { TagChip, TagPicker } from '../TagChip';
import { TIER_STYLE } from '../ScoreBadge';
import { hasFilters, type DashboardFilters } from './filters';

interface CrmFilterBarProps {
  filters: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>) => void;
  onClear: () => void;
  pipelines: CrmPipelineSummary[];
  /** Pipeline on screen (chosen or default) */
  pipelineId: number | undefined;
  stages: CrmStage[];
  campaigns: Array<{ id: number; name: string }>;
  tags: CrmTag[];
}

/** Dashboard filters: pipeline, campaign, stage, reply label, tags, score tier, needs reply, dates, search. */
export function CrmFilterBar({ filters, onChange, onClear, pipelines, pipelineId, stages, campaigns, tags }: CrmFilterBarProps) {
  const [search, setSearch] = useState(filters.search ?? '');
  useEffect(() => setSearch(filters.search ?? ''), [filters.search]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const v = search.trim() || undefined;
      if (v !== filters.search) onChange({ search: v });
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const selectedTags = filters.tagIds.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as CrmTag[];

  return (
    <div className="crm-card" style={{ padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: '1 1 200px', minWidth: 160 }}>
          <Search size={15} className="crm-faint" style={{ position: 'absolute', left: 10, top: 10 }} />
          <input className="crm-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, company" aria-label="Search leads" style={{ width: '100%', paddingLeft: 32 }} />
        </div>
        <select className="crm-input" aria-label="Pipeline" value={pipelineId ?? ''} onChange={(e) => onChange({ pipelineId: e.target.value ? Number(e.target.value) : undefined, stageId: undefined })} style={{ flex: '0 1 170px' }}>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>
          ))}
        </select>
        <select className="crm-input" aria-label="Campaign" value={filters.campaignId ?? ''} onChange={(e) => onChange({ campaignId: e.target.value ? Number(e.target.value) : undefined })} style={{ flex: '0 1 180px' }}>
          <option value="">All campaigns</option>
          {filters.campaignId && !campaigns.some((c) => c.id === filters.campaignId) && <option value={filters.campaignId}>Campaign #{filters.campaignId}</option>}
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select className="crm-input" aria-label="Stage" value={filters.stageId ?? ''} onChange={(e) => onChange({ stageId: e.target.value ? Number(e.target.value) : undefined })} style={{ flex: '0 1 160px' }}>
          <option value="">All stages</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 1 auto' }}>
          <input className="crm-input" type="date" aria-label="Added from" value={filters.from ?? ''} max={filters.to} onChange={(e) => {
              // E2E-04: "from" after "to" moves "to" along, so the range is never backwards.
              const from = e.target.value || undefined;
              onChange(from && filters.to && from > filters.to ? { from, to: from } : { from });
            }} style={{ width: 138 }} />
          <span className="crm-faint text-xs">–</span>
          <input className="crm-input" type="date" aria-label="Added to" value={filters.to ?? ''} min={filters.from} onChange={(e) => {
              const to = e.target.value || undefined;
              onChange(to && filters.from && to < filters.from ? { from: to, to } : { to });
            }} style={{ width: 138 }} />
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 10 }}>
        {REPLY_LABELS.map((l) => (
          <button
            key={l}
            type="button"
            className="crm-chip"
            aria-pressed={filters.labels.includes(l)}
            title={`Latest reply: ${REPLY_LABEL_META[l].name}`}
            onClick={() => onChange({ labels: toggle(filters.labels, l) })}
          >
            <span style={{ width: 9, height: 9, borderRadius: 999, background: REPLY_LABEL_META[l].color }} />
            <span className="crm-hide-sm">{REPLY_LABEL_META[l].name}</span>
          </button>
        ))}
        <button type="button" className="crm-chip" aria-pressed={filters.labels.includes('none')} onClick={() => onChange({ labels: toggle(filters.labels, 'none') })}>
          No reply
        </button>
        <span style={{ width: 1, height: 20, background: 'var(--crm-border)', margin: '0 4px' }} />
        {(['hot', 'warm', 'cold'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className="crm-chip"
            aria-pressed={filters.scoreTiers.includes(t)}
            onClick={() => onChange({ scoreTiers: toggle(filters.scoreTiers, t) })}
            style={{ color: TIER_STYLE[t]!.fg }}
          >
            {TIER_STYLE[t]!.icon} {TIER_STYLE[t]!.name}
          </button>
        ))}
        <button
          type="button"
          className="crm-chip"
          aria-pressed={filters.needsReply}
          onClick={() => onChange({ needsReply: !filters.needsReply })}
          style={filters.needsReply ? { color: 'var(--crm-danger)' } : undefined}
        >
          Needs reply
        </button>
        <span style={{ width: 1, height: 20, background: 'var(--crm-border)', margin: '0 4px' }} />
        {selectedTags.map((t) => (
          <TagChip key={t.id} tag={t} onRemove={() => onChange({ tagIds: filters.tagIds.filter((id) => id !== t.id) })} />
        ))}
        <TagPicker
          tags={tags}
          target="contact"
          selectedIds={filters.tagIds}
          onAdd={(t) => onChange({ tagIds: [...filters.tagIds, t.id] })}
          onRemove={(t) => onChange({ tagIds: filters.tagIds.filter((id) => id !== t.id) })}
          label="Tag"
        />
        {hasFilters(filters) && (
          <button type="button" className="crm-chip" onClick={onClear} style={{ marginLeft: 'auto', border: 'none' }}>
            <X size={12} /> Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
