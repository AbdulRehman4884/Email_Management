import React, { useEffect, useRef, useState } from 'react';
import { Gauge, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { crmApi, apiErrorMessage, type CrmRecalcJob, type CrmScoreWeights, type CrmScoring } from '../../lib/api';
import { REPLY_LABELS, REPLY_LABEL_META } from '../../lib/replyLabels';
import { Button, Card, CardContent, useToast } from '../ui';
import { controlStyle, iconButtonStyle, smallControlStyle } from './builderStyles';
import { TIER_STYLE } from './ScoreBadge';

const numInput: React.CSSProperties = { ...smallControlStyle, width: 70, textAlign: 'right' };

function NumberField({ value, onChange, min = -100, max = 100, label }: { value: number; onChange: (n: number) => void; min?: number; max?: number; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      value={text}
      min={min}
      max={max}
      step={1}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n)) onChange(Math.round(n));
      }}
      onBlur={() => setText(String(value))}
      style={numInput}
    />
  );
}

function Row({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f9fafb', flexWrap: 'wrap' }}>
      {children}
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#374151', margin: '16px 0 4px' };

/** Settings → "Lead scoring" (CRM step 7): weights, thresholds, tag / custom field points, recalculate. */
export function CrmScoringSettings() {
  const toast = useToast();
  const [data, setData] = useState<CrmScoring | null>(null);
  const [w, setW] = useState<CrmScoreWeights | null>(null);
  const [hot, setHot] = useState(70);
  const [warm, setWarm] = useState(40);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [job, setJob] = useState<CrmRecalcJob | null>(null);
  const [hidden, setHidden] = useState(false);
  const [newTagId, setNewTagId] = useState('');
  const poll = useRef<number | null>(null);

  const apply = (s: CrmScoring) => {
    setData(s);
    setW(s.weights);
    setHot(s.hotThreshold);
    setWarm(s.warmThreshold);
    setDirty(false);
    if (s.job?.running) watchJob();
  };

  const watchJob = () => {
    if (poll.current != null) return;
    poll.current = window.setInterval(async () => {
      try {
        const j = await crmApi.getScoreRecalc();
        setJob(j);
        if (!j || !j.running) {
          if (poll.current != null) window.clearInterval(poll.current);
          poll.current = null;
          if (j?.error) toast.error(`Recalculation failed: ${j.error}`);
          else if (j) toast.success(`Scores recalculated: ${j.done} lead(s), ${j.changed} changed`);
        }
      } catch {
        // keep polling
      }
    }, 700);
  };

  useEffect(() => {
    crmApi.getScoring().then(apply).catch(() => setHidden(true)); // no CRM in the plan: the rest of Settings still works
    return () => {
      if (poll.current != null) window.clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (hidden || !data || !w) return null;

  const set = (patch: Partial<CrmScoreWeights>) => {
    setW({ ...w, ...patch });
    setDirty(true);
  };

  const save = async (weights: CrmScoreWeights, hotT: number, warmT: number) => {
    setSaving(true);
    try {
      const s = await crmApi.saveScoring({ weights, hotThreshold: hotT, warmThreshold: warmT });
      apply(s);
      const j = await crmApi.startScoreRecalc();
      setJob(j);
      watchJob();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the scoring settings'));
    } finally {
      setSaving(false);
    }
  };

  const tagName = (id: string) => data.tags.find((t) => String(t.id) === id);
  const unusedTags = data.tags.filter((t) => !(String(t.id) in w.tags));

  return (
    <Card>
      <CardContent className="py-5">
        <div className="flex items-center gap-2">
          <Gauge className="w-4 h-4 text-gray-500" />
          <h2 className="text-base font-semibold text-gray-900">Lead scoring</h2>
        </div>
        <p className="text-sm text-gray-500 mt-0.5">
          Every lead gets a score from 0 to 100 from what it does. Leads at the top are the ones to talk to first.
        </p>

        <h3 style={sectionTitle}>Tiers</h3>
        <Row>
          <span style={{ width: 120, color: TIER_STYLE.hot!.fg }} className="text-sm font-semibold">🔥 Hot from</span>
          <NumberField label="Hot from" value={hot} min={1} max={100} onChange={(n) => { setHot(n); setDirty(true); }} />
          <span style={{ width: 16 }} />
          <span style={{ width: 90, color: TIER_STYLE.warm!.fg }} className="text-sm font-semibold">Warm from</span>
          <NumberField label="Warm from" value={warm} min={1} max={100} onChange={(n) => { setWarm(n); setDirty(true); }} />
          <span className="text-xs text-gray-400">Below {warm} is Cold.</span>
        </Row>

        <h3 style={sectionTitle}>Activity</h3>
        <Row>
          <span className="text-sm text-gray-700" style={{ width: 220 }}>Each email opened</span>
          <NumberField label="Email opened" value={w.email_opened} onChange={(n) => set({ email_opened: n })} />
          <span className="text-xs text-gray-500">at most</span>
          <NumberField label="Most points from opens" value={w.email_opened_max} min={0} onChange={(n) => set({ email_opened_max: n })} />
          <span className="text-xs text-gray-500">in total</span>
        </Row>
        <Row>
          <span className="text-sm text-gray-700" style={{ width: 220 }}>Each reply received</span>
          <NumberField label="Reply received" value={w.reply_received} onChange={(n) => set({ reply_received: n })} />
        </Row>
        <Row hint="(sent after the last reply)">
          <span className="text-sm text-gray-700" style={{ width: 220 }}>Each follow-up with no reply</span>
          <NumberField label="Follow-up with no reply" value={w.follow_up_no_reply} onChange={(n) => set({ follow_up_no_reply: n })} />
        </Row>
        <Row>
          <span className="text-sm text-gray-700" style={{ width: 220 }}>No activity, for every</span>
          <NumberField label="No activity points" value={w.inactivity} onChange={(n) => set({ inactivity: n })} />
          <span className="text-xs text-gray-500">points per</span>
          <NumberField label="No activity days" value={w.inactivity_days} min={1} max={365} onChange={(n) => set({ inactivity_days: n })} />
          <span className="text-xs text-gray-500">days</span>
        </Row>

        <h3 style={sectionTitle}>Latest reply label</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', columnGap: 24 }}>
          {REPLY_LABELS.map((l) => (
            <Row key={l}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: REPLY_LABEL_META[l].color }} />
              <span className="text-sm text-gray-700" style={{ flex: 1 }}>{REPLY_LABEL_META[l].name}</span>
              <NumberField label={REPLY_LABEL_META[l].name} value={w.labels[l] ?? 0} onChange={(n) => set({ labels: { ...w.labels, [l]: n } })} />
            </Row>
          ))}
        </div>

        <h3 style={sectionTitle}>Tags</h3>
        {Object.keys(w.tags).length === 0 && <p className="text-xs text-gray-400">No tag points yet.</p>}
        {Object.entries(w.tags).map(([id, points]) => {
          const t = tagName(id);
          return (
            <Row key={id}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: t?.color ?? '#9ca3af' }} />
              <span className="text-sm text-gray-700" style={{ width: 200 }}>{t?.name ?? `Deleted tag #${id}`}</span>
              <NumberField label={`Points for tag ${t?.name ?? id}`} value={points} onChange={(n) => set({ tags: { ...w.tags, [id]: n } })} />
              <button
                type="button"
                aria-label="Remove"
                className="hover:bg-red-50 hover:text-red-600"
                style={iconButtonStyle}
                onClick={() => {
                  const next = { ...w.tags };
                  delete next[id];
                  set({ tags: next });
                }}
              >
                <Trash2 size={14} />
              </button>
            </Row>
          );
        })}
        {unusedTags.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <select aria-label="Add tag points" value={newTagId} onChange={(e) => setNewTagId(e.target.value)} style={{ ...controlStyle, height: 30, fontSize: 12, width: 200 }}>
              <option value="">Choose a tag…</option>
              {unusedTags.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!newTagId}
              leftIcon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => {
                set({ tags: { ...w.tags, [newTagId]: 10 } });
                setNewTagId('');
              }}
            >
              Add tag points
            </Button>
          </div>
        )}

        <h3 style={sectionTitle}>Custom fields</h3>
        <p className="text-xs text-gray-400" style={{ marginBottom: 4 }}>Points when a lead's CSV column has a value, e.g. industry = Real Estate → +10. Not case sensitive.</p>
        <datalist id="crm-custom-field-names">
          {data.customFieldNames.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {w.custom_fields.map((r, i) => (
          <Row key={i}>
            <input
              aria-label={`Rule ${i + 1} field`}
              list="crm-custom-field-names"
              placeholder="Field, e.g. industry"
              value={r.field}
              maxLength={64}
              onChange={(e) => set({ custom_fields: w.custom_fields.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })}
              style={{ ...smallControlStyle, width: 150 }}
            />
            <span className="text-sm text-gray-500">=</span>
            <input
              aria-label={`Rule ${i + 1} value`}
              placeholder="Value, e.g. Real Estate"
              value={r.equals}
              maxLength={200}
              onChange={(e) => set({ custom_fields: w.custom_fields.map((x, j) => (j === i ? { ...x, equals: e.target.value } : x)) })}
              style={{ ...smallControlStyle, width: 170 }}
            />
            <NumberField label={`Rule ${i + 1} points`} value={r.points} onChange={(n) => set({ custom_fields: w.custom_fields.map((x, j) => (j === i ? { ...x, points: n } : x)) })} />
            <button
              type="button"
              aria-label={`Remove rule ${i + 1}`}
              className="hover:bg-red-50 hover:text-red-600"
              style={iconButtonStyle}
              onClick={() => set({ custom_fields: w.custom_fields.filter((_, j) => j !== i) })}
            >
              <Trash2 size={14} />
            </button>
          </Row>
        ))}
        <Button size="sm" variant="secondary" leftIcon={<Plus className="w-3.5 h-3.5" />} onClick={() => set({ custom_fields: [...w.custom_fields, { field: '', equals: '', points: 10 }] })}>
          Add custom field rule
        </Button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', borderTop: '1px solid #f3f4f6', marginTop: 18, paddingTop: 14 }}>
          <Button onClick={() => void save(w, hot, warm)} isLoading={saving} disabled={saving || job?.running === true}>
            {dirty ? 'Save and recalculate' : 'Recalculate all scores'}
          </Button>
          <Button
            variant="secondary"
            leftIcon={<RotateCcw className="w-4 h-4" />}
            disabled={saving || job?.running === true}
            onClick={() => {
              setW({ ...data.defaults.weights, tags: w.tags, custom_fields: w.custom_fields });
              setHot(data.defaults.hotThreshold);
              setWarm(data.defaults.warmThreshold);
              setDirty(true);
            }}
          >
            Default points
          </Button>
          {dirty && <span className="text-xs" style={{ color: '#b45309' }}>Unsaved changes</span>}
          {job && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: '1 1 200px', minWidth: 180 }}>
              <span style={{ flex: 1, height: 6, borderRadius: 999, background: '#f3f4f6', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${job.total ? Math.round((job.done / job.total) * 100) : 100}%`, background: job.error ? '#dc2626' : '#16a34a', transition: 'width .3s' }} />
              </span>
              <span className="text-xs text-gray-500" style={{ whiteSpace: 'nowrap' }}>
                {job.running ? `Recalculating ${job.done}/${job.total}…` : job.error ? 'Failed' : `Done: ${job.done} lead(s), ${job.changed} changed`}
              </span>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
