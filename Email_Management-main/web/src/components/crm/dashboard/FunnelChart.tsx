import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { CrmSummary } from '../../../lib/api';

/**
 * Funnel: how many leads reached each stage (now or before), and the % that went on to the next stage.
 * Lost stages are not part of the funnel. Bars use the stage colors.
 */
export function FunnelChart({ summary, onPickStage }: { summary: CrmSummary | null; onPickStage: (stageId: number) => void }) {
  const steps = summary?.funnel ?? [];
  const max = Math.max(1, ...steps.map((s) => s.reached));
  const days = new Map((summary?.stages ?? []).map((s) => [s.id, s.avgDaysInStage]));

  return (
    <div className="crm-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <h3 className="text-sm font-semibold" style={{ flex: 1 }}>Funnel</h3>
        <span className="text-xs crm-faint">reached · % from the stage before · avg days in stage</span>
      </div>
      {steps.length === 0 && <p className="text-sm crm-muted">No stages yet.</p>}
      <div>
        {steps.map((s, i) => (
          <div key={s.stageId}>
            {i > 0 && (
              <div className="text-xs crm-faint" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0 2px 2px' }}>
                <ChevronDown size={12} />
                {s.conversionFromPrev == null ? '—' : `${s.conversionFromPrev}% moved on`}
              </div>
            )}
            <button
              type="button"
              onClick={() => onPickStage(s.stageId)}
              title={`Show leads in ${s.name}`}
              style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) 1fr auto', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', color: 'inherit' }}
            >
              <span className="text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              <span style={{ height: 18, background: 'var(--crm-column)', borderRadius: 6, overflow: 'hidden' }}>
                <span
                  style={{
                    display: 'block',
                    height: '100%',
                    width: `${Math.max(s.reached > 0 ? 2 : 0, (s.reached / max) * 100)}%`,
                    background: s.color,
                    opacity: 0.85,
                    borderRadius: 6,
                    transition: 'width .3s',
                  }}
                />
              </span>
              <span className="text-sm" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 74, textAlign: 'right' }}>
                <strong>{s.reached}</strong>
                {days.get(s.stageId) != null && <span className="text-xs crm-faint"> · {days.get(s.stageId)}d</span>}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
