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
