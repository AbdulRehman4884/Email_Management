/**
 * Run: npm run test:leadgen   (offline)
 * Lead Engine Day 1, schedule maths: user timezone, weekdays, DST, jitter, no backlog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNextRunAt, isValidTimezone, localDateOf, maskToWeekdays, MAX_JITTER_MS, normalizeLocalTime, weekdaysToMask,
} from '../leadgen/schedule.js';

const noJitter = () => 0;
const daily = (runAtLocal: string, timezone = 'Asia/Karachi') => ({ frequency: 'daily' as const, runAtLocal, timezone, weekdaysMask: 127 });

test('daily 09:00 Karachi (UTC+5): later today, or tomorrow once the slot has passed', () => {
  assert.equal(computeNextRunAt(daily('09:00'), new Date('2026-10-29T03:00:00Z'), noJitter).toISOString(), '2026-10-29T04:00:00.000Z');
  assert.equal(computeNextRunAt(daily('09:00:00'), new Date('2026-10-29T04:00:00Z'), noJitter).toISOString(), '2026-10-30T04:00:00.000Z');
  assert.equal(computeNextRunAt(daily('9:00'), new Date('2026-10-29T20:00:00Z'), noJitter).toISOString(), '2026-10-30T04:00:00.000Z');
});

test('weekly: only the chosen weekdays (2026-10-29 is a Thursday)', () => {
  const monWed = { frequency: 'weekly' as const, runAtLocal: '09:00', timezone: 'Asia/Karachi', weekdaysMask: weekdaysToMask(['mon', 'wed']) };
  assert.equal(computeNextRunAt(monWed, new Date('2026-10-29T03:00:00Z'), noJitter).toISOString(), '2026-11-02T04:00:00.000Z');
  assert.equal(computeNextRunAt(monWed, new Date('2026-11-02T05:00:00Z'), noJitter).toISOString(), '2026-11-04T04:00:00.000Z');
  // daily ignores the mask
  assert.equal(computeNextRunAt({ ...monWed, frequency: 'daily' }, new Date('2026-10-29T03:00:00Z'), noJitter).toISOString(), '2026-10-29T04:00:00.000Z');
});

test('DST: 09:00 New York stays 09:00 local across the change (1 Nov 2026)', () => {
  const ny = daily('09:00', 'America/New_York');
  assert.equal(computeNextRunAt(ny, new Date('2026-10-31T00:00:00Z'), noJitter).toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(computeNextRunAt(ny, new Date('2026-10-31T13:00:00Z'), noJitter).toISOString(), '2026-11-01T14:00:00.000Z');
});

test('no backlog: after 3 days of downtime the next run is the next slot after now', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const next = computeNextRunAt(daily('09:00'), now, noJitter);
  assert.equal(next.toISOString(), '2026-11-02T04:00:00.000Z');
});

test('jitter is 0-10 minutes and never crosses local midnight', () => {
  const after = new Date('2026-10-29T03:00:00Z');
  const max = computeNextRunAt(daily('09:00'), after, () => 0.9999).getTime() - new Date('2026-10-29T04:00:00Z').getTime();
  assert.ok(max > 0 && max < MAX_JITTER_MS);
  const late = computeNextRunAt(daily('23:55'), after, () => 0.9999);
  assert.equal(localDateOf(late, 'Asia/Karachi'), '2026-10-29');
  assert.ok(late.getTime() - new Date('2026-10-29T18:55:00Z').getTime() <= 4 * 60_000);
});

test('helpers: weekday masks, local times, timezones', () => {
  assert.equal(weekdaysToMask(['mon', 'sun']), 65);
  assert.equal(weekdaysToMask([]), 127);
  assert.deepEqual(maskToWeekdays(65), ['mon', 'sun']);
  assert.equal(normalizeLocalTime('9:05'), '09:05:00');
  assert.equal(normalizeLocalTime('24:00'), null);
  assert.equal(normalizeLocalTime('nine'), null);
  assert.equal(isValidTimezone('Asia/Karachi'), true);
  assert.equal(isValidTimezone('Mars/Base'), false);
  // An invalid timezone falls back to Asia/Karachi instead of throwing.
  assert.equal(computeNextRunAt(daily('09:00', 'Mars/Base'), new Date('2026-10-29T03:00:00Z'), noJitter).toISOString(), '2026-10-29T04:00:00.000Z');
});
