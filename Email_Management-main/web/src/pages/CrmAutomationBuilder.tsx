import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Bell, Clock, GitBranch, History, Mail, Phone, Plus, RefreshCw, Save, Sparkles, Tag, X } from 'lucide-react';
import { Button, Card, CardContent, Modal, useToast } from '../components/ui';
import { UpgradePrompt } from '../components/UpgradePrompt';
import {
  crmApi,
  crmAutomationsApi,
  settingsApi,
  apiErrorMessage,
  type AutomationCallResult,
  type AutomationCallStep,
  type AutomationKind,
  type AutomationResultStep,
  type AutomationStep,
  type AutomationWaitUnit,
  type CrmAutomation,
  type CrmAutomationRun,
  type CrmAutomationSettings,
  type SmtpSettingsResponse,
} from '../lib/api';
import { useCrmEnabled } from '../lib/crmAccess';
import { useCrmTags } from '../lib/useCrmTags';
import { controlStyle, iconButtonStyle, smallControlStyle } from '../components/crm/builderStyles';
import { CALL_RESULTS, CALL_RESULT_LABEL, CallResultButtons, RunStatus, fmtDate, runPositionText } from '../components/crm/automationUi';

const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', margin: '10px 0 4px' };
const full: React.CSSProperties = { ...controlStyle, width: '100%' };
const cell = { padding: '8px 8px' };
const UNITS: AutomationWaitUnit[] = ['minutes', 'hours', 'days'];

type Option = { id: number; name: string };
type Lookups = { tags: Option[]; stages: Option[] };

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function newStep(type: AutomationStep['type']): AutomationStep {
  const id = newId();
  switch (type) {
    case 'email':
      return { id, type, subject: '', body: '' };
    case 'wait':
      return { id, type, amount: 1, unit: 'days' };
    case 'remind':
      return { id, type, message: '' };
    case 'tag':
      return { id, type, tagId: 0 };
    case 'stage':
      return { id, type, stageId: 0 };
    case 'call':
      return { id, type, message: '', retries: 2, retryAmount: 1, retryUnit: 'days', outcomes: { interested: [], no_answer: [], not_interested: [] } };
  }
}

const ADD: Array<{ type: AutomationResultStep['type']; name: string; icon: React.ReactNode }> = [
  { type: 'email', name: 'Email', icon: <Mail className="w-3 h-3" /> },
  { type: 'wait', name: 'Wait', icon: <Clock className="w-3 h-3" /> },
  { type: 'remind', name: 'Remind me', icon: <Bell className="w-3 h-3" /> },
  { type: 'tag', name: 'Add tag', icon: <Tag className="w-3 h-3" /> },
  { type: 'stage', name: 'Move to stage', icon: <GitBranch className="w-3 h-3" /> },
];

