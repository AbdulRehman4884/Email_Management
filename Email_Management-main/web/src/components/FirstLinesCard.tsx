import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, useToast } from './ui';
import { apiError, firstLinesApi, type FirstLineLead, type FirstLineRun } from '../lib/aiFeaturesApi';

const SOURCE_NAME: Record<string, string> = { website: 'From website', fallback: 'Basic', manual: 'Edited' };
const SHOW_FIRST = 25;

/**
 * Campaign page: "AI first lines". The AI reads each lead's website and writes one personal opening sentence,
 * saved as the lead's {first_line}. The rest of the email stays the same.
 */
export function FirstLinesCard(props: { campaignId: number; campaignStatus: string | undefined; onChanged?: () => void }) {
  const { campaignId, onChanged } = props;
  const toast = useToast();
  const [leads, setLeads] = useState<FirstLineLead[] | null>(null);
  const [usesPlaceholder, setUsesPlaceholder] = useState(true);
  const [run, setRun] = useState<FirstLineRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const wasRunning = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const load = useCallback(async () => {
    try {
      const d = await firstLinesApi.get(campaignId);
      setLeads(d.leads);
      setUsesPlaceholder(d.usesPlaceholder);
      setRun(d.run);
      setError(null);
      return d.run;
    } catch (e) {
      setError(apiError(e, 'Could not load the first lines'));
      return null;
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a run is going: progress every 2 seconds; at the end the campaign page refreshes its preview.
  useEffect(() => {
    if (run?.status !== 'running') {
      if (wasRunning.current) {
        wasRunning.current = false;
        onChangedRef.current?.();
      }
      return;
    }
    wasRunning.current = true;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [run?.status, load]);

  if (error && !leads) {
    return (
      <Card>
        <CardHeader><h2 className="text-base font-semibold text-gray-900">AI first lines</h2></CardHeader>
        <CardContent><p className="text-sm text-gray-500">{error}</p></CardContent>
      </Card>
    );
  }
  if (!leads) return null;

  const pending = leads.filter((l) => l.status === 'pending');
  const withLine = pending.filter((l) => l.firstLine.trim()).length;
  const running = run?.status === 'running';
  const finished = props.campaignStatus === 'completed' || pending.length === 0;

  const start = async (overwrite: boolean) => {
    if (overwrite && !window.confirm('Write the first line again for every lead not emailed yet? Lines you edited are replaced too.')) return;
    setStarting(true);
    try {
      setRun(await firstLinesApi.start(campaignId, overwrite));
    } catch (e) {
      toast.error(apiError(e, 'Could not start writing the first lines'));
    } finally {
      setStarting(false);
    }
  };

  const save = async (lead: FirstLineLead, text: string) => {
    if (text.trim() === lead.firstLine.trim()) return;
    try {
      const updated = await firstLinesApi.save(campaignId, lead.recipientId, text);
      setLeads((all) => (all ? all.map((l) => (l.recipientId === updated.recipientId ? updated : l)) : all));
      onChangedRef.current?.();
    } catch (e) {
      toast.error(apiError(e, 'Could not save the line'));
    }
  };

  const shown = showAll ? leads : leads.slice(0, SHOW_FIRST);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">AI first lines</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              The AI reads each lead&apos;s website and writes one personal opening line. The rest of your email stays the same.
            </p>
          </div>
          {!finished && (
            <div className="flex gap-2 flex-shrink-0">
              <Button size="sm" leftIcon={<Sparkles className="w-4 h-4" />} onClick={() => void start(false)} isLoading={starting} disabled={running || starting || withLine === pending.length}>
                Write first lines
              </Button>
              {withLine > 0 && (
                <Button size="sm" variant="outline" leftIcon={<RefreshCw className="w-4 h-4" />} onClick={() => void start(true)} disabled={running || starting}>
                  Write again
                </Button>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3" data-testid="first-lines-card">
        {!usesPlaceholder && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" data-testid="first-lines-placeholder-hint">
            Your email does not use the line yet. Edit the campaign and put <code>{'{first_line}'}</code> at the start, for example after
            “Hi {'{first_name}'},”.
          </p>
        )}

        {running && run && (
          <div data-testid="first-lines-progress">
            <p className="text-sm text-gray-700">Writing first lines… {run.done} of {run.total} leads</p>
            <div className="h-2 mt-1 rounded bg-gray-200 overflow-hidden">
              <div className="h-full bg-gray-900" style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }} />
            </div>
          </div>
        )}
        {!running && run && (run.status === 'done' || run.status === 'failed') && (
          <p className="text-sm text-gray-700" data-testid="first-lines-summary">
            {run.status === 'failed' && run.error ? `${run.error} ` : ''}
            Last run: {run.fromWebsite} from the website, {run.fallback} basic (no usable website), {run.empty} left empty
            {run.failed ? `, ${run.failed} could not be saved` : ''}.
          </p>
        )}

        <p className="text-sm text-gray-500">
          {pending.length ? `${withLine} of ${pending.length} leads waiting to be emailed have a first line.` : 'Every lead has been emailed.'} Click a line to edit it.
        </p>

        {leads.length > 0 && (
          <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {shown.map((lead) => (
              <li key={lead.recipientId} className="px-3 py-2 text-sm" data-testid="first-line-row">
                <div className="flex items-center justify-between gap-2 text-xs text-gray-500">
                  <span className="truncate">{lead.name ? `${lead.name} · ` : ''}{lead.email}</span>
                  {lead.source && SOURCE_NAME[lead.source] && lead.firstLine && <span className="flex-shrink-0">{SOURCE_NAME[lead.source]}</span>}
                </div>
                {lead.status === 'pending' && !running ? (
                  <input
                    key={`${lead.recipientId}:${lead.firstLine}`}
                    aria-label={`First line for ${lead.email}`}
                    defaultValue={lead.firstLine}
                    maxLength={220}
                    placeholder="No first line yet"
                    onBlur={(e) => void save(lead, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    className="w-full mt-1 px-2 py-1 border border-transparent hover:border-gray-300 focus:border-gray-400 rounded text-gray-900 placeholder-gray-400 focus:outline-none"
                  />
                ) : (
                  <p className="mt-1 text-gray-800">{lead.firstLine || <span className="text-gray-400">No first line</span>}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {leads.length > SHOW_FIRST && (
          <button type="button" className="text-sm text-gray-700 underline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${leads.length} leads`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
