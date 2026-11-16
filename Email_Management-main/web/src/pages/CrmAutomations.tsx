import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gauge, Pencil, Phone, Plus, Trash2, Workflow } from 'lucide-react';
import { Button, Card, CardContent, EmptyState, Modal, useToast } from '../components/ui';
import { UpgradePrompt } from '../components/UpgradePrompt';
import {
  crmAutomationsApi,
  userApi,
  apiErrorMessage,
  type AutomationKind,
  type CrmAutomation,
  type CrmAutomationCall,
  type CrmAutomationTemplate,
} from '../lib/api';
import { useCrmEnabled } from '../lib/crmAccess';
import { iconButtonStyle } from '../components/crm/builderStyles';
import { CallResultButtons, fmtDate } from '../components/crm/automationUi';

const cell = { padding: '10px 8px' };

/** "New automation": pick a ready-made template or start blank. */
function TemplatePicker({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<CrmAutomationTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    crmAutomationsApi
      .templates()
      .then(setTemplates)
      .catch((e) => toast.error(apiErrorMessage(e, 'Could not load the templates')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (templateKey: string | null, kind: AutomationKind = 'form') => {
    setBusy(templateKey ?? `blank_${kind}`);
    try {
      const a = await crmAutomationsApi.create(
        templateKey ? { templateKey } : { name: kind === 'campaign' ? 'New campaign follow-ups' : 'New automation', kind }
      );
      navigate(`/crm/automations/${a.id}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not create the automation'));
      setBusy(null);
    }
  };

  const box = { border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column' as const, gap: 8 };
  return (
    <Modal isOpen onClose={onClose} title="New automation" size="xl">
      <p className="text-sm text-gray-500 mb-3">Start from a template and change anything you like, or start blank.</p>
      {(['form', 'campaign'] as AutomationKind[]).map((kind) => (
        <div key={kind} className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">{kind === 'form' ? 'For forms' : 'For campaigns (follow-ups)'}</h3>
          <p className="text-xs text-gray-500 mb-2">
            {kind === 'form'
              ? 'Runs for every lead from a form: emails, waits, reminders and a call.'
              : 'Runs after a campaign\u2019s first email: follow-ups in the same thread until the lead replies.'}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(templates ?? []).filter((t) => (t.kind ?? 'form') === kind).map((t) => (
              <div key={t.key} style={box}>
                <h3 className="text-sm font-semibold text-gray-900">{t.name}</h3>
                <p className="text-xs text-gray-500">{t.description}</p>
                <ol className="text-xs text-gray-700" style={{ paddingLeft: 18, listStyle: 'decimal', margin: 0, flex: 1 }}>
                  {t.outline.map((line, i) => <li key={i}>{line}</li>)}
                </ol>
                <div>
                  <Button size="sm" isLoading={busy === t.key} disabled={busy != null} onClick={() => void create(t.key)}>Use this template</Button>
                </div>
              </div>
            ))}
            <div style={box}>
              <h3 className="text-sm font-semibold text-gray-900">Blank</h3>
              <p className="text-xs text-gray-500" style={{ flex: 1 }}>
                {kind === 'form' ? 'Build your own form automation step by step.' : 'Build your own follow-ups: waits and emails.'}
              </p>
              <div>
                <Button size="sm" variant="secondary" isLoading={busy === `blank_${kind}`} disabled={busy != null} onClick={() => void create(null, kind)}>
                  Start blank
                </Button>
              </div>
            </div>
          </div>
        </div>
      ))}
      {!templates && <p className="text-sm text-gray-400 mt-3">Loading…</p>}
    </Modal>
  );
}

/** Leads waiting for the user's call result, across all automations. */
function CallsToMake({ calls, onDone }: { calls: CrmAutomationCall[]; onDone: () => void }) {
  if (calls.length === 0) return null;
  return (
    <Card>
      <CardContent className="py-4">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <Phone className="w-4 h-4 text-gray-400" aria-hidden />
          Calls to make ({calls.length})
        </h2>
        <p className="text-xs text-gray-500 mt-1">Call the lead, then pick the result. The automation goes on with the steps for that result.</p>
        <div style={{ overflowX: 'auto' }}>
          <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr className="text-xs text-gray-500" style={{ textAlign: 'left' }}>
                <th style={cell}>Lead</th>
                <th style={cell}>Phone</th>
                <th style={cell}>Automation</th>
                <th style={cell}>Since</th>
                <th style={cell}>Result</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.runId} style={{ borderTop: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                  <td style={cell}>
                    <Link to={`/crm?lead=${c.contactId}`} className="font-medium text-gray-900">{c.name?.trim() || c.email}</Link>
                    {c.name?.trim() && <div className="text-xs text-gray-500">{c.email}</div>}
                    {c.message && <div className="text-xs text-gray-500 mt-1">{c.message}</div>}
                  </td>
                  <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                    {c.phone ? <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`} className="text-indigo-600">{c.phone}</a> : <span className="text-gray-400">—</span>}
                  </td>
                  <td style={cell}>
                    <Link to={`/crm/automations/${c.automationId}`} className="text-gray-700">{c.automationName}</Link>
                    {c.attempt > 1 && <div className="text-xs text-gray-500">Try {c.attempt}</div>}
                  </td>
                  <td style={{ ...cell, whiteSpace: 'nowrap' }} className="text-gray-500">{fmtDate(c.since)}</td>
                  <td style={cell}><CallResultButtons runId={c.runId} onDone={onDone} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

type Quota = Awaited<ReturnType<typeof userApi.getSmtpQuota>>['profiles'];

/** Emails each account sent today (campaigns, follow-ups and automations together; at most 20 per account per day). */
function TodaysSending({ profiles }: { profiles: Quota }) {
  if (profiles.length === 0) return null;
  return (
    <Card>
      <CardContent className="py-4">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <Gauge className="w-4 h-4 text-gray-400" aria-hidden />
          Today's sending
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          Every email counts: campaign emails, follow-ups and automations. When an account reaches its limit, the rest goes out tomorrow.
        </p>
        <div className="flex flex-wrap gap-3 mt-3">
          {profiles.map((p) => {
            const full = p.blocked || (p.remaining != null && p.remaining <= 0);
            const pct = p.dailyLimit > 0 ? Math.min(100, Math.round((p.sentToday / p.dailyLimit) * 100)) : 100;
            return (
              <div key={p.smtpSettingsId} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', minWidth: 200 }}>
                <div className="text-xs text-gray-500">{p.fromEmail}</div>
                <div className="text-sm font-semibold" style={{ color: full ? '#b45309' : '#111827' }}>
                  {p.blocked ? 'Sending off' : `${p.sentToday} / ${p.dailyLimit} sent`}
                </div>
                <div style={{ height: 4, background: '#f3f4f6', borderRadius: 999, marginTop: 4 }}>
                  <div style={{ width: `${pct}%`, height: 4, borderRadius: 999, background: full ? '#d97706' : '#16a34a' }} />
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Automations page: every automation with its forms and lead counts, and the calls to make. */
export function CrmAutomations() {
  const crmEnabled = useCrmEnabled();
  const toast = useToast();
  const [automations, setAutomations] = useState<CrmAutomation[] | null>(null);
  const [calls, setCalls] = useState<CrmAutomationCall[]>([]);
  const [quota, setQuota] = useState<Quota>([]);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(() => {
    crmAutomationsApi
      .list()
      .then((list) => {
        setAutomations(list);
        setError(null);
      })
      .catch((e) => setError(apiErrorMessage(e, 'Could not load the automations')));
    crmAutomationsApi.calls().then(setCalls).catch(() => setCalls([]));
    userApi.getSmtpQuota().then((r) => setQuota(r.profiles)).catch(() => setQuota([]));
  }, []);

  useEffect(() => {
    if (crmEnabled) load();
  }, [crmEnabled, load]);

  if (!crmEnabled) return <UpgradePrompt feature="Automations" />;

  const toggle = async (a: CrmAutomation) => {
    try {
      const n = await crmAutomationsApi.update(a.id, { isActive: !a.isActive });
      setAutomations((list) => (list ?? []).map((x) => (x.id === n.id ? n : x)));
      toast.success(n.isActive ? `"${n.name}" is on` : `"${n.name}" is off. Its leads wait until you turn it on again.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not change the automation'));
    }
  };

  const remove = async (a: CrmAutomation) => {
    const users = [...a.usedBy.map((f) => `form "${f.name}"`), ...(a.usedByCampaigns ?? []).map((c) => `campaign "${c.name}"`)];
    const forms = users.length ? ` It is used by ${users.join(', ')}. They keep working, without an automation (campaign follow-ups stop).` : '';
    if (!window.confirm(`Delete "${a.name}"?${forms} Its lead history is deleted too. Leads stay in the CRM.`)) return;
    try {
      await crmAutomationsApi.remove(a.id);
      setAutomations((list) => (list ?? []).filter((x) => x.id !== a.id));
      crmAutomationsApi.calls().then(setCalls).catch(() => undefined);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not delete the automation'));
    }
  };

  const num = (n: number) => (n > 0 ? n.toLocaleString() : <span className="text-gray-400">0</span>);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Automations</h1>
          <p className="text-gray-500 mt-1 text-sm">Emails, waits, reminders and calls that run by themselves for leads from your forms, and follow-ups for your campaigns.</p>
        </div>
        <Button onClick={() => setPicking(true)} leftIcon={<Plus className="w-4 h-4" />}>New automation</Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <CallsToMake calls={calls} onDone={load} />

      <TodaysSending profiles={quota} />

      {automations && automations.length === 0 ? (
        <EmptyState
          icon={<Workflow className="w-8 h-8 text-gray-400" />}
          title="No automations yet"
          description="Create one from a template, then pick it in a form (Forms, open a form, Automation) or in a campaign that has not started yet."
        />
      ) : (
        <Card>
          <CardContent className="py-2">
            <div style={{ overflowX: 'auto' }}>
              <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="text-xs text-gray-500" style={{ textAlign: 'left' }}>
                    <th style={cell}>Automation</th>
                    <th style={cell}>For</th>
                    <th style={cell}>On</th>
                    <th style={cell}>Used by</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Running</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Calls</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Completed</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Stopped</th>
                    <th style={cell} />
                  </tr>
                </thead>
                <tbody>
                  {(automations ?? []).map((a) => (
                    <tr key={a.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={cell}>
                        <Link to={`/crm/automations/${a.id}`} className="font-medium text-gray-900">{a.name}</Link>
                        <div className="text-xs text-gray-500">{a.steps.length} step{a.steps.length === 1 ? '' : 's'}</div>
                      </td>
                      <td style={cell} className="text-xs text-gray-500">{a.kind === 'campaign' ? 'Campaigns' : 'Forms'}</td>
                      <td style={cell}>
                        <input type="checkbox" aria-label={`${a.name} on`} checked={a.isActive} onChange={() => void toggle(a)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                      </td>
                      <td style={cell} className="text-gray-700">
                        {a.kind === 'campaign'
                          ? (a.usedByCampaigns ?? []).length
                            ? (a.usedByCampaigns ?? []).map((c) => c.name).join(', ')
                            : <span className="text-xs text-gray-400">No campaign yet</span>
                          : a.usedBy.length
                            ? a.usedBy.map((f) => f.name).join(', ')
                            : <span className="text-xs text-gray-400">No form yet</span>}
                      </td>
                      <td style={{ ...cell, textAlign: 'right' }}>{num(a.counts.running)}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{num(a.counts.waitingCall)}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{num(a.counts.completed)}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{num(a.counts.stopped)}</td>
                      <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <Link to={`/crm/automations/${a.id}`} title="Edit" aria-label="Edit" style={iconButtonStyle}><Pencil size={15} /></Link>{' '}
                        <button type="button" title="Delete" aria-label="Delete" onClick={() => void remove(a)} style={iconButtonStyle}><Trash2 size={15} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!automations && !error && <p className="text-sm text-gray-400" style={{ padding: 12 }}>Loading…</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {picking && <TemplatePicker onClose={() => setPicking(false)} />}
    </div>
  );
}