const STEP_NAME: Record<AutomationStep['type'], string> = {
  email: 'Email',
  wait: 'Wait',
  remind: 'Remind me',
  tag: 'Add tag',
  stage: 'Move to stage',
  call: 'Call',
};

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {right}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** "Write with AI" for one email: the AI drafts the message; the user checks it and saves. */
function AiWriteButton({ ai, kind, step, onChange }: {
  ai: { automationId: number; followUpNumber: number; previous: string[] };
  kind: AutomationKind;
  step: Extract<AutomationResultStep, { type: 'email' }>;
  onChange: (s: AutomationResultStep) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [wish, setWish] = useState('');
  const write = async () => {
    if (step.body.trim() && !window.confirm('Replace this message with an AI draft?')) return;
    setBusy(true);
    try {
      const r = await crmAutomationsApi.aiWrite({ ...ai, instruction: wish.trim() || undefined });
      onChange({ ...step, body: r.body, subject: kind === 'form' && !step.subject.trim() && r.subject ? r.subject : step.subject });
      toast.success('AI draft added. Read it and change it if needed, then save.');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'The AI could not write the email'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 flex-wrap mt-2">
      <input
        aria-label="Wish for the AI"
        value={wish}
        placeholder="Wish for the AI (optional), e.g. short and friendly"
        onChange={(e) => setWish(e.target.value)}
        style={{ ...smallControlStyle, flex: 1, minWidth: 180 }}
      />
      <Button size="sm" variant="secondary" isLoading={busy} onClick={() => void write()} leftIcon={<Sparkles className="w-3 h-3" />}>
        Write with AI
      </Button>
    </div>
  );
}

/** Editor of one step that is not a call. */
function StepEditor({ step, index, count, onChange, onMove, onRemove, lookups, canThread, kind, ai }: {
  step: AutomationResultStep;
  index: number;
  count: number;
  onChange: (s: AutomationResultStep) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  lookups: Lookups;
  /** An email before this one has a subject, so this one may reply in its thread. */
  canThread: boolean;
  kind: AutomationKind;
  /** "Write with AI" for an email step. */
  ai: { automationId: number; followUpNumber: number; previous: string[] } | null;
}) {
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginTop: 8, background: '#ffffff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="text-xs font-semibold text-gray-500" style={{ flex: 1 }}>{index + 1}. {STEP_NAME[step.type]}</span>
        <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} style={iconButtonStyle}><ArrowUp size={13} /></button>
        <button type="button" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)} style={iconButtonStyle}><ArrowDown size={13} /></button>
        <button type="button" aria-label="Remove step" onClick={onRemove} style={iconButtonStyle}><X size={13} /></button>
      </div>
      {step.type === 'email' && (
        <>
          {kind === 'campaign' ? (
            <p className="text-xs text-gray-500 mt-1">Sent as a reply in the campaign's thread (Re: ...), from the campaign's email account.</p>
          ) : (
            <input
              aria-label="Subject"
              value={step.subject}
              placeholder={canThread ? 'Subject (leave empty to reply in the same thread)' : 'Subject, e.g. Thanks {{first_name}}!'}
              onChange={(e) => onChange({ ...step, subject: e.target.value })}
              style={{ ...full, marginTop: 6 }}
            />
          )}
          <textarea
            aria-label="Message"
            rows={4}
            value={step.body}
            placeholder={'Hi {{first_name}},\n\n...'}
            onChange={(e) => onChange({ ...step, body: e.target.value })}
            style={{ ...full, height: 'auto', padding: 8, marginTop: 6 }}
          />
          {ai && <AiWriteButton ai={ai} kind={kind} step={step} onChange={onChange} />}
        </>
      )}
      {step.type === 'wait' && (
        <div className="flex items-center gap-2 mt-2">
          <input
            aria-label="Wait"
            type="number"
            min={1}
            value={step.amount}
            onChange={(e) => onChange({ ...step, amount: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            style={{ ...smallControlStyle, width: 80 }}
          />
          <select aria-label="Unit" value={step.unit} onChange={(e) => onChange({ ...step, unit: e.target.value as AutomationWaitUnit })} style={smallControlStyle}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      )}
      {step.type === 'remind' && (
        <input
          aria-label="Reminder"
          value={step.message}
          placeholder="e.g. Call this lead"
          onChange={(e) => onChange({ ...step, message: e.target.value })}
          style={{ ...full, marginTop: 6 }}
        />
      )}
      {step.type === 'tag' && (
        <select aria-label="Tag" value={step.tagId || ''} onChange={(e) => onChange({ ...step, tagId: Number(e.target.value) || 0 })} style={{ ...full, marginTop: 6 }}>
          <option value="">Pick a tag</option>
          {lookups.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      {step.type === 'stage' && (
        <select aria-label="Stage" value={step.stageId || ''} onChange={(e) => onChange({ ...step, stageId: Number(e.target.value) || 0 })} style={{ ...full, marginTop: 6 }}>
          <option value="">Pick a stage</option>
          {lookups.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}

/** A list of steps that are not calls (the main list before the call, or the steps of one call result). */
function StepList({ steps, onChange, lookups, threadBefore, emptyText, kind, automationId, emailsBefore }: {
  steps: AutomationResultStep[];
  onChange: (steps: AutomationResultStep[]) => void;
  lookups: Lookups;
  /** An email with a subject comes before this list. */
  threadBefore: boolean;
  emptyText: string;
  kind: AutomationKind;
  automationId: number;
  /** Messages of the emails before this list (the AI does not repeat them). */
  emailsBefore: string[];
}) {
  let thread = threadBefore;
  const addable = kind === 'campaign' ? ADD.filter((a) => a.type === 'email' || a.type === 'wait') : ADD;
  return (
    <>
      {steps.length === 0 && <p className="text-xs text-gray-400 mt-2">{emptyText}</p>}
      {steps.map((s, i) => {
        const canThread = thread;
        if (s.type === 'email' && s.subject.trim()) thread = true;
        const previous = [...emailsBefore, ...steps.slice(0, i).flatMap((x) => (x.type === 'email' && x.body.trim() ? [x.body] : []))];
        return (
          <StepEditor
            key={s.id}
            step={s}
            index={i}
            count={steps.length}
            canThread={canThread}
            kind={kind}
            ai={s.type === 'email' ? { automationId, followUpNumber: previous.length + 1, previous } : null}
            lookups={lookups}
            onChange={(n) => onChange(steps.map((x, j) => (j === i ? n : x)))}
            onMove={(dir) => {
              const list = [...steps];
              [list[i], list[i + dir]] = [list[i + dir]!, list[i]!];
              onChange(list);
            }}
            onRemove={() => onChange(steps.filter((_, j) => j !== i))}
          />
        );
      })}
      <div className="flex flex-wrap gap-2 mt-3">
        {addable.map((a) => (
          <Button key={a.type} variant="secondary" size="sm" onClick={() => onChange([...steps, newStep(a.type) as AutomationResultStep])} leftIcon={a.icon}>
            {a.name}
          </Button>
        ))}
      </div>
    </>
  );
}

/** The call step: the reminder text, "call again" for No answer, and the steps for each result. */
function CallEditor({ step, onChange, onRemove, lookups, threadBefore, automationId, emailsBefore }: {
  step: AutomationCallStep;
  onChange: (s: AutomationCallStep) => void;
  onRemove: () => void;
  lookups: Lookups;
  threadBefore: boolean;
  automationId: number;
  emailsBefore: string[];
}) {
  const colors: Record<AutomationCallResult, string> = { interested: '#16a34a', no_answer: '#d97706', not_interested: '#6b7280' };
  return (
    <div style={{ border: '2px solid #c7d2fe', borderRadius: 10, padding: 12, marginTop: 12, background: '#f5f7ff' }}>
      <div className="flex items-center gap-2">
        <Phone className="w-4 h-4 text-indigo-600" aria-hidden />
        <span className="text-sm font-semibold text-gray-900" style={{ flex: 1 }}>Call the lead</span>
        <button type="button" aria-label="Remove call step" onClick={onRemove} style={iconButtonStyle}><X size={13} /></button>
      </div>
      <p className="text-xs text-gray-500 mt-1">
        You get a reminder in the bell and in Automations → Calls to make. The automation waits until you pick the result.
      </p>
      <span style={label}>Note in the reminder (optional)</span>
      <input value={step.message} placeholder="e.g. Ask about their budget" onChange={(e) => onChange({ ...step, message: e.target.value })} style={full} />
      <div className="flex items-center gap-2 flex-wrap mt-3 text-sm text-gray-700">
        <span>No answer: call again</span>
        <input
          aria-label="Call again times"
          type="number"
          min={0}
          max={5}
          value={step.retries}
          onChange={(e) => onChange({ ...step, retries: Math.min(5, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
          style={{ ...smallControlStyle, width: 60 }}
        />
        <span>times, after</span>
        <input
          aria-label="Call again after"
          type="number"
          min={1}
          value={step.retryAmount}
          onChange={(e) => onChange({ ...step, retryAmount: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
          style={{ ...smallControlStyle, width: 60 }}
        />
        <select aria-label="Call again unit" value={step.retryUnit} onChange={(e) => onChange({ ...step, retryUnit: e.target.value as AutomationWaitUnit })} style={smallControlStyle}>
          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      {CALL_RESULTS.map((r) => (
        <div key={r} style={{ borderLeft: `3px solid ${colors[r]}`, paddingLeft: 10, marginTop: 14 }}>
          <h3 className="text-sm font-semibold" style={{ color: colors[r] }}>
            If {CALL_RESULT_LABEL[r]}
            {r === 'no_answer' && step.retries > 0 ? ` (after ${step.retries + 1} calls)` : ''}
          </h3>
          <StepList
            steps={step.outcomes[r]}
            lookups={lookups}
            threadBefore={threadBefore}
            kind="form"
            automationId={automationId}
            emailsBefore={emailsBefore}
            emptyText="No steps: the automation ends here for this result."
            onChange={(list) => onChange({ ...step, outcomes: { ...step.outcomes, [r]: list } })}
          />
        </div>
      ))}
    </div>
  );
}

function HistoryModal({ run, onClose }: { run: CrmAutomationRun; onClose: () => void }) {
  const [events, setEvents] = useState<Array<{ kind: string; detail: string | null; at: string }> | null>(null);
  useEffect(() => {
    crmAutomationsApi.events(run.id).then(setEvents).catch(() => setEvents([]));
  }, [run.id]);
  return (
    <Modal isOpen onClose={onClose} title={`History · ${run.name?.trim() || run.email}`} size="lg">
      {!events && <p className="text-sm text-gray-400">Loading…</p>}
      {events && events.length === 0 && <p className="text-sm text-gray-400">Nothing yet.</p>}
      <ul className="space-y-2">
        {(events ?? []).map((e, i) => (
          <li key={i} className="text-sm" style={{ display: 'flex', gap: 10 }}>
            <span className="text-xs text-gray-400" style={{ width: 150, flexShrink: 0 }}>{fmtDate(e.at)}</span>
            <span className={e.kind === 'error' ? 'text-red-600' : 'text-gray-700'}>{e.detail ?? e.kind}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

const TABS: Array<{ key: string; name: string }> = [
  { key: 'open', name: 'Running' },
  { key: 'completed', name: 'Completed' },
  { key: 'stopped', name: 'Stopped' },
  { key: '', name: 'All' },
];
const PAGE = 50;

/** Leads in this automation: where each one is, and Stop / call result / history. */
function RunsPanel({ automation, onChanged }: { automation: CrmAutomation; onChanged: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState('open');
  const [offset, setOffset] = useState(0);
  const [runs, setRuns] = useState<CrmAutomationRun[] | null>(null);
  const [total, setTotal] = useState(0);
  const [history, setHistory] = useState<CrmAutomationRun | null>(null);

  const load = useCallback(() => {
    crmAutomationsApi
      .runs(automation.id, tab, offset, PAGE)
      .then((r) => {
        setRuns(r.runs);
        setTotal(r.total);
      })
      .catch((e) => toast.error(apiErrorMessage(e, 'Could not load the leads')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automation.id, tab, offset]);
  useEffect(load, [load]);

  const changed = () => {
    load();
    onChanged();
  };

  const sendNow = async (run: CrmAutomationRun) => {
    if (!window.confirm(`Skip the wait for ${run.name?.trim() || run.email} and run the next step now?`)) return;
    try {
      toast.success((await crmAutomationsApi.sendNow(run.id)).message);
      changed();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not send it now'));
    }
  };

  const stop = async (run: CrmAutomationRun) => {
    if (!window.confirm(`Stop this automation for ${run.name?.trim() || run.email}?`)) return;
    try {
      toast.success((await crmAutomationsApi.stopRun(run.id)).message);
      changed();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not stop it'));
    }
  };

  return (
    <Section
      title="Leads in this automation"
      right={<Button variant="ghost" size="sm" onClick={changed} leftIcon={<RefreshCw className="w-3 h-3" />}>Refresh</Button>}
    >
      <div className="flex flex-wrap gap-2 mt-2">
        {TABS.map((t) => (
          <Button key={t.key || 'all'} size="sm" variant={tab === t.key ? 'primary' : 'secondary'} onClick={() => { setTab(t.key); setOffset(0); }}>
            {t.name}
          </Button>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead>
            <tr className="text-xs text-gray-500" style={{ textAlign: 'left' }}>
              <th style={cell}>Lead</th>
              <th style={cell}>Status</th>
              <th style={cell}>Where</th>
              <th style={cell}>Next</th>
              <th style={{ ...cell, textAlign: 'right' }}>Emails</th>
              <th style={cell} />
            </tr>
          </thead>
          <tbody>
            {(runs ?? []).map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                <td style={cell}>
                  <Link to={`/crm?lead=${r.contactId}`} className="font-medium text-gray-900">{r.name?.trim() || r.email}</Link>
                  {r.name?.trim() && <div className="text-xs text-gray-500">{r.email}</div>}
                  {r.formName && <div className="text-xs text-gray-400">Form: {r.formName}</div>}
                  {r.campaignName && <div className="text-xs text-gray-400">Campaign: {r.campaignName}</div>}
                </td>
                <td style={cell}><RunStatus status={r.status} /></td>
                <td style={cell}>
                  <div className="text-gray-700">{runPositionText(r, automation.steps)}</div>
                  {r.stopReason && <div className="text-xs text-gray-500">{r.stopReason}</div>}
                  {r.lastError && r.status !== 'completed' && r.status !== 'stopped' && <div className="text-xs" style={{ color: '#b45309' }}>{r.lastError}</div>}
                  {r.status === 'waiting_call' && <div className="mt-2"><CallResultButtons runId={r.id} onDone={changed} /></div>}
                </td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }} className="text-gray-500">{r.status === 'active' ? fmtDate(r.nextRunAt) : '—'}</td>
                <td style={{ ...cell, textAlign: 'right' }}>{r.emailsSent}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap', textAlign: 'right' }}>
                  <button type="button" title="History" aria-label="History" onClick={() => setHistory(r)} style={iconButtonStyle}><History size={15} /></button>
                  {r.status === 'active' && (
                    <Button variant="ghost" size="sm" onClick={() => void sendNow(r)} title="Skip the wait: the next step runs now">Send now</Button>
                  )}
                  {(r.status === 'active' || r.status === 'waiting_call') && (
                    <Button variant="ghost" size="sm" onClick={() => void stop(r)}>Stop</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs && runs.length === 0 && (
          <p className="text-sm text-gray-400" style={{ padding: 12 }}>
            {automation.kind === 'campaign'
              ? 'No leads here yet. Leads join after the first email of a campaign that uses this automation goes out.'
              : 'No leads here yet. Leads join when someone submits a form that uses this automation.'}
          </p>
        )}
      </div>
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
          <span className="text-xs text-gray-500">{offset + 1}–{Math.min(total, offset + PAGE)} of {total}</span>
          <Button variant="ghost" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
        </div>
      )}
      {history && <HistoryModal run={history} onClose={() => setHistory(null)} />}
    </Section>
  );
}

const settingsOf = (a: CrmAutomation): CrmAutomationSettings => ({ name: a.name, kind: a.kind, isActive: a.isActive, smtpSettingsId: a.smtpSettingsId, steps: a.steps });

/** All server errors of a failed save (the API sends `errors`), else the one message. */
function errorList(e: unknown, fallback: string): string[] {
  const data = e && typeof e === 'object' && 'response' in e ? (e as { response?: { data?: { errors?: unknown } } }).response?.data : undefined;
  return Array.isArray(data?.errors) && data.errors.length ? data.errors.map(String) : [apiErrorMessage(e, fallback)];
}

/** Automation builder: name, on/off, email account, steps (with the call and its results) and the leads in it. */
export function CrmAutomationBuilder() {
  const crmEnabled = useCrmEnabled();
  const toast = useToast();
  const id = Number(useParams().id);
  const [automation, setAutomation] = useState<CrmAutomation | null>(null);
  const [s, setS] = useState<CrmAutomationSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [smtps, setSmtps] = useState<SmtpSettingsResponse[]>([]);
  const [stages, setStages] = useState<Option[]>([]);
  const { tags } = useCrmTags(crmEnabled);

  const reload = useCallback(() => {
    crmAutomationsApi.get(id).then(setAutomation).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    if (!crmEnabled || !Number.isInteger(id)) return;
    crmAutomationsApi
      .get(id)
      .then((a) => {
        setAutomation(a);
        setS(settingsOf(a));
      })
      .catch((e) => setLoadError(apiErrorMessage(e, 'Could not load the automation')));
    settingsApi.listSmtpProfiles().then((r) => setSmtps(r.profiles)).catch(() => undefined);
    crmApi
      .getPipelines()
      .then((pipelines) => Promise.all(pipelines.map((p) => crmApi.getPipeline(p.id).then((d) => d.stages.map((st) => ({ id: st.id, name: pipelines.length > 1 ? `${p.name} › ${st.name}` : st.name }))))))
      .then((lists) => setStages(lists.flat()))
      .catch(() => undefined);
  }, [crmEnabled, id]);

  if (!crmEnabled) return <UpgradePrompt feature="Automations" />;
  if (loadError) return <p className="text-sm text-red-600">{loadError}</p>;
  if (!automation || !s) return <p className="text-sm text-gray-400">Loading…</p>;

  const lookups: Lookups = { tags: tags.filter((t) => t.scope !== 'campaign').map((t) => ({ id: t.id, name: t.name })), stages };
  const set = (patch: Partial<CrmAutomationSettings>) => {
    setS({ ...s, ...patch });
    setDirty(true);
  };

  const call = s.steps.find((x): x is AutomationCallStep => x.type === 'call') ?? null;
  const before = s.steps.filter((x): x is AutomationResultStep => x.type !== 'call');
  const threadBeforeCall = before.some((x) => x.type === 'email' && x.subject.trim() !== '');
  const setMain = (list: AutomationResultStep[], callStep: AutomationCallStep | null = call) => set({ steps: callStep ? [...list, callStep] : list });

  const save = async () => {
    setSaving(true);
    try {
      const a = await crmAutomationsApi.update(automation.id, s);
      setAutomation(a);
      setS(settingsOf(a));
      setDirty(false);
      setErrors([]);
      toast.success('Automation saved');
    } catch (e) {
      const list = errorList(e, 'Could not save the automation');
      setErrors(list);
      toast.error(list[0]!);
    } finally {
      setSaving(false);
    }
  };

  const inUse = automation.counts.running + automation.counts.waitingCall;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/crm/automations" className="text-gray-500 hover:text-gray-900" aria-label="Back to automations"><ArrowLeft className="w-5 h-5" /></Link>
        <input aria-label="Automation name" value={s.name} onChange={(e) => set({ name: e.target.value })} style={{ ...controlStyle, fontSize: 18, fontWeight: 700, flex: 1, minWidth: 200 }} />
        <label className="text-sm text-gray-700 flex items-center gap-2">
          <input type="checkbox" checked={s.isActive} onChange={(e) => set({ isActive: e.target.checked })} style={{ width: 16, height: 16 }} />
          Automation on
        </label>
        <Button onClick={() => void save()} isLoading={saving} disabled={!dirty} leftIcon={<Save className="w-4 h-4" />}>Save</Button>
      </div>
      {dirty && <p className="text-xs" style={{ color: '#b45309' }}>Unsaved changes.</p>}
      {errors.length > 0 && (
        <div className="text-sm text-red-600" style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 8, padding: '8px 12px' }}>
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {s.kind === 'campaign' ? (
        <Section title="Settings">
          <p className="text-sm text-gray-700 mt-2">
            Campaign follow-ups. After a campaign's first email goes out, each lead gets these steps. Every follow-up is a reply in the
            campaign's thread, from the campaign's own email account.
          </p>
          <span style={label}>Used by these campaigns</span>
          {automation.usedByCampaigns.length ? (
            <div className="flex flex-wrap gap-2">
              {automation.usedByCampaigns.map((c) => (
                <Link key={c.id} to={`/campaigns/${c.id}`} className="text-sm text-indigo-600">{c.name}</Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No campaign yet. Open a campaign that has not started and pick this automation there.</p>
          )}
          <p className="text-xs text-gray-400 mt-2">
            Follow-ups stop by themselves when the lead replies, unsubscribes or bounces, when the CRM stops follow-ups for the lead
            (for example the Interested, Won or Lost stage), or when the campaign is cancelled. While the campaign is paused they wait.
            Every email counts toward the 20 emails per account per day.
          </p>
        </Section>
      ) : (
      <Section title="Settings">
        <span style={label}>Send emails from</span>
        <select value={s.smtpSettingsId ?? ''} onChange={(e) => set({ smtpSettingsId: e.target.value ? Number(e.target.value) : null })} style={full}>
          <option value="">Pick an email account</option>
          {smtps.map((p) => <option key={p.id} value={p.id}>{p.fromEmail}</option>)}
        </select>
        <p className="text-xs text-gray-400 mt-1">Emails count against this account's daily limit, together with your campaigns.</p>
        <span style={label}>Used by these forms</span>
        {automation.usedBy.length ? (
          <div className="flex flex-wrap gap-2">
            {automation.usedBy.map((f) => <Link key={f.id} to={`/crm/forms/${f.id}`} className="text-sm text-indigo-600">{f.name}</Link>)}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No form yet. Open a form (Forms) and pick this automation there.</p>
        )}
        <p className="text-xs text-gray-400 mt-2">
          It stops by itself for a lead who unsubscribes, whose email bounces, or who is moved to Won or Lost. A reply does not stop it.
        </p>
      </Section>
      )}

      <Section title="Steps">
        {s.kind === 'campaign' ? (
          <p className="text-xs text-gray-500 mt-1">
            The steps run from top to bottom after the campaign's first email. Start with a Wait (for example 2 days), then a follow-up email.
            You can use {'{{first_name}}'}, {'{{name}}'}, {'{{email}}'} and the columns of your recipient file, like in the campaign email.
          </p>
        ) : (
          <p className="text-xs text-gray-500 mt-1">
            The steps run from top to bottom for every new lead. The first ones run right after the form is sent. You can use {'{{first_name}}'}, {'{{name}}'},{' '}
            {'{{email}}'}, {'{{company}}'}, {'{{phone}}'} and {'{{form}}'} in emails and reminders.
          </p>
        )}
        {inUse > 0 && (
          <p className="text-xs mt-1" style={{ color: '#b45309' }}>
            {inUse} lead(s) are in this automation now. They go on from their step number, so adding or removing steps above them can make them skip or repeat one.
          </p>
        )}
        <StepList
          steps={before}
          lookups={lookups}
          threadBefore={false}
          kind={s.kind}
          automationId={automation.id}
          emailsBefore={[]}
          emptyText="No steps yet. Add the first one below."
          onChange={(list) => setMain(list)}
        />
        {s.kind === 'campaign' ? null : call ? (
          <CallEditor
            step={call}
            lookups={lookups}
            threadBefore={threadBeforeCall}
            automationId={automation.id}
            emailsBefore={before.flatMap((x) => (x.type === 'email' && x.body.trim() ? [x.body] : []))}
            onChange={(c) => setMain(before, c)}
            onRemove={() => setMain(before, null)}
          />
        ) : (
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => setMain(before, newStep('call') as AutomationCallStep)} leftIcon={<Plus className="w-3 h-3" />}>
              Add a call (with Interested / No answer / Not interested)
            </Button>
            <p className="text-xs text-gray-400 mt-1">The call is always the last main step. Its results hold the next steps.</p>
          </div>
        )}
      </Section>

      <RunsPanel automation={automation} onChanged={reload} />
    </div>
  );
}
