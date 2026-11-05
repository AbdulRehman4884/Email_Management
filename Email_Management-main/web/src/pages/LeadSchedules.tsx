/**
 * Lead searches and their schedules (use case UC-02 + UC-11): list, set or change the time and days,
 * pause / resume, run now (counts towards the quota), delete (found leads are kept).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CalendarClock, Pause, Play, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, ConfirmDialog, EmptyState, Modal, useToast } from '../components/ui';
import { browserTimezone, leadGenApi, leadGenErrorText, type LeadSearch, type Weekday } from '../lib/api';

const DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

function nextRunText(iso: string | null, timezone: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

function ScheduleModal({ search, onClose, onSaved }: { search: LeadSearch | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<Weekday[]>(DAYS);
  const [timezone, setTimezone] = useState(browserTimezone() ?? 'Asia/Karachi');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!search) return;
    setTime(search.schedule?.runAtLocal ?? '09:00');
    setDays(search.schedule?.frequency === 'weekly' ? search.schedule.weekdays : DAYS);
    setTimezone(search.schedule?.timezone ?? browserTimezone() ?? 'Asia/Karachi');
  }, [search]);

  const save = async () => {
    if (!search || days.length === 0) return;
    setBusy(true);
    try {
      const weekly = days.length < 7;
      await leadGenApi.schedule(search.id, { runAtLocal: time, timezone, frequency: weekly ? 'weekly' : 'daily', weekdays: weekly ? days : undefined });
      toast.success(`${search.name} is scheduled. Each run uses your daily lead quota.`);
      onSaved();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={search != null} onClose={onClose} title={search ? `Schedule: ${search.name}` : ''}>
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="block text-gray-600 mb-1">Time</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <div>
          <span className="block text-gray-600 mb-1">Days</span>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => (
              <label key={d} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={days.includes(d)} onChange={(e) => setDays(e.target.checked ? DAYS.filter((x) => x === d || days.includes(x)) : days.filter((x) => x !== d))} />
                {DAY_LABEL[d]}
              </label>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="block text-gray-600 mb-1">Timezone</span>
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <p className="text-gray-500">Runs start within 10 minutes of the time, so not every account hits the sources at the same second.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button isLoading={busy} disabled={days.length === 0} onClick={() => void save()}>Save schedule</Button>
        </div>
      </div>
    </Modal>
  );
}

export function LeadSchedules() {
  const toast = useToast();
  const [searches, setSearches] = useState<LeadSearch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LeadSearch | null>(null);
  const [deleting, setDeleting] = useState<LeadSearch | null>(null);

  const load = useCallback(async () => {
    try {
      setSearches(await leadGenApi.searches());
      setError(null);
    } catch (err) {
      setError(leadGenErrorText(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      void load();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/lead-finder" className="text-sm text-gray-500 inline-flex items-center gap-1"><ArrowLeft className="w-4 h-4" />Lead Finder</Link>
        <div className="flex items-center gap-2 text-gray-900 mt-2">
          <CalendarClock className="w-8 h-8" />
          <h1 className="text-2xl font-bold">Searches and schedules</h1>
        </div>
        <p className="text-gray-500 mt-1 text-sm">Pausing or deleting stops the next runs; a run already going finishes. Found leads are kept.</p>
      </div>

      {error && <Card><CardContent><p className="text-gray-600">{error}</p></CardContent></Card>}
      {!error && searches.length === 0 && (
        <EmptyState icon={<CalendarClock className="w-8 h-8 text-gray-400" />} title="No lead searches yet" description="Create one on the Lead Finder page." />
      )}

      <div className="space-y-3">
        {searches.map((s) => {
          const sch = s.schedule;
          return (
            <Card key={s.id}>
              <CardContent className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
                <div className="text-sm">
                  <div className="font-semibold text-gray-900">{s.name}</div>
                  <div className="text-gray-500">
                    {[s.category ?? s.keywords.join(', '), s.city, s.countryCode].filter(Boolean).join(' · ')} · {s.targetPerRun} per run
                    {s.category && s.keywords.length ? ` · focus: ${s.keywords.join(', ')}` : ''}
                    {s.includePeople ? ' · decision makers' : ''}
                  </div>
                  <div className="mt-1">
                    {!sch && <span className="text-gray-400">No schedule</span>}
                    {sch && sch.isPaused && <span className="text-amber-600">Paused{sch.consecutiveFailures >= 3 ? ' after 3 failed runs' : ''}</span>}
                    {sch && !sch.isPaused && (
                      <span className="text-gray-700">
                        {sch.frequency === 'weekly' ? sch.weekdays.map((d) => DAY_LABEL[d]).join(', ') : 'Every day'} at {sch.runAtLocal} ({sch.timezone}) · next {nextRunText(sch.nextRunAt, sch.timezone)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" leftIcon={<Play className="w-4 h-4" />} onClick={() => void act(() => leadGenApi.runNow(s.id), `${s.name}: run started.`)}>Run now</Button>
                  <Button size="sm" variant="secondary" leftIcon={<CalendarClock className="w-4 h-4" />} onClick={() => setEditing(s)}>{sch ? 'Change time' : 'Schedule'}</Button>
                  {sch && (
                    <Button size="sm" variant="secondary" leftIcon={sch.isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                      onClick={() => void act(() => leadGenApi.updateSchedule(sch.id, { isPaused: !sch.isPaused }), sch.isPaused ? 'Schedule resumed.' : 'Schedule paused.')}>
                      {sch.isPaused ? 'Resume' : 'Pause'}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" leftIcon={<Trash2 className="w-4 h-4" />} onClick={() => setDeleting(s)}>Delete</Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ScheduleModal search={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      <ConfirmDialog
        isOpen={deleting != null}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const s = deleting;
          setDeleting(null);
          if (s) void act(() => leadGenApi.deleteSearch(s.id), `${s.name} deleted. Its leads are kept.`);
        }}
        title="Delete this lead search?"
        message="Its schedule stops. Leads it already found stay in your Lead Finder."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
