import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Search, Trophy } from 'lucide-react';
import { Modal, Button } from '../ui';
import { crmApi, apiErrorMessage, type CrmContactLookup, type CrmRuleTestResult } from '../../lib/api';
import { TRIGGERS, triggerLabel } from '../../lib/crmRules';
import { REPLY_LABELS, REPLY_LABEL_META } from '../../lib/replyLabels';
import { controlStyle, labelStyle } from './builderStyles';

interface RuleTestModalProps {
  isOpen: boolean;
  pipelineId: number;
  onClose: () => void;
}

const yesNo = (ok: boolean, yes: string, no: string) => (
  <span className="inline-flex items-center gap-1" style={{ color: ok ? '#15803d' : '#9ca3af' }}>
    {ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {ok ? yes : no}
  </span>
);

/** "Test rules": pick a lead and see which rules would match it right now. Nothing is changed. */
export function RuleTestModal({ isOpen, pipelineId, onClose }: RuleTestModalProps) {
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<CrmContactLookup[]>([]);
  const [contactId, setContactId] = useState<number | null>(null);
  const [trigger, setTrigger] = useState('');
  const [label, setLabel] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<Awaited<ReturnType<typeof crmApi.testRules>> | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const t = window.setTimeout(() => {
      crmApi.lookupContacts(pipelineId, search).then(setContacts).catch(() => setContacts([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [isOpen, pipelineId, search]);

  useEffect(() => {
    if (!isOpen) {
      setOut(null);
      setError(null);
    }
  }, [isOpen]);

  const run = async () => {
    if (!contactId) return;
    setRunning(true);
    setError(null);
    try {
      setOut(await crmApi.testRules(pipelineId, { contactId, trigger: trigger || undefined, label: label || undefined }));
    } catch (e) {
      setError(apiErrorMessage(e, 'Test failed'));
      setOut(null);
    } finally {
      setRunning(false);
    }
  };

  const results: CrmRuleTestResult[] = out?.results ?? [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Test rules on a lead" size="xl">
      <div className="space-y-4" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        <p className="text-sm text-gray-500">Shows which rules would match this lead right now. Nothing is changed.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label style={labelStyle}>Lead</label>
            <div className="relative">
              <Search size={14} style={{ position: 'absolute', left: 9, top: 10, color: '#9ca3af' }} />
              <input
                style={{ ...controlStyle, width: '100%', paddingLeft: 28 }}
                placeholder="Search email or name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              style={{ ...controlStyle, width: '100%', marginTop: 6 }}
              value={contactId ?? ''}
              onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{contacts.length ? 'Pick a lead…' : 'No leads found'}</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ? `${c.name} · ` : ''}{c.email}{c.stageName ? ` (${c.stageName})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Trigger</label>
            <select style={{ ...controlStyle, width: '100%' }} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="">All triggers</option>
              {TRIGGERS.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Pretend the reply label is</label>
            <select style={{ ...controlStyle, width: '100%' }} value={label} onChange={(e) => setLabel(e.target.value)}>
              <option value="">(the lead's real last label)</option>
              {REPLY_LABELS.map((l) => (
                <option key={l} value={l}>{REPLY_LABEL_META[l].name}</option>
              ))}
            </select>
          </div>
        </div>
        <Button onClick={() => void run()} isLoading={running} disabled={!contactId}>Run test</Button>

        {error && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-600">{error}</div>}

        {out && (
          <div className="space-y-2">
            <p className="text-sm text-gray-700">
              <b>{out.contact.name || out.contact.email}</b> is in <b>{out.contact.stageName ?? 'no stage'}</b>.
            </p>
            {results.length === 0 && <p className="text-sm text-gray-500">No rules for this trigger.</p>}
            <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {results.map((r) => (
                <div key={r.ruleId} className="p-3 text-sm" style={{ background: r.wins ? '#f0fdf4' : undefined, opacity: r.isActive ? 1 : 0.55 }}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {r.wins && <Trophy size={14} style={{ color: '#15803d' }} />}
                    <span className="font-medium text-gray-900">{r.name}</span>
                    <span className="text-xs text-gray-500">{triggerLabel(r.trigger)}</span>
                    {!r.isActive && <span className="text-xs text-gray-500">(off)</span>}
                  </div>
                  <div className="flex flex-wrap gap-4 mt-1 text-xs">
                    {yesNo(r.appliesToStage, 'stage fits', 'other stage only')}
                    {yesNo(r.conditionsMatch, 'conditions match', 'conditions do not match')}
                    {r.move && (r.move.allowed
                      ? <span className="text-gray-700">→ would move to <b>{r.move.toStageName}</b>{r.wins ? ' (wins)' : ''}</span>
                      : <span className="text-gray-500">→ {r.move.toStageName}: {r.move.reason}</span>)}
                    {r.otherActions.length > 0 && <span className="text-gray-500">also: {r.otherActions.join(', ').replace(/_/g, ' ')}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
