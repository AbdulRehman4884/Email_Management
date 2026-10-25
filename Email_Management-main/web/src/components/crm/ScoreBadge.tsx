import React from 'react';
import type { CrmScoreEvent, CrmScoreItem } from '../../lib/api';

export const TIER_STYLE: Record<string, { name: string; fg: string; bg: string; bd: string; icon: string }> = {
  hot: { name: 'Hot', fg: '#c2410c', bg: '#fff7ed', bd: '#fdba74', icon: '🔥' },
  warm: { name: 'Warm', fg: '#a16207', bg: '#fefce8', bd: '#fde047', icon: '' },
  cold: { name: 'Cold', fg: '#475569', bg: '#f1f5f9', bd: '#cbd5e1', icon: '' },
};

/** Lead score: the number and a Hot / Warm / Cold color (CRM step 7). */
export function ScoreBadge({ score, tier, size = 'sm', showName = true }: { score: number; tier: string; size?: 'sm' | 'lg'; showName?: boolean }) {
  const t = TIER_STYLE[tier] ?? TIER_STYLE.cold!;
  const lg = size === 'lg';
  return (
    <span
      title={`Lead score ${score} / 100 · ${t.name}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: lg ? 6 : 4,
        padding: lg ? '3px 10px' : '0 7px',
        borderRadius: 999,
        background: t.bg,
        border: `1px solid ${t.bd}`,
        color: t.fg,
        fontSize: lg ? 14 : 11,
        lineHeight: lg ? '22px' : '18px',
        fontWeight: 700,
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {t.icon && <span aria-hidden>{t.icon}</span>}
      {score}
      {showName && <span style={{ fontWeight: 500 }}>{t.name}</span>}
    </span>
  );
}

const pts = (n: number) => `${n > 0 ? '+' : ''}${n}`;

/** "Why this score": the parts of the score, and the latest changes. */
export function ScoreBreakdown({ breakdown, events, score }: { breakdown: CrmScoreItem[]; events: CrmScoreEvent[]; score: number }) {
  const [showHistory, setShowHistory] = React.useState(false);
  const raw = breakdown.reduce((s, b) => s + b.points, 0);
  return (
    <div>
      {breakdown.length === 0 ? (
        <p className="text-xs text-gray-400">No points yet. Opens, replies and their labels add points.</p>
      ) : (
        <div className="rounded-lg border" style={{ overflow: 'hidden' }}>
          {breakdown.map((b) => (
            <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--crm-border, #f3f4f6)', fontSize: 13 }}>
              <span className="text-gray-700" style={{ flex: 1, minWidth: 0 }}>{b.label}</span>
              <span style={{ fontWeight: 600, color: b.points >= 0 ? '#15803d' : '#b91c1c', fontVariantNumeric: 'tabular-nums' }}>{pts(b.points)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--crm-surface-2, #f9fafb)', fontSize: 13 }}>
            <span className="text-gray-900 font-semibold" style={{ flex: 1 }}>Score</span>
            <span className="font-semibold text-gray-900">
              {score}
              {raw !== score && <span className="text-xs text-gray-400" style={{ fontWeight: 400 }}> (total {raw}, kept between 0 and 100)</span>}
            </span>
          </div>
        </div>
      )}
      {events.length > 0 && (
        <>
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs text-gray-600" style={{ marginTop: 6, textDecoration: 'underline' }}>
            {showHistory ? 'Hide' : 'Show'} score history ({events.length})
          </button>
          {showHistory && (
            <ol className="space-y-1" style={{ marginTop: 6 }}>
              {events.map((e) => (
                <li key={e.id} className="text-xs text-gray-600" style={{ display: 'flex', gap: 8 }}>
                  <span style={{ width: 34, textAlign: 'right', fontWeight: 600, color: e.points >= 0 ? '#15803d' : '#b91c1c', flexShrink: 0 }}>{pts(e.points)}</span>
                  <span style={{ flex: 1 }}>{e.reason}</span>
                  <span className="text-gray-400" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleDateString()}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
