// U-04: one date format for the whole app: "Oct 23, 2026" (with time: "Oct 23, 2026, 5:00 AM").

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDisplayDate(value: string | null | undefined, withTime = false): string {
  if (!value) return '';
  const normalized = String(value).replace(' ', 'T');
  // Date-only values ("2026-10-23") are calendar dates: format them as-is so no time zone can shift the day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [y, m, d] = normalized.split('-');
    return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}
