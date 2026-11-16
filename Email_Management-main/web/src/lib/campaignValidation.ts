// Shared checks for the Create / Edit campaign forms.

/** F-17: button / link URLs must be absolute http(s) URLs. Empty is allowed (field is optional). */
export function isValidHttpUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !/\s/.test(v);
  } catch {
    return false;
  }
}

export const INVALID_URL_MESSAGE = 'Enter a valid URL (https://...)';

/** CP-01: rich-text HTML counts as empty when it has no visible text (only tags, spaces or &nbsp;). */
export function htmlHasVisibleText(html: string): boolean {
  const text = (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/ /g, ' ');
  return text.trim().length > 0;
}

/**
 * F-18 / F-19: placeholders that are always available, whatever the CSV has.
 * Must match validatePlaceholdersAgainstColumns() in backend/src/controllers/campaignController.ts.
 */
export const BUILT_IN_PLACEHOLDERS = ['email', 'name', 'firstname', 'first_name', 'lastname', 'last_name'];

/** Columns that also make {company} available (same aliases as replacePlaceholders). */
const COMPANY_ALIASES = ['company', 'company_name', 'organization', 'org'];

export function extractPlaceholders(text: string): string[] {
  const found = new Set<string>();
  const re = /\{\{?([a-z_][a-z0-9_]*)\}?\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || '')) !== null) {
    if (m[1]) found.add(m[1].toLowerCase());
  }
  return Array.from(found);
}

/**
 * Placeholders used in the texts that are neither built in nor in `columns`.
 * When `columns` is null (no CSV uploaded yet) only built-ins count as known.
 */
export function findUnknownPlaceholders(texts: string[], columns: string[] | null): string[] {
  const known = new Set(BUILT_IN_PLACEHOLDERS);
  for (const c of columns ?? []) known.add(c.toLowerCase());
  if ((columns ?? []).some((c) => COMPANY_ALIASES.includes(c.toLowerCase()))) known.add('company');
  const used = new Set<string>();
  for (const t of texts) extractPlaceholders(t).forEach((p) => used.add(p));
  return Array.from(used).filter((p) => !known.has(p));
}

/** F-19: the one placeholder list every screen shows (built-ins first; file columns are added after them). */
export const PLACEHOLDER_CHIPS = ['email', 'name', 'first_name', 'last_name'];
export const PLACEHOLDER_HINT =
  'Built-in placeholders: {email}, {name}, {first_name}, {last_name}. Any other column of your recipient file also works, e.g. {company}.';

/** UP-01: "2 duplicates in the file, 1 already in this campaign, 4 invalid email format" ('' when nothing skipped). */
export function uploadSkipSummary(r: {
  rejectedCount?: number;
  duplicateCount?: number;
  alreadyInCampaignCount?: number;
  suppressedCount?: number;
}): string {
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n && n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(r.duplicateCount, 'duplicate in the file', 'duplicates in the file');
  add(r.alreadyInCampaignCount, 'already in this campaign', 'already in this campaign');
  add(r.suppressedCount, 'unsubscribed or bounced earlier', 'unsubscribed or bounced earlier');
  add(r.rejectedCount, 'invalid email format', 'invalid email format');
  return parts.join(', ');
}

/** "2 emails may bounce: abc@gmal.com (did you mean gmail.com?), …" ('' when none). */
export function uploadSuspiciousSummary(r: {
  suspiciousCount?: number;
  suspiciousEmails?: Array<{ email: string; reason: string }>;
}): string {
  const n = r.suspiciousCount ?? 0;
  if (n === 0) return '';
  const shown = (r.suspiciousEmails ?? []).slice(0, 3).map((s) => `${s.email} (${s.reason})`);
  const more = n > shown.length ? `, and ${n - shown.length} more` : '';
  return `${n} email${n === 1 ? '' : 's'} may bounce: ${shown.join(', ')}${more}`;
}
