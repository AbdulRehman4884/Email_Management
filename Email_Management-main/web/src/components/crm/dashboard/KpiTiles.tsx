import React from 'react';
import type { CrmSummary } from '../../../lib/api';

interface KpiTilesProps {
  kpis: CrmSummary['kpis'];
  loading: boolean;
  /** Clicking a tile filters the board (Interested, Meetings, Needs reply). */
  onPick: (what: 'interested' | 'meetings' | 'needsReply') => void;
}

/** Total leads · Interested · Meetings booked · Won · Win rate · Needs reply */
export function KpiTiles({ kpis, loading, onPick }: KpiTilesProps) {
  const v = (n: number | undefined | null) => (loading && !kpis ? '…' : n == null ? '—' : n.toLocaleString());
  const tiles: Array<{ key: string; label: string; value: string; color?: string; onClick?: () => void; title?: string }> = [
    { key: 'total', label: 'Total leads', value: v(kpis?.total) },
    { key: 'interested', label: '🟢 Interested', value: v(kpis?.interested), onClick: () => onPick('interested'), title: 'Show only Interested leads' },
    { key: 'meetings', label: '🟣 Meetings booked', value: v(kpis?.meetings), onClick: () => onPick('meetings'), title: 'Show only Meeting Booked leads' },
    { key: 'won', label: '🏆 Won', value: v(kpis?.won), color: '#16a34a' },
    {
      key: 'winrate',
      label: 'Win rate',
      value: loading && !kpis ? '…' : kpis?.winRate == null ? '—' : `${kpis.winRate}%`,
      title: kpis ? `Won ÷ (Won + Lost): ${kpis.won} won, ${kpis.lost} lost` : undefined,
    },
    {
      key: 'needs',
      label: 'Needs reply',
      value: v(kpis?.needsReply),
      color: kpis && kpis.needsReply > 0 ? 'var(--crm-danger)' : undefined,
      onClick: () => onPick('needsReply'),
      title: 'Show only leads waiting for your reply',
    },
  ];
  return (
    <div className="crm-kpis">
      {tiles.map((t) => {
        const body = (
          <>
            <div className="crm-kpi-value" style={t.color ? { color: t.color } : undefined}>{t.value}</div>
            <div className="crm-kpi-label">{t.label}</div>
          </>
        );
        return t.onClick ? (
          <button key={t.key} type="button" className="crm-card crm-kpi" onClick={t.onClick} title={t.title} style={{ textAlign: 'left', cursor: 'pointer', color: 'inherit' }}>
            {body}
          </button>
        ) : (
          <div key={t.key} className="crm-card crm-kpi" title={t.title}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
