/**
 * Lead Engine monitor for admins (use case UC-13 + UC-12): today's runs, the task queue, success and block
 * rate per source with on/off and daily caps, common errors, recent runs, privacy (opt-out / erasure) requests.
 */
import { useCallback, useEffect, useState } from 'react';
import { Activity, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, Modal, useToast } from '../components/ui';
import { leadGenAdminApi, leadGenErrorText, type LeadGenOverview, type PrivacyRequestRow } from '../lib/api';

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

export function AdminLeadGen() {
  const toast = useToast();
  const [data, setData] = useState<LeadGenOverview | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyRequestRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<PrivacyRequestRow | null>(null);
  const [identifier, setIdentifier] = useState('');

  const load = useCallback(async () => {
    try {
      const [o, p] = await Promise.all([leadGenAdminApi.overview(), leadGenAdminApi.privacy()]);
      setData(o);
      setPrivacy(p);
      setError(null);
    } catch (err) {
      setError(leadGenErrorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  const patchSource = async (id: number, body: Parameters<typeof leadGenAdminApi.updateSource>[1]) => {
    try {
      await leadGenAdminApi.updateSource(id, body);
      void load();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    }
  };

  const process = async (reject: boolean) => {
    if (!processing) return;
    try {
      await leadGenAdminApi.processPrivacy(processing.id, identifier, reject);
      toast.success(reject ? 'Request rejected.' : 'Data erased and blocked from collection.');
      setProcessing(null);
      setIdentifier('');
      void load();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    }
  };

  const queued = data?.queue.reduce((n, q) => n + (q.status === 'pending' ? q.n : 0), 0) ?? 0;
  const running = data?.queue.reduce((n, q) => n + (q.status === 'running' ? q.n : 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-gray-900">
          <Activity className="w-8 h-8" />
          <h1 className="text-2xl font-bold">Lead Engine monitor</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={() => void load()}>Reload</Button>
          <Button variant="secondary" onClick={() => void leadGenAdminApi.refreshNow().then((r) => toast.info(r.message)).catch((e) => toast.error(leadGenErrorText(e)))}>
            Start nightly refresh now
          </Button>
        </div>
      </div>
      {error && <Card><CardContent><p className="text-gray-600">{error}</p></CardContent></Card>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Stat label="Runs today" value={Object.values(data.runsToday).reduce((a, b) => a + b, 0)} />
            <Stat label="Failed / partial today" value={`${data.runsToday.failed ?? 0} / ${data.runsToday.partial ?? 0}`} />
            <Stat label="Tasks waiting / running" value={`${queued} / ${running}`} />
            <Stat label="Companies" value={data.masterData.companies} />
            <Stat label="People" value={data.masterData.people} />
            <Stat label="Merges" value={data.masterData.merges} />
          </div>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-3">Sources</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-3">Source</th><th className="py-2 pr-3">On</th><th className="py-2 pr-3">Requests today</th>
                      <th className="py-2 pr-3">Blocked (rate)</th><th className="py-2 pr-3">Task success (24h)</th><th className="py-2 pr-3">Daily cap</th><th className="py-2">Cooldown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((s) => (
                      <tr key={s.id} className="border-b border-gray-100">
                        <td className="py-2 pr-3"><div className="font-medium">{s.code}</div><div className="text-xs text-gray-400 max-w-xs">{s.notes}</div></td>
                        <td className="py-2 pr-3"><input type="checkbox" checked={s.is_enabled} onChange={(e) => void patchSource(s.id, { isEnabled: e.target.checked })} /></td>
                        <td className="py-2 pr-3">{s.requests_today}</td>
                        <td className={`py-2 pr-3 ${s.blocked_today ? 'text-red-600' : ''}`}>{s.blocked_today} ({s.blockRate}%)</td>
                        <td className="py-2 pr-3">{s.successRate == null ? '—' : `${s.successRate}%`}</td>
                        <td className="py-2 pr-3">
                          <input type="number" defaultValue={s.daily_cap ?? ''} placeholder="none" className="w-24 rounded border border-gray-300 px-2 py-1"
                            onBlur={(e) => {
                              const v = e.target.value ? Number(e.target.value) : null;
                              if (v !== s.daily_cap) void patchSource(s.id, { dailyCap: v });
                            }} />
                        </td>
                        <td className="py-2">
                          {s.cooldown_until && new Date(s.cooldown_until) > new Date()
                            ? <button className="text-amber-600 underline" onClick={() => void patchSource(s.id, { clearCooldown: true })}>until {new Date(s.cooldown_until).toLocaleTimeString()} (clear)</button>
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardContent>
                <h2 className="text-base font-semibold text-gray-900 mb-3">Queue</h2>
                {data.queue.length === 0 ? <p className="text-sm text-gray-500">Empty.</p> : (
                  <ul className="text-sm space-y-1">{data.queue.map((q) => <li key={`${q.task_type}-${q.status}`}>{q.task_type} · {q.status}: <b>{q.n}</b></li>)}</ul>
                )}
                <h2 className="text-base font-semibold text-gray-900 mt-5 mb-3">Common errors (24h)</h2>
                {data.commonErrors.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
                  <ul className="text-sm space-y-1">{data.commonErrors.map((e) => <li key={e.error}><b>{e.n}×</b> {e.error}</li>)}</ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent>
                <h2 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2"><ShieldCheck className="w-5 h-5" />Privacy requests</h2>
                {privacy.length === 0 ? <p className="text-sm text-gray-500">None.</p> : (
                  <ul className="text-sm space-y-2">
                    {privacy.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2">
                        <span>
                          #{p.id} {p.request_type} · {p.identifier_type.replace('_', ' ')} · <b>{p.status}</b> · {new Date(p.received_at).toLocaleDateString()}
                          {p.due_soon && <span className="text-red-600"> · answer due soon (30 days)</span>}
                        </span>
                        {p.status !== 'done' && p.status !== 'rejected' && <Button size="sm" variant="secondary" onClick={() => setProcessing(p)}>Process</Button>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent>
              <h2 className="text-base font-semibold text-gray-900 mb-3">Recent runs</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-gray-500 border-b border-gray-200"><th className="py-2 pr-3">#</th><th className="py-2 pr-3">User</th><th className="py-2 pr-3">Search</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Found / new</th><th className="py-2">Error</th></tr></thead>
                  <tbody>
                    {data.recentRuns.map((r) => (
                      <tr key={r.id} className="border-b border-gray-100">
                        <td className="py-1 pr-3">{r.id}</td><td className="py-1 pr-3">{r.user_email ?? 'system'}</td><td className="py-1 pr-3">{r.search_name ?? '—'}</td>
                        <td className="py-1 pr-3">{r.run_type}</td><td className="py-1 pr-3">{r.status}</td>
                        <td className="py-1 pr-3">{r.stats.discovered ?? 0} / {r.stats.new_leads ?? 0}</td><td className="py-1 text-xs text-gray-500">{r.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Modal isOpen={processing != null} onClose={() => setProcessing(null)} title={`Privacy request #${processing?.id ?? ''}`}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">
            Only a hash is stored. Type the {processing?.identifier_type.replace('_', ' ')} from the request after checking the person's identity.
            Everything we hold about it is deleted and it is never collected again.
          </p>
          <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2" placeholder="email, LinkedIn URL or domain" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void process(true)}>Reject request</Button>
            <Button variant="danger" disabled={!identifier.trim()} onClick={() => void process(false)}>Erase and block</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
