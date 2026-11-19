import React, { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { campaignApi, followUpApi } from '../lib/api';
import type { Campaign, FollowUpEngagement, FollowUpTemplate } from '../types';
import { Button, useToast } from './ui';
import { ISO_WEEKDAY_OPTIONS } from '../lib/isoWeekdays';

/** Keep in sync with MAX_FOLLOW_UP_SEQUENCE_STEPS on the backend. */
const MAX_STEPS = 5;

interface SequenceStep {
  offsetDays: number;
  templateId: string;
}

interface Props {
  campaign: Campaign;
  /** Called after an inline message is added so the parent keeps the latest campaign. */
  onCampaignUpdated: (c: Campaign) => void;
  /** Called after the sequence is scheduled (e.g. to navigate away). */
  onDone: () => void;
}

/**
 * Simple, day-based builder for a whole follow-up sequence. The user only picks, per step,
 * "how many days after the previous step" and which message to send; the backend turns that
 * into concrete, stage-matched follow-up jobs. "Reply stops follow-ups", SMTP quota and all
 * other engine behaviour are unchanged — this is only an easy way to set up the timing.
 */
export function FollowUpSequenceBuilder({ campaign, onCampaignUpdated, onDone }: Props) {
  const toast = useToast();
  const templates = campaign.followUpTemplates ?? [];

  const [steps, setSteps] = useState<SequenceStep[]>(() => [
    { offsetDays: 2, templateId: templates[0]?.id ?? '' },
  ]);
  const [engagement, setEngagement] = useState<FollowUpEngagement>('sent');
  const [submitting, setSubmitting] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxRunDurationStr, setMaxRunDurationStr] = useState('');
  const [maxRunDurationUnit, setMaxRunDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const [sendWeekdaysEnabled, setSendWeekdaysEnabled] = useState(false);
  const [selectedSendWeekdays, setSelectedSendWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);

  // Inline "add a follow-up message" editor (saves onto the campaign, same as the single flow).
  const [addMsgOpen, setAddMsgOpen] = useState(false);
  const [msgForm, setMsgForm] = useState({ title: '', subject: '', body: '' });
  const [msgSaving, setMsgSaving] = useState(false);

  /** Cumulative days from now for each step, for the plain-language preview. */
  const cumulativeDays = useMemo(() => {
    const out: number[] = [];
    let total = 0;
    for (const s of steps) {
      total += Number.isFinite(s.offsetDays) ? Math.max(0, Math.floor(s.offsetDays)) : 0;
      out.push(total);
    }
    return out;
  }, [steps]);

  const updateStep = (index: number, patch: Partial<SequenceStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addStep = () => {
    setSteps((prev) => {
      if (prev.length >= MAX_STEPS) return prev;
      // Default the next message to one that isn't used yet, else the first.
      const used = new Set(prev.map((s) => s.templateId));
      const nextTpl = templates.find((t) => !used.has(t.id)) ?? templates[0];
      return [...prev, { offsetDays: 3, templateId: nextTpl?.id ?? '' }];
    });
  };

  const removeStep = (index: number) => {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const toggleSendWeekday = (iso: number) => {
    setSelectedSendWeekdays((prev) =>
      prev.includes(iso) ? prev.filter((x) => x !== iso) : [...prev, iso].sort((a, b) => a - b)
    );
  };

  const saveNewMessage = async () => {
    const title = msgForm.title.trim();
    const subject = msgForm.subject.trim();
    const body = msgForm.body.trim();
    if (!subject || !body) {
      toast.error('Subject and message are required');
      return;
    }
    setMsgSaving(true);
    try {
      const list: FollowUpTemplate[] = [...(campaign.followUpTemplates ?? [])];
      const id = crypto.randomUUID();
      list.push({ id, title: title || `Follow-up ${list.length + 1}`, subject, body });
      const updated = await campaignApi.patchFollowUpSettings(campaign.id, { followUpTemplates: list });
      onCampaignUpdated(updated);
      setAddMsgOpen(false);
      setMsgForm({ title: '', subject: '', body: '' });
      toast.success('Message saved on campaign');
    } catch {
      toast.error('Could not save message');
    } finally {
      setMsgSaving(false);
    }
  };

  const submit = async () => {
    if (steps.length === 0) {
      toast.error('Add at least one follow-up');
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      const days = steps[i].offsetDays;
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        toast.error(`Follow-up ${i + 1}: days must be a whole number between 1 and 365`);
        return;
      }
      if (!steps[i].templateId) {
        toast.error(`Follow-up ${i + 1}: choose a message`);
        return;
      }
    }

    let maxRunMinutes: number | null = null;
    const rawMax = maxRunDurationStr.trim();
    if (rawMax) {
      const n = Number(rawMax);
      const mult = maxRunDurationUnit === 'hours' ? 60 : 1;
      const mins = Math.floor(n * mult);
      if (!Number.isFinite(n) || n < 1 || mins < 1 || mins > 10080) {
        toast.error('Max run must be between 1 minute and 7 days (10080 minutes).');
        return;
      }
      maxRunMinutes = mins;
    }
    if (sendWeekdaysEnabled && selectedSendWeekdays.length === 0) {
      toast.error('Pick at least one weekday, or turn off day filtering.');
      return;
    }

    setSubmitting(true);
    try {
      const { jobs } = await followUpApi.createSequence({
        campaignId: campaign.id,
        steps: steps.map((s) => ({ offsetDays: Math.floor(s.offsetDays), templateId: s.templateId })),
        engagement,
        ...(maxRunMinutes != null ? { maxRunMinutes } : {}),
        ...(sendWeekdaysEnabled ? { sendWeekdays: selectedSendWeekdays } : {}),
      });
      toast.success(`Scheduled ${jobs.length} follow-up${jobs.length === 1 ? '' : 's'} for this campaign`);
      onDone();
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? (e as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined;
      toast.error(typeof msg === 'string' ? msg : 'Could not schedule the sequence');
    } finally {
      setSubmitting(false);
    }
  };

  const templateName = (id: string) => {
    const t = templates.find((x) => x.id === id);
    return t?.title || t?.subject || id;
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs text-blue-900">
        Set up several follow-ups at once. Each one sends a number of days after the previous step. If a
        recipient replies, their remaining follow-ups stop automatically.
      </div>

      {templates.length === 0 && !addMsgOpen ? (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          This campaign has no follow-up messages yet. Add one below to start a sequence.
        </p>
      ) : (
        <div className="space-y-3">
          {steps.map((step, i) => (
            <div key={i} className="rounded-lg border border-gray-200 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">Follow-up {i + 1}</span>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-600"
                    aria-label={`Remove follow-up ${i + 1}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[auto,1fr] gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {i === 0 ? 'Days after campaign' : 'Days after previous'}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    className="w-28 rounded-lg border border-gray-200 px-3 py-2 text-sm tabular-nums"
                    value={Number.isFinite(step.offsetDays) ? step.offsetDays : ''}
                    onChange={(e) =>
                      updateStep(i, { offsetDays: Math.max(1, Math.floor(Number(e.target.value) || 1)) })
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Message</label>
                  <select
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-gray-900/15"
                    value={step.templateId}
                    onChange={(e) => updateStep(i, { templateId: e.target.value })}
                  >
                    <option value="">Choose message…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title || t.subject || t.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Sends about <strong>{cumulativeDays[i]}</strong> day{cumulativeDays[i] === 1 ? '' : 's'} from now
                {step.templateId ? (
                  <> · <span className="text-gray-700">{templateName(step.templateId)}</span></>
                ) : null}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {steps.length < MAX_STEPS && templates.length > 0 && (
          <button
            type="button"
            onClick={addStep}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900"
          >
            <Plus className="w-4 h-4" /> Add follow-up
          </button>
        )}
        <button
          type="button"
          className="text-sm font-medium text-gray-700 hover:text-gray-900"
          onClick={() => setAddMsgOpen((o) => !o)}
        >
          {addMsgOpen ? 'Close message editor' : 'Add a message'}
        </button>
        {steps.length >= MAX_STEPS && (
          <span className="text-xs text-gray-400">Up to {MAX_STEPS} follow-ups.</span>
        )}
      </div>

      {addMsgOpen && (
        <div className="space-y-2 border border-gray-100 rounded-lg p-3 bg-gray-50">
          <input
            placeholder="Title (optional)"
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm"
            value={msgForm.title}
            onChange={(e) => setMsgForm((p) => ({ ...p, title: e.target.value }))}
          />
          <input
            placeholder="Subject"
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm"
            value={msgForm.subject}
            onChange={(e) => setMsgForm((p) => ({ ...p, subject: e.target.value }))}
          />
          <textarea
            placeholder="Message (placeholders supported)"
            rows={4}
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm font-mono"
            value={msgForm.body}
            onChange={(e) => setMsgForm((p) => ({ ...p, body: e.target.value }))}
          />
          <Button size="sm" onClick={() => void saveNewMessage()} isLoading={msgSaving}>
            Save message on campaign
          </Button>
        </div>
      )}

      {/* Advanced options — kept out of the way, same controls as a single follow-up job. */}
      <div className="border-t border-gray-100 pt-4">
        <button
          type="button"
          className="text-sm font-medium text-gray-700 hover:text-gray-900"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          {advancedOpen ? 'Hide advanced options' : 'Advanced options'}
        </button>

        {advancedOpen && (
          <div className="mt-3 space-y-5">
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-2">Audience</span>
              <div className="flex flex-wrap gap-4 text-sm">
                {(['sent', 'opened', 'delivered'] as const).map((v) => (
                  <label key={v} className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="seq-engagement"
                      checked={engagement === v}
                      onChange={() => setEngagement(v)}
                    />
                    <span className="capitalize">{v}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Applies to every step. <strong>Opened</strong> / <strong>delivered</strong> narrow the list using
                tracking columns on recipients.
              </p>
            </div>

            <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-4 space-y-3">
              <p className="text-sm font-medium text-gray-800">How long each job may send (optional)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Max run duration</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    placeholder="e.g. 2 — leave empty for no limit"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    value={maxRunDurationStr}
                    onChange={(e) => setMaxRunDurationStr(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                  <select
                    value={maxRunDurationUnit}
                    onChange={(e) => setMaxRunDurationUnit(e.target.value as 'minutes' | 'hours')}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setSendWeekdaysEnabled((v) => {
                    const next = !v;
                    if (next) setSelectedSendWeekdays((s) => (s.length === 0 ? [1, 2, 3, 4, 5] : s));
                    return next;
                  });
                }}
                className={`toggle-switch ${sendWeekdaysEnabled ? 'active' : ''}`}
                role="switch"
                id="fu-seq-switch-1"
                aria-checked={sendWeekdaysEnabled}
              />
              <label htmlFor="fu-seq-switch-1" className="cursor-pointer text-sm font-medium text-gray-700">
                Only send on selected weekdays
              </label>
            </div>
            {sendWeekdaysEnabled && (
              <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-4 space-y-2">
                <div className="flex flex-wrap gap-2">
                  {ISO_WEEKDAY_OPTIONS.map(({ iso, short }) => {
                    const on = selectedSendWeekdays.includes(iso);
                    return (
                      <button
                        key={iso}
                        type="button"
                        onClick={() => toggleSendWeekday(iso)}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          on
                            ? 'bg-gray-900 text-white border-gray-900'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {short}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Button
        className="w-full sm:w-auto"
        onClick={() => void submit()}
        isLoading={submitting}
        disabled={templates.length === 0}
      >
        Schedule {steps.length} follow-up{steps.length === 1 ? '' : 's'}
      </Button>
    </div>
  );
}
