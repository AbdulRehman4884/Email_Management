import React, { useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import { Input } from './ui';
import { ISO_WEEKDAY_OPTIONS } from '../lib/isoWeekdays';
import { estimateScheduleFinish } from '../lib/scheduleFinishEstimate';
import { localScheduleStringToDate } from '../lib/localScheduleFormat';

/**
 * ScheduleBuilder — the friendly replacement for the old stack of scheduling toggles.
 *
 * It is a controlled component over the parent's existing scheduling state (one flag per
 * option), so validation, draft persistence and the submit payload in CreateCampaign /
 * EditCampaign keep working unchanged. There is NO backend change: every choice still maps to
 * the same fields (scheduledAt, dailySendLimit, dailySendWindowStart/End, sendWeekdays,
 * pauseAt / autoPauseAfterMinutes).
 *
 * The UX is: two one-tap presets + a live "what will happen" preview, with the five detailed
 * settings tucked behind one "Customize schedule" expander (opened in a single tap — and every
 * option inside is a visible button, so there is no per-setting "click a word to reveal choices").
 */

export interface ScheduleBuilderValue {
  /** true = start at a specific time; false = start as soon as sending begins. */
  scheduleEnabled: boolean;
  scheduledAt: string | null;
  dailyCapEnabled: boolean;
  campaignDailyCapStr: string;
  sendWindowEnabled: boolean;
  sendWindowStart: string;
  sendWindowEnd: string;
  sendWeekdaysEnabled: boolean;
  selectedSendWeekdays: number[];
  pauseEnabled: boolean;
  pauseScheduleMode: 'datetime' | 'duration';
  pauseAt: string | null;
  pauseDurationStr: string;
  pauseDurationUnit: 'minutes' | 'hours';
}

export interface ScheduleBuilderProps {
  value: ScheduleBuilderValue;
  onChange: (patch: Partial<ScheduleBuilderValue>) => void;
  /** Recipients still to email (drives the finish-date estimate). */
  recipientCount?: number;
  /** Combined remaining daily capacity across selected accounts; null = unlimited/unknown. */
  dailyCapacity?: number | null;
  /** Hint text for the per-day editor (e.g. remaining quota across selected accounts). */
  capacityHint?: string;
  errors?: Partial<Record<string, string>>;
  /** 'create' | 'edit' — only affects copy; behaviour is identical. */
  mode?: 'create' | 'edit';
  idPrefix?: string;
  /** Show every option from the start (the chat's schedule box). */
  defaultOpen?: boolean;
}

const STEADY_DAYS = [1, 2, 3, 4, 5];

function toDatetimeLocalValue(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  return String(dateStr).replace(' ', 'T').slice(0, 16);
}

function sameDays(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

function detectPreset(v: ScheduleBuilderValue): 'now' | 'drip' | 'custom' {
  const nothingElse = !v.scheduleEnabled && !v.dailyCapEnabled && !v.pauseEnabled;
  if (nothingElse && !v.sendWindowEnabled && !v.sendWeekdaysEnabled) return 'now';
  if (
    nothingElse &&
    v.sendWindowEnabled &&
    v.sendWindowStart === '09:00' &&
    v.sendWindowEnd === '17:00' &&
    v.sendWeekdaysEnabled &&
    sameDays(v.selectedSendWeekdays, STEADY_DAYS)
  ) {
    return 'drip';
  }
  return 'custom';
}

export function ScheduleBuilder({
  value,
  onChange,
  recipientCount = 0,
  dailyCapacity = null,
  capacityHint,
  errors = {},
  mode = 'create',
  idPrefix = 'sched',
  defaultOpen = false,
}: ScheduleBuilderProps) {
  const activePreset = detectPreset(value);
  const [customOpen, setCustomOpen] = useState<boolean>(() => defaultOpen || activePreset === 'custom');
  // Custom settings must stay visible (hiding them would lose sight of a non-preset schedule).
  const detailsOpen = customOpen || activePreset === 'custom';

  const applyPreset = (preset: 'now' | 'drip') => {
    if (preset === 'now') {
      onChange({
        scheduleEnabled: false,
        scheduledAt: null,
        dailyCapEnabled: false,
        campaignDailyCapStr: '',
        sendWindowEnabled: false,
        sendWeekdaysEnabled: false,
        pauseEnabled: false,
      });
    } else {
      onChange({
        scheduleEnabled: false,
        scheduledAt: null,
        dailyCapEnabled: false,
        campaignDailyCapStr: '',
        sendWindowEnabled: true,
        sendWindowStart: '09:00',
        sendWindowEnd: '17:00',
        sendWeekdaysEnabled: true,
        selectedSendWeekdays: STEADY_DAYS,
        pauseEnabled: false,
      });
    }
  };

  const capNum = Number(value.campaignDailyCapStr);

  // ── preview ────────────────────────────────────────────────────────────────
  const perDay = value.dailyCapEnabled && Number.isFinite(capNum) && capNum > 0 ? capNum : dailyCapacity;
  const estimate = estimateScheduleFinish({
    recipientCount,
    perDay: perDay ?? null,
    sendWeekdays: value.sendWeekdaysEnabled ? value.selectedSendWeekdays : null,
    start: value.scheduleEnabled && value.scheduledAt ? localScheduleStringToDate(value.scheduledAt) : null,
  });

  // ── small building blocks ────────────────────────────────────────────────────
  const presetButton = (key: 'now' | 'drip', label: string) => (
    <button
      type="button"
      onClick={() => applyPreset(key)}
      aria-pressed={activePreset === key}
      className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
        activePreset === key ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-500 hover:text-gray-800'
      }`}
    >
      {label}
    </button>
  );

  /** One choice in a segmented control. */
  const seg = (active: boolean, onSelect: () => void, label: string) => (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
        active
          ? 'bg-gray-900 text-white border-gray-900'
          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
      }`}
    >
      {label}
    </button>
  );

  /** One setting line inside the panel: a title + its segmented choices, detail below. */
  const Row = ({
    title,
    choices,
    children,
  }: {
    title: string;
    choices: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div className="py-3 first:pt-0 last:pb-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-700">{title}</p>
        <div className="flex flex-wrap gap-1.5">{choices}</div>
      </div>
      {children}
    </div>
  );

  const toggleWeekday = (iso: number) => {
    const has = value.selectedSendWeekdays.includes(iso);
    const next = has
      ? value.selectedSendWeekdays.filter((d) => d !== iso)
      : [...value.selectedSendWeekdays, iso].sort((a, b) => a - b);
    onChange({ sendWeekdaysEnabled: next.length > 0, selectedSendWeekdays: next });
  };

  const daysIsEvery = !value.sendWeekdaysEnabled;
  const daysIsWeekdays = value.sendWeekdaysEnabled && sameDays(value.selectedSendWeekdays, STEADY_DAYS);
  const daysIsWeekends = value.sendWeekdaysEnabled && sameDays(value.selectedSendWeekdays, [6, 7]);
  const daysIsCustom = value.sendWeekdaysEnabled && !daysIsWeekdays && !daysIsWeekends;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">When should this send?</h3>
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-100 p-1">
          {presetButton('now', 'Send now')}
          {presetButton('drip', 'Steady drip')}
        </div>
      </div>

      {/* Live "what will happen" preview — always visible, even when details are collapsed. */}
      <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
        <Calendar className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" aria-hidden />
        <p className="text-sm text-blue-900">
          <span className="font-medium">What&apos;ll happen: </span>
          {estimate.summary}
          {mode === 'edit' ? ' (from now)' : ''}
        </p>
      </div>

      {/* One tap opens every detailed setting at once (no per-setting reveal). */}
      <button
        type="button"
        onClick={() => setCustomOpen((v) => !v)}
        aria-expanded={detailsOpen}
        className="flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900"
      >
        <ChevronDown className={`w-4 h-4 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} aria-hidden />
        {detailsOpen ? 'Hide options' : 'Customize schedule'}
      </button>

      {detailsOpen && (
      <div className="rounded-lg border border-gray-200 px-3 divide-y divide-gray-100">
      {/* 1 ── Start */}
      <Row
        title="Start sending"
        choices={
          <>
            {seg(!value.scheduleEnabled, () => onChange({ scheduleEnabled: false, scheduledAt: null }), 'Right away')}
            {seg(value.scheduleEnabled, () => onChange({ scheduleEnabled: true }), 'At a set time')}
          </>
        }
      >
        {value.scheduleEnabled && (
          <Input
            label="Start date & time"
            type="datetime-local"
            value={toDatetimeLocalValue(value.scheduledAt)}
            onClick={(e) => e.currentTarget.showPicker?.()}
            onChange={(e) => onChange({ scheduledAt: e.target.value || null })}
            error={errors.scheduledAt}
            required
          />
        )}
      </Row>

      {/* 2 ── Rate */}
      <Row
        title="Sending speed"
        choices={
          <>
            {seg(!value.dailyCapEnabled, () => onChange({ dailyCapEnabled: false, campaignDailyCapStr: '' }), 'As fast as possible')}
            {seg(value.dailyCapEnabled, () => onChange({ dailyCapEnabled: true }), 'Limit per day')}
          </>
        }
      >
        {value.dailyCapEnabled && (
          <Input
            label="Max emails per day"
            type="number"
            min={1}
            value={value.campaignDailyCapStr}
            onChange={(e) => onChange({ campaignDailyCapStr: e.target.value })}
            error={errors.dailySendCap}
            helperText={capacityHint}
          />
        )}
      </Row>

      {/* 3 ── Days */}
      <Row
        title="Which days"
        choices={
          <>
            {seg(daysIsEvery, () => onChange({ sendWeekdaysEnabled: false }), 'Every day')}
            {seg(daysIsWeekdays, () => onChange({ sendWeekdaysEnabled: true, selectedSendWeekdays: STEADY_DAYS }), 'Weekdays')}
            {seg(daysIsWeekends, () => onChange({ sendWeekdaysEnabled: true, selectedSendWeekdays: [6, 7] }), 'Weekends')}
            {seg(
              daysIsCustom,
              () =>
                onChange({
                  sendWeekdaysEnabled: true,
                  selectedSendWeekdays: value.sendWeekdaysEnabled ? value.selectedSendWeekdays : STEADY_DAYS,
                }),
              'Custom',
            )}
          </>
        }
      >
        {value.sendWeekdaysEnabled && (
          <>
            <div className="flex flex-wrap gap-2">
              {ISO_WEEKDAY_OPTIONS.map(({ iso, short }) => {
                const on = value.selectedSendWeekdays.includes(iso);
                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => toggleWeekday(iso)}
                    aria-pressed={on}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      on ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {short}
                  </button>
                );
              })}
            </div>
            {errors.sendWeekdays && <p className="text-sm text-red-500" role="alert">{errors.sendWeekdays}</p>}
            <p className="text-xs text-gray-500">On skipped days the campaign pauses and resumes on the next allowed day.</p>
          </>
        )}
      </Row>

      {/* 4 ── Time of day */}
      <Row
        title="Time of day"
        choices={
          <>
            {seg(!value.sendWindowEnabled, () => onChange({ sendWindowEnabled: false }), 'Any time')}
            {seg(value.sendWindowEnabled, () => onChange({ sendWindowEnabled: true }), 'Set hours')}
          </>
        }
      >
        {value.sendWindowEnabled && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="From" type="time" value={value.sendWindowStart} onChange={(e) => onChange({ sendWindowStart: e.target.value })} />
            <Input
              label="To"
              type="time"
              value={value.sendWindowEnd}
              onChange={(e) => onChange({ sendWindowEnd: e.target.value })}
              helperText="End can be earlier than start (crosses midnight)."
              error={errors.sendWindow}
            />
          </div>
        )}
      </Row>

      {/* 5 ── End */}
      <Row
        title="Keep going until"
        choices={
          <>
            {seg(!value.pauseEnabled, () => onChange({ pauseEnabled: false }), "Everyone's emailed")}
            {seg(value.pauseEnabled && value.pauseScheduleMode === 'datetime', () => onChange({ pauseEnabled: true, pauseScheduleMode: 'datetime' }), 'Stop at a time')}
            {seg(value.pauseEnabled && value.pauseScheduleMode === 'duration', () => onChange({ pauseEnabled: true, pauseScheduleMode: 'duration' }), 'Stop after a while')}
          </>
        }
      >
        {value.pauseEnabled && value.pauseScheduleMode === 'datetime' && (
          <Input
            label="Stop at"
            type="datetime-local"
            value={toDatetimeLocalValue(value.pauseAt)}
            onClick={(e) => e.currentTarget.showPicker?.()}
            onChange={(e) => onChange({ pauseAt: e.target.value || null })}
            error={errors.pauseAt}
            required
          />
        )}
        {value.pauseEnabled && value.pauseScheduleMode === 'duration' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <Input
              label="Run for"
              type="number"
              min={1}
              step={1}
              value={value.pauseDurationStr}
              onChange={(e) => onChange({ pauseDurationStr: e.target.value })}
              error={errors.pauseDuration}
              placeholder="e.g. 2"
              required
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Unit</label>
              <select
                value={value.pauseDurationUnit}
                onChange={(e) => onChange({ pauseDurationUnit: e.target.value as 'minutes' | 'hours' })}
                className="w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-4 py-2.5 focus:ring-2 focus:ring-gray-400 focus:outline-none"
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </select>
            </div>
            <p className="sm:col-span-2 text-xs text-gray-500">
              After pausing it resumes automatically and repeats until everyone is sent (or you pause manually).
            </p>
          </div>
        )}
      </Row>
      </div>
      )}
    </div>
  );
}
