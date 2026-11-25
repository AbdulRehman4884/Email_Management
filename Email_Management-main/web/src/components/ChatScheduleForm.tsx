/**
 * The agent's schedule question as a box in the chat: the same choices as the campaign wizard's
 * "When should this send?" (ScheduleBuilder). Confirm sends them to the agent, which saves them on
 * the draft and then asks to start the campaign.
 */

import React, { useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Button } from './ui';
import { ScheduleBuilder, type ScheduleBuilderValue } from './ScheduleBuilder';
import { userApi } from '../lib/api';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../lib/smtpLimits';
import { formatIsoWeekdaysList } from '../lib/isoWeekdays';
import type { ScheduleChoice, ScheduleFormRequest } from '../lib/agentMessage';

export const INITIAL_SCHEDULE: ScheduleBuilderValue = {
  scheduleEnabled: false,
  scheduledAt: null,
  dailyCapEnabled: false,
  campaignDailyCapStr: '',
  sendWindowEnabled: false,
  sendWindowStart: '09:00',
  sendWindowEnd: '17:00',
  sendWeekdaysEnabled: false,
  selectedSendWeekdays: [1, 2, 3, 4, 5],
  pauseEnabled: false,
  pauseScheduleMode: 'datetime',
  pauseAt: null,
  pauseDurationStr: '',
  pauseDurationUnit: 'hours',
};

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function localTime(v: string | null): { value: string; ms: number } | null {
  const value = (v ?? '').replace(' ', 'T').slice(0, 16);
  if (!LOCAL_RE.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? { value, ms } : null;
}

/** The wizard's checks, then the choice the agent gets. */
export function scheduleChoiceFrom(
  v: ScheduleBuilderValue,
  now = Date.now(),
): { ok: true; choice: ScheduleChoice } | { ok: false; errors: Partial<Record<string, string>> } {
  const errors: Partial<Record<string, string>> = {};
  const start = v.scheduleEnabled ? localTime(v.scheduledAt) : null;
  if (v.scheduleEnabled) {
    if (!v.scheduledAt) errors.scheduledAt = 'Pick the start date and time.';
    else if (!start) errors.scheduledAt = 'Invalid date and time.';
    else if (start.ms <= now + 60_000) errors.scheduledAt = 'The start time must be in the future.';
  }
  let dailyLimit: number | null = null;
  if (v.dailyCapEnabled) {
    const n = Number(v.campaignDailyCapStr);
    if (!v.campaignDailyCapStr.trim() || !Number.isInteger(n) || n < 1) errors.dailySendCap = 'Enter a whole number of at least 1.';
    else dailyLimit = n;
  }
  if (v.sendWeekdaysEnabled && v.selectedSendWeekdays.length === 0) errors.sendWeekdays = 'Pick at least one day.';
  if (v.sendWindowEnabled && v.sendWindowStart === v.sendWindowEnd) errors.sendWindow = 'Start and end time cannot be the same.';
  let stopAt: string | null = null;
  let stopAfterMinutes: number | null = null;
  if (v.pauseEnabled && v.pauseScheduleMode === 'datetime') {
    const stop = localTime(v.pauseAt);
    if (!v.pauseAt) errors.pauseAt = 'Pick the stop date and time.';
    else if (!stop) errors.pauseAt = 'Invalid date and time.';
    else if (stop.ms <= now) errors.pauseAt = 'The stop time must be in the future.';
    else if (start && stop.ms <= start.ms) errors.pauseAt = 'The stop time must be after the start time.';
    else stopAt = stop.value;
  }
  if (v.pauseEnabled && v.pauseScheduleMode === 'duration') {
    const n = Number(v.pauseDurationStr.trim());
    const mins = Math.floor(n * (v.pauseDurationUnit === 'hours' ? 60 : 1));
    if (!v.pauseDurationStr.trim() || !Number.isFinite(n) || n <= 0 || mins < 1) errors.pauseDuration = 'Enter a positive number.';
    else if (mins > 10080) errors.pauseDuration = 'Maximum is 7 days (10080 minutes).';
    else stopAfterMinutes = mins;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    choice: {
      startAt: start?.value ?? null,
      dailyLimit,
      weekdays: v.sendWeekdaysEnabled ? [...v.selectedSendWeekdays].sort((a, b) => a - b) : null,
      windowStart: v.sendWindowEnabled ? v.sendWindowStart.slice(0, 5) : null,
      windowEnd: v.sendWindowEnabled ? v.sendWindowEnd.slice(0, 5) : null,
      stopAt,
      stopAfterMinutes,
    },
  };
}

/** The user's chat bubble for a confirmed schedule. */
export function scheduleChoiceText(c: ScheduleChoice): string {
  const minutes = c.stopAfterMinutes ?? 0;
  return [
    `Schedule: start ${c.startAt ? c.startAt.replace('T', ' ') : 'right away'}`,
    c.dailyLimit ? `up to ${c.dailyLimit} emails/day` : 'as fast as possible',
    c.weekdays ? formatIsoWeekdaysList(c.weekdays) : 'every day',
    c.windowStart && c.windowEnd ? `${c.windowStart}–${c.windowEnd}` : 'any time',
    c.stopAt
      ? `stop at ${c.stopAt.replace('T', ' ')}`
      : c.stopAfterMinutes
        ? `pause after ${minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`}, then repeat`
        : "until everyone's emailed",
  ].join(' · ');
}

export function ChatScheduleForm({
  form,
  disabled,
  onSubmit,
}: {
  form: ScheduleFormRequest;
  disabled?: boolean;
  onSubmit: (choice: ScheduleChoice, text: string) => void;
}) {
  const [value, setValue] = useState<ScheduleBuilderValue>(INITIAL_SCHEDULE);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [quota, setQuota] = useState<{ fromEmail: string; remaining: number | null; dailyLimit: number } | null>(null);

  useEffect(() => {
    let alive = true;
    userApi
      .getSmtpQuota()
      .then(({ profiles }) => {
        const p = profiles.find((x) => x.smtpSettingsId === form.smtpSettingsId) ?? (form.smtpSettingsId ? undefined : profiles[0]);
        if (alive && p) setQuota({ fromEmail: p.fromEmail, remaining: p.remaining, dailyLimit: p.dailyLimit });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [form.smtpSettingsId]);

  const change = (patch: Partial<ScheduleBuilderValue>) => {
    setValue((prev) => ({ ...prev, ...patch }));
    setErrors({});
  };

  const confirm = () => {
    const r = scheduleChoiceFrom(value);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    onSubmit(r.choice, scheduleChoiceText(r.choice));
  };

  const capacityHint = quota
    ? `${quota.fromEmail}${quota.remaining !== null ? ` has ${quota.remaining} emails left today` : ''}. Up to ${SMTP_DAILY_EMAIL_LIMIT_MAX}/day per account.`
    : `Up to ${SMTP_DAILY_EMAIL_LIMIT_MAX} emails/day per account.`;

  return (
    <div data-testid="chat-schedule-form" className="mt-2 w-full rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <fieldset disabled={disabled} className="space-y-4">
        <ScheduleBuilder
          value={value}
          onChange={change}
          recipientCount={form.recipientCount}
          dailyCapacity={quota?.dailyLimit && quota.dailyLimit > 0 ? quota.dailyLimit : SMTP_DAILY_EMAIL_LIMIT_MAX}
          capacityHint={capacityHint}
          errors={errors}
          idPrefix="chat-sched"
          defaultOpen
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={confirm} data-testid="confirm-schedule">
            <CalendarCheck className="mr-1.5 h-4 w-4" aria-hidden />
            Confirm schedule
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
