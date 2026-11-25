import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({
  userApi: {
    getSmtpQuota: vi.fn().mockResolvedValue({ profiles: [{ smtpSettingsId: 5, fromEmail: 'me@x.io', dailyLimit: 20, sentToday: 3, remaining: 17 }] }),
  },
}));

import { ChatScheduleForm, INITIAL_SCHEDULE, scheduleChoiceFrom, scheduleChoiceText } from '../ChatScheduleForm';

const NOW = new Date('2026-11-25T10:00').getTime();

describe('ChatScheduleForm', () => {
  it('the wizard rules: future start, stop after start, a valid run time, different hours', () => {
    const bad = scheduleChoiceFrom(
      {
        ...INITIAL_SCHEDULE,
        scheduleEnabled: true,
        scheduledAt: '2026-11-25T09:00',
        sendWindowEnabled: true,
        sendWindowStart: '09:00',
        sendWindowEnd: '09:00',
        dailyCapEnabled: true,
        campaignDailyCapStr: '0',
      },
      NOW,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['dailySendCap', 'scheduledAt', 'sendWindow']);

    const stopBeforeStart = scheduleChoiceFrom(
      { ...INITIAL_SCHEDULE, scheduleEnabled: true, scheduledAt: '2026-11-26T10:00', pauseEnabled: true, pauseAt: '2026-11-26T09:00' },
      NOW,
    );
    expect(stopBeforeStart.ok).toBe(false);
    expect(scheduleChoiceFrom({ ...INITIAL_SCHEDULE, pauseEnabled: true, pauseScheduleMode: 'duration', pauseDurationStr: '200' }, NOW).ok).toBe(false);
  });

  it('every choice becomes the field the agent saves; the bubble text says it in one line', () => {
    const r = scheduleChoiceFrom(
      {
        ...INITIAL_SCHEDULE,
        scheduleEnabled: true,
        scheduledAt: '2026-11-26T10:00',
        dailyCapEnabled: true,
        campaignDailyCapStr: '15',
        sendWeekdaysEnabled: true,
        selectedSendWeekdays: [5, 1, 3],
        sendWindowEnabled: true,
        pauseEnabled: true,
        pauseScheduleMode: 'duration',
        pauseDurationStr: '2',
      },
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      choice: { startAt: '2026-11-26T10:00', dailyLimit: 15, weekdays: [1, 3, 5], windowStart: '09:00', windowEnd: '17:00', stopAt: null, stopAfterMinutes: 120 },
    });
    if (r.ok) {
      expect(scheduleChoiceText(r.choice)).toBe(
        'Schedule: start 2026-11-26 10:00 · up to 15 emails/day · Mon, Wed, Fri · 09:00–17:00 · pause after 2 h, then repeat',
      );
    }
  });

  it('shows every option at once; Confirm sends the choice; the account quota is the per-day hint', async () => {
    const onSubmit = vi.fn();
    render(<ChatScheduleForm form={{ kind: 'schedule', recipientCount: 2, smtpSettingsId: 5 }} onSubmit={onSubmit} />);
    expect(screen.getByText('Start sending')).toBeInTheDocument();
    expect(screen.getByText('Keep going until')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Limit per day' }));
    expect(await screen.findByText(/me@x\.io has 17 emails left today/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Max emails per day'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weekends' }));
    fireEvent.click(screen.getByTestId('confirm-schedule'));

    expect(onSubmit).toHaveBeenCalledWith(
      { startAt: null, dailyLimit: 10, weekdays: [6, 7], windowStart: null, windowEnd: null, stopAt: null, stopAfterMinutes: null },
      "Schedule: start right away · up to 10 emails/day · Sat, Sun · any time · until everyone's emailed",
    );
  });
});
