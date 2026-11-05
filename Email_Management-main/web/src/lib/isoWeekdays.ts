/** ISO weekday: Mon = 1 … Sun = 7 (matches backend). */
export const ISO_WEEKDAY_OPTIONS: ReadonlyArray<{ iso: number; short: string }> = [
  { iso: 1, short: 'Mon' },
  { iso: 2, short: 'Tue' },
  { iso: 3, short: 'Wed' },
  { iso: 4, short: 'Thu' },
  { iso: 5, short: 'Fri' },
  { iso: 6, short: 'Sat' },
  { iso: 7, short: 'Sun' },
];

export function formatIsoWeekdaysList(days: number[] | null | undefined): string {
  if (!days || days.length === 0) return '';
  const order = new Map(ISO_WEEKDAY_OPTIONS.map((o) => [o.iso, o.short]));
  return [...days]
    .filter((n) => n >= 1 && n <= 7)
    .sort((a, b) => a - b)
    .map((n) => order.get(n) ?? String(n))
    .join(', ');
}

/** RT-05: next allowed send day after today as "Wed 28 Oct" (browser calendar), or '' if any day is allowed. */
export function nextAllowedSendDayLabel(days: number[] | null | undefined, now: Date = new Date()): string {
  if (!days || days.length === 0) return '';
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = d.getDay() === 0 ? 7 : d.getDay();
    if (days.includes(iso)) {
      const weekday = ISO_WEEKDAY_OPTIONS.find((o) => o.iso === iso)?.short ?? '';
      return `${weekday} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
    }
  }
  return '';
}
