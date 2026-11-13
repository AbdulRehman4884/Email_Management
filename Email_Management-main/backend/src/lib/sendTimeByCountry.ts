import { formatInTimeZone, getTimezoneOffset } from 'date-fns-tz';
import { isValidTimezone } from './leadgen/schedule.js';

/** Country (name or 2-letter code, lower case) -> [display name, main time zone]. */
const COUNTRIES: Array<[string[], string, string]> = [
  [['pk', 'pakistan'], 'Pakistan', 'Asia/Karachi'],
  [['in', 'india'], 'India', 'Asia/Kolkata'],
  [['bd', 'bangladesh'], 'Bangladesh', 'Asia/Dhaka'],
  [['ae', 'uae', 'united arab emirates'], 'UAE', 'Asia/Dubai'],
  [['sa', 'ksa', 'saudi arabia', 'saudi'], 'Saudi Arabia', 'Asia/Riyadh'],
  [['qa', 'qatar'], 'Qatar', 'Asia/Qatar'],
  [['kw', 'kuwait'], 'Kuwait', 'Asia/Kuwait'],
  [['bh', 'bahrain'], 'Bahrain', 'Asia/Bahrain'],
  [['om', 'oman'], 'Oman', 'Asia/Muscat'],
  [['tr', 'turkey', 'turkiye'], 'Turkey', 'Europe/Istanbul'],
  [['eg', 'egypt'], 'Egypt', 'Africa/Cairo'],
  [['gb', 'uk', 'united kingdom', 'england', 'great britain', 'scotland', 'wales'], 'UK', 'Europe/London'],
  [['ie', 'ireland'], 'Ireland', 'Europe/Dublin'],
  [['de', 'germany'], 'Germany', 'Europe/Berlin'],
  [['fr', 'france'], 'France', 'Europe/Paris'],
  [['es', 'spain'], 'Spain', 'Europe/Madrid'],
  [['it', 'italy'], 'Italy', 'Europe/Rome'],
  [['nl', 'netherlands', 'holland'], 'Netherlands', 'Europe/Amsterdam'],
  [['us', 'usa', 'united states', 'united states of america', 'america'], 'USA', 'America/New_York'],
  [['ca', 'canada'], 'Canada', 'America/Toronto'],
  [['au', 'australia'], 'Australia', 'Australia/Sydney'],
  [['nz', 'new zealand'], 'New Zealand', 'Pacific/Auckland'],
  [['sg', 'singapore'], 'Singapore', 'Asia/Singapore'],
  [['my', 'malaysia'], 'Malaysia', 'Asia/Kuala_Lumpur'],
  [['cn', 'china'], 'China', 'Asia/Shanghai'],
  [['jp', 'japan'], 'Japan', 'Asia/Tokyo'],
  [['za', 'south africa'], 'South Africa', 'Africa/Johannesburg'],
  [['ng', 'nigeria'], 'Nigeria', 'Africa/Lagos'],
  [['ke', 'kenya'], 'Kenya', 'Africa/Nairobi'],
  [['br', 'brazil'], 'Brazil', 'America/Sao_Paulo'],
];
const BY_KEY = new Map(COUNTRIES.flatMap(([keys, name, tz]) => keys.map((k) => [k, { name, tz }] as const)));

/**
 * The lead's group and time zone from the recipient's file columns: `timezone` (or `time_zone`) wins,
 * otherwise the main time zone of `country`. Null when neither gives a known zone.
 */
export function recipientZone(customFieldsJson: string | null): { group: string; tz: string } | null {
  let fields: Record<string, string>;
  try {
    fields = customFieldsJson ? JSON.parse(customFieldsJson) : {};
  } catch {
    return null;
  }
  const countryRaw = String(fields.country ?? '').trim();
  const country = BY_KEY.get(countryRaw.toLowerCase().replace(/\./g, ''));
  const tz = String(fields.timezone ?? fields.time_zone ?? '').trim();
  if (tz && isValidTimezone(tz)) return { group: country?.name || countryRaw || tz, tz };
  return country ? { group: country.name, tz: country.tz } : null;
}

/** `bestViewerMinute` is minutes after midnight in the viewer's zone (zones like India are 30 minutes off). */
export type CountrySendTime = { country: string; timezone: string; opens: number; bestLocalHour: number; bestViewerMinute: number };

/** Per country: the hour (in the lead's own time) with most first opens, and that time in the viewer's zone today. */
export function sendTimeByCountry(
  opens: Array<{ openedAtMs: number; customFields: string | null }>,
  viewerTz: string,
  now = new Date(),
): { countries: CountrySendTime[]; opensWithoutCountry: number } {
  const groups = new Map<string, { tz: string; hours: number[] }>();
  let opensWithoutCountry = 0;
  for (const o of opens) {
    const zone = recipientZone(o.customFields);
    if (!zone) {
      opensWithoutCountry += 1;
      continue;
    }
    const g = groups.get(zone.group) ?? { tz: zone.tz, hours: new Array(24).fill(0) };
    g.hours[Number(formatInTimeZone(new Date(o.openedAtMs), zone.tz, 'H'))]! += 1;
    groups.set(zone.group, g);
  }
  const countries = [...groups].map(([country, g]) => {
    const bestLocalHour = g.hours.indexOf(Math.max(...g.hours));
    const shiftMinutes = (getTimezoneOffset(viewerTz, now) - getTimezoneOffset(g.tz, now)) / 60_000;
    return {
      country,
      timezone: g.tz,
      opens: g.hours.reduce((a, b) => a + b, 0),
      bestLocalHour,
      bestViewerMinute: (((bestLocalHour * 60 + shiftMinutes) % 1440) + 1440) % 1440,
    };
  });
  countries.sort((a, b) => b.opens - a.opens);
  return { countries: countries.slice(0, 10), opensWithoutCountry };
}
