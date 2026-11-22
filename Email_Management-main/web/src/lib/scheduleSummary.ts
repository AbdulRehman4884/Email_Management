import { formatLocalScheduleDisplay } from './localScheduleFormat';
import { formatIsoWeekdaysList } from './isoWeekdays';

/** Everything the scheduling section can set, so we can describe it back in one plain sentence. */
export interface CampaignScheduleSummaryInput {
  scheduleEnabled: boolean;
  scheduledAt: string | null;
  dailyCapEnabled: boolean;
  dailyCap: number | null;
  sendWindowEnabled: boolean;
  sendWindowStart: string;
  sendWindowEnd: string;
  pauseEnabled: boolean;
  pauseMode: 'datetime' | 'duration';
  pauseAt: string | null;
  pauseDuration: number | null;
  pauseDurationUnit: 'minutes' | 'hours';
  sendWeekdaysEnabled: boolean;
  sendWeekdays: number[];
}

function weekdaysPhrase(days: number[]): string {
  const sorted = [...days].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const key = sorted.join(',');
  if (key === '1,2,3,4,5') return 'on weekdays only (Mon–Fri)';
  if (key === '6,7') return 'on weekends only (Sat–Sun)';
  return `only on ${formatIsoWeekdaysList(sorted)}`;
}

/**
 * Plain-language pieces describing what the schedule settings will actually do, in reading order.
 * The scheduling UI shows these joined together so a non-technical user can confirm at a glance.
 */
export function describeCampaignSchedule(input: CampaignScheduleSummaryInput): string[] {
  const parts: string[] = [];

  if (input.scheduleEnabled && input.scheduledAt) {
    parts.push(`Starts on ${formatLocalScheduleDisplay(input.scheduledAt)}`);
  } else if (input.scheduleEnabled) {
    parts.push('Starts at the date & time you pick above');
  } else {
    parts.push('Starts as soon as you press Start');
  }

  if (input.dailyCapEnabled && input.dailyCap && input.dailyCap > 0) {
    parts.push(`sends up to ${input.dailyCap.toLocaleString()} emails per day`);
  }

  if (input.sendWindowEnabled && input.sendWindowStart && input.sendWindowEnd) {
    parts.push(`only between ${input.sendWindowStart} and ${input.sendWindowEnd}`);
  }

  if (input.sendWeekdaysEnabled) {
    const w = weekdaysPhrase(input.sendWeekdays);
    if (w) parts.push(w);
  }

  if (input.pauseEnabled) {
    if (input.pauseMode === 'datetime' && input.pauseAt) {
      parts.push(`auto-pauses on ${formatLocalScheduleDisplay(input.pauseAt)}`);
    } else if (input.pauseMode === 'duration' && input.pauseDuration && input.pauseDuration > 0) {
      const unit =
        input.pauseDuration === 1 ? input.pauseDurationUnit.replace(/s$/, '') : input.pauseDurationUnit;
      parts.push(`auto-pauses after ${input.pauseDuration} ${unit}`);
    }
  }

  return parts;
}

/** The pieces as one readable sentence, e.g. "Starts on …, sends up to 50 emails per day, on weekdays only." */
export function describeCampaignScheduleSentence(input: CampaignScheduleSummaryInput): string {
  const parts = describeCampaignSchedule(input);
  if (parts.length === 0) return '';
  return parts.join(', ') + '.';
}
