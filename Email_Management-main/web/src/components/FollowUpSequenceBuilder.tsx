import React, { useMemo, useState } from 'react';
import { CalendarDays, GitBranch, Plus, Trash2 } from 'lucide-react';
import { campaignApi, followUpApi } from '../lib/api';
import type { Campaign, FollowUpEngagement, FollowUpTemplate } from '../types';
import { Button, useToast } from './ui';
import { ISO_WEEKDAY_OPTIONS, formatIsoWeekdaysList, nextAllowedSendDayLabel } from '../lib/isoWeekdays';
import { FOLLOW_UP_AUDIENCE_OPTIONS, followUpAudienceLabel } from '../lib/followUpAudience';

/** Keep in sync with MAX_FOLLOW_UP_SEQUENCE_STEPS on the backend. */
const MAX_STEPS = 5;

interface SequenceStep {
  offsetDays: number;
  templateId: string;
  /** Audience for this step. Only used when behavior-based branching is on; otherwise the one global audience applies. */
  engagement: FollowUpEngagement;
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
    { offsetDays: 2, templateId: templates[0]?.id ?? '', engagement: 'sent' },
  ]);
  const [engagement, setEngagement] = useState<FollowUpEngagement>('sent');
  // Behavior-based branching: when on, each step targets its own audience (e.g. opened vs. not opened),
  // so one lead's actions route them down a different path than another's.
  const [branchingEnabled, setBranchingEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxRunDurationStr, setMaxRunDurationStr] = useState('');
  const [maxRunDurationUnit, setMaxRunDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const [sendWeekdaysEnabled, setSendWeekdaysEnabled] = useState(false);
  const [selectedSendWeekdays, setSelectedSendWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [sendWindowEnabled, setSendWindowEnabled] = useState(false);
  const [windowStartStr, setWindowStartStr] = useState('09:00');
  const [windowEndStr, setWindowEndStr] = useState('17:00');

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

  // Plain-language reassurance for the sending-days section (e.g. the "no Sunday follow-ups" case).
  const weekdayPreview = useMemo(() => {
    if (!sendWeekdaysEnabled) return 'Follow-ups can go out on any day of the week.';
    if (selectedSendWeekdays.length === 0) return 'Pick at least one day, or turn this off.';
    const blocked = ISO_WEEKDAY_OPTIONS.filter((o) => !selectedSendWeekdays.includes(o.iso)).map((o) => o.short);
    if (blocked.length === 0) return 'Follow-ups can go out on any day of the week.';
    const nextDay = nextAllowedSendDayLabel(selectedSendWeekdays);
    return `Follow-ups only go out on ${formatIsoWeekdaysList(selectedSendWeekdays)}. One that comes due on ${blocked.join(', ')} waits until the next allowed day${nextDay ? ` (next: ${nextDay})` : ''}.`;
  }, [sendWeekdaysEnabled, selectedSendWeekdays]);

  const windowPreview = useMemo(() => {
    if (!sendWindowEnabled) return 'Follow-ups can go out at any time of day.';
    if (!windowStartStr || !windowEndStr) return 'Set both a start and end time, or turn this off.';
    if (windowStartStr === windowEndStr) return 'Start and end time cannot be the same.';
    const crossesMidnight = windowEndStr < windowStartStr;
    return `Follow-ups only send between ${windowStartStr} and ${windowEndStr}${
      crossesMidnight ? ' (overnight, crossing midnight)' : ''
    }. One that comes due outside this window waits until it opens again.`;
  }, [sendWindowEnabled, windowStartStr, windowEndStr]);

  const updateStep = (index: number, patch: Partial<SequenceStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addStep = () => {
    setSteps((prev) => {
      if (prev.length >= MAX_STEPS) return prev;
      // Default the next message to one that isn't used yet, else the first.
      const used = new Set(prev.map((s) => s.templateId));
      const nextTpl = templates.find((t) => !used.has(t.id)) ?? templates[0];
      return [...prev, { offsetDays: 3, templateId: nextTpl?.id ?? '', engagement: 'sent' }];
    });
  };

  /**
   * Fill a ready-made behavior-based branch: a first nudge to everyone, a gentle reminder to the
   * people who opened but didn't reply, and a final "break-up" email to the ones who never opened.
   * The user still picks which message each step sends.
   */
  const applyBranchingPreset = () => {
    const pick = (i: number) => templates[i]?.id ?? templates[0]?.id ?? '';
    setBranchingEnabled(true);
    setSteps([
      { offsetDays: 2, templateId: pick(0), engagement: 'sent' },
      { offsetDays: 3, templateId: pick(1), engagement: 'opened' },
      { offsetDays: 3, templateId: pick(2), engagement: 'not_opened' },
    ]);
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
    if (sendWindowEnabled) {
      if (!windowStartStr || !windowEndStr) {
        toast.error('Set both a start and end time, or turn off the time window.');
        return;
      }
      if (windowStartStr === windowEndStr) {
        toast.error('The time window start and end cannot be the same.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const { jobs } = await followUpApi.createSequence({
        campaignId: campaign.id,
        steps: steps.map((s) => ({
          offsetDays: Math.floor(s.offsetDays),
          templateId: s.templateId,
          // Only send a per-step audience when branching is on; otherwise every step uses the one global audience.
          ...(branchingEnabled ? { engagement: s.engagement } : {}),
        })),
        engagement,
        ...(maxRunMinutes != null ? { maxRunMinutes } : {}),
        ...(sendWeekdaysEnabled ? { sendWeekdays: selectedSendWeekdays } : {}),
        ...(sendWindowEnabled
          ? { dailySendWindowStart: windowStartStr, dailySendWindowEnd: windowEndStr }
          : {}),
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

      {/* Behavior-based branching: route each step by what the lead did (opened / ignored). */}
      <div className="rounded-lg border border-gray-200 p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <GitBranch className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-gray-800">Branch by behavior</p>
              <p className="text-xs text-gray-500">
                Send a different message depending on what each lead did — e.g. a reminder to those who opened but
                didn't reply, and a final email to those who never opened.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setBranchingEnabled((v) => !v)}
            className={`toggle-switch ${branchingEnabled ? 'active' : ''}`}
            role="switch"
            id="fu-seq-branching"
            aria-checked={branchingEnabled}
            aria-label="Branch follow-ups by behavior"
          />
        </div>
        {branchingEnabled && templates.length > 0 && (
          <button
            type="button"
            onClick={applyBranchingPreset}
            className="text-xs font-medium text-blue-700 hover:text-blue-900"
          >
            Use a ready-made branch (nudge → reminder for openers → break-up for non-openers)
          </button>
        )}
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

              {branchingEnabled && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Send this step to</label>
                  <select
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-gray-900/15"
                    value={step.engagement}
                    onChange={(e) => updateStep(i, { engagement: e.target.value as FollowUpEngagement })}
                  >
                    {FOLLOW_UP_AUDIENCE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <p className="text-xs text-gray-500">
                Sends about <strong>{cumulativeDays[i]}</strong> day{cumulativeDays[i] === 1 ? '' : 's'} from now
                {branchingEnabled ? (
                  <> · to <span className="text-gray-700">{followUpAudienceLabel(step.engagement)}</span></>
                ) : null}
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

      {/* Sending days & times — surfaced here (not under Advanced) so "no follow-ups on Sunday"
          and "only during work hours" are easy to set. */}
      <div className="rounded-lg border border-gray-200 p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <CalendarDays className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-gray-800">Sending days</p>
              <p className="text-xs text-gray-500">
                Choose which weekdays follow-ups may go out. A follow-up that comes due on a skipped day waits
                until the next allowed day — it is never sent on a day you turned off.
              </p>
            </div>
          </div>
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
            aria-label="Only send follow-ups on selected weekdays"
          />
        </div>
        {sendWeekdaysEnabled && (
          <div className="flex flex-wrap gap-2">
            {ISO_WEEKDAY_OPTIONS.map(({ iso, short }) => {
              const on = selectedSendWeekdays.includes(iso);
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => toggleSendWeekday(iso)}
                  aria-pressed={on}
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
        )}
        <p className="text-xs text-gray-600">{weekdayPreview}</p>

        {/* Daily time window — same From–To window the campaign scheduler offers. */}
        <div className="border-t border-gray-100 pt-3 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-800">Only during these hours</p>
              <p className="text-xs text-gray-500">
                Restrict follow-ups to a daily time window. One that comes due outside the window waits
                until it opens again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSendWindowEnabled((v) => !v)}
              className={`toggle-switch ${sendWindowEnabled ? 'active' : ''}`}
              role="switch"
              id="fu-seq-switch-2"
              aria-checked={sendWindowEnabled}
              aria-label="Only send follow-ups during a daily time window"
            />
          </div>
          {sendWindowEnabled && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-gray-600">
                From
                <input
                  type="time"
                  value={windowStartStr}
                  onChange={(e) => setWindowStartStr(e.target.value)}
                  className="ml-1.5 rounded-lg border border-gray-200 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-gray-600">
                To
                <input
                  type="time"
                  value={windowEndStr}
                  onChange={(e) => setWindowEndStr(e.target.value)}
                  className="ml-1.5 rounded-lg border border-gray-200 px-2 py-1 text-sm"
                />
              </label>
            </div>
          )}
          <p className="text-xs text-gray-600">{windowPreview}</p>
        </div>
      </div>

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
              {branchingEnabled ? (
                <p className="text-xs text-gray-500">
                  Branch by behavior is on, so each step above sends to its own audience. Turn it off to use one
                  audience for the whole sequence.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-4 text-sm">
                    {FOLLOW_UP_AUDIENCE_OPTIONS.map((o) => (
                      <label key={o.value} className="inline-flex items-center gap-2 cursor-pointer" title={o.hint}>
                        <input
                          type="radio"
                          name="seq-engagement"
                          checked={engagement === o.value}
                          onChange={() => setEngagement(o.value)}
                        />
                        <span>{o.label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Applies to every step. Same choices as the Inbox filter — e.g. <strong>Not opened yet</strong> only
                    follows up with people who have not opened your email.
                  </p>
                </>
              )}
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
