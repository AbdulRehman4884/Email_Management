/**
 * Run: npx tsx --test src/lib/__tests__/sendTimeByCountry.test.ts   (no database)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recipientZone, sendTimeByCountry } from '../sendTimeByCountry.js';

const fields = (o: Record<string, string>) => JSON.stringify(o);
// 2026-01-15 (winter: London UTC+0, New York UTC-5, Karachi UTC+5).
const at = (iso: string) => ({ openedAtMs: Date.parse(iso) });
const winter = new Date('2026-01-15T12:00:00Z');

test('country names and codes map to a time zone; timezone column wins', () => {
  assert.deepEqual(recipientZone(fields({ country: 'Pakistan' })), { group: 'Pakistan', tz: 'Asia/Karachi' });
  assert.deepEqual(recipientZone(fields({ country: 'U.K.' })), { group: 'UK', tz: 'Europe/London' });
  assert.deepEqual(recipientZone(fields({ country: 'us', timezone: 'America/Los_Angeles' })), { group: 'USA', tz: 'America/Los_Angeles' });
  assert.deepEqual(recipientZone(fields({ time_zone: 'Asia/Tokyo' })), { group: 'Asia/Tokyo', tz: 'Asia/Tokyo' });
  assert.equal(recipientZone(fields({ country: 'Atlantis' })), null);
  assert.equal(recipientZone(fields({ timezone: 'Not/AZone' })), null);
  assert.equal(recipientZone('not json'), null);
  assert.equal(recipientZone(null), null);
});

test('leads who all open at 10 AM their own time show 10 AM, with the Pakistan time to schedule', () => {
  const r = sendTimeByCountry(
    [
      { ...at('2026-01-15T05:00:00Z'), customFields: fields({ country: 'Pakistan' }) }, // 10 AM Karachi
      { ...at('2026-01-15T10:00:00Z'), customFields: fields({ country: 'UK' }) }, // 10 AM London
      { ...at('2026-01-15T10:20:00Z'), customFields: fields({ country: 'UK' }) },
      { ...at('2026-01-15T15:00:00Z'), customFields: fields({ country: 'USA' }) }, // 10 AM New York
      { ...at('2026-01-15T15:00:00Z'), customFields: fields({}) },
    ],
    'Asia/Karachi',
    winter,
  );
  const byCountry = Object.fromEntries(r.countries.map((c) => [c.country, c]));
  assert.equal(r.countries[0]!.country, 'UK'); // most opens first
  assert.equal(byCountry.UK!.bestLocalHour, 10);
  assert.equal(byCountry.UK!.bestViewerMinute, 15 * 60); // 3 PM in Karachi
  assert.equal(byCountry.USA!.bestLocalHour, 10);
  assert.equal(byCountry.USA!.bestViewerMinute, 20 * 60); // 8 PM in Karachi
  assert.equal(byCountry.Pakistan!.bestViewerMinute, 10 * 60);
  assert.equal(r.opensWithoutCountry, 1);
});

test('half-hour zones keep their minutes', () => {
  const r = sendTimeByCountry([{ ...at('2026-01-15T04:30:00Z'), customFields: fields({ country: 'India' }) }], 'Asia/Karachi', winter);
  assert.equal(r.countries[0]!.bestLocalHour, 10); // 10:00 Kolkata
  assert.equal(r.countries[0]!.bestViewerMinute, 9 * 60 + 30); // 9:30 Karachi
});
