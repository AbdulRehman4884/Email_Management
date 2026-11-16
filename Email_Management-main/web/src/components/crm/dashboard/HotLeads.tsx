import React from 'react';
import { Flame } from 'lucide-react';
import type { CrmContact } from '../../../lib/api';
import { ScoreBadge } from '../ScoreBadge';
import { LabelDot } from '../ContactCard';
import { timeAgoShort, waitingShort } from './filters';

/** Interested + hot leads, newest reply first (CRM step 8). */
export function HotLeads({ leads, onOpen }: { leads: CrmContact[]; onOpen: (id: number) => void }) {
  return (
    <div className="crm-card" style={{ padding: 16 }}>
      <h3 className="text-sm font-semibold" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Flame size={15} color="#ea580c" /> Hot leads
      </h3>
      {leads.length === 0 && <p className="text-sm crm-muted">No Interested or hot leads with these filters yet.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {leads.map((l) => {
          const waiting = l.needsReply ? waitingShort(l.needsReplySince) : null;
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => onOpen(l.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 6px', borderRadius: 8, color: 'inherit' }}
              className="crm-hot-row"
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="text-sm font-semibold" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name || l.email}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                  <LabelDot label={l.lastReplyLabel} />
                  {l.lastInboundAt && <span className="text-xs crm-faint">{timeAgoShort(l.lastInboundAt)}</span>}
                  {waiting && <span className="text-xs" style={{ color: 'var(--crm-danger)', fontWeight: 600 }}>{waiting}</span>}
                </span>
              </span>
              <ScoreBadge score={l.score} tier={l.scoreTier} showName={false} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
