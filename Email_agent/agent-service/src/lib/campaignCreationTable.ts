/**
 * src/lib/campaignCreationTable.ts
 *
 * Chat campaign creation, step 4a: the uploaded file → recipients.
 * The file is read row by row and every cell counts: the email can be in any column,
 * every link in any column is collected and classified (website / job post / LinkedIn / other).
 * Column meanings come from the LLM (COLUMN_READER_PROMPT) when available, else from guessColumns().
 */

export type ColumnKind =
  | "email" | "name" | "first_name" | "last_name" | "company" | "role" | "website"
  | "job_link" | "linkedin" | "phone" | "location" | "notes" | "other";

const KINDS = new Set<ColumnKind>([
  "email", "name", "first_name", "last_name", "company", "role", "website",
  "job_link", "linkedin", "phone", "location", "notes", "other",
]);

export interface TableColumn {
  index: number;
  label: string;
  kind: ColumnKind;
}

export interface TableLayout {
  hasHeader: boolean;
  columns: TableColumn[];
}

export type LinkKind = "website" | "job_post" | "linkedin" | "other";

export interface RecipientLink {
  url: string;
  kind: LinkKind;
}

export interface CampaignRecipient {
  /** 1-based row number in the file (as the user sees it in Excel). */
  row: number;
  email: string;
  name?: string;
  firstName?: string;
  company?: string;
  /** Every non-empty cell of the row, by column label. */
  fields: Record<string, string>;
  links: RecipientLink[];
}

export interface SkippedRow {
  row: number;
  reason: string;
}

/** Links fetched per recipient at most (research cost per row). */
export const MAX_LINKS_PER_RECIPIENT = 4;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const EMAIL_FULL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`,]+|\bwww\.[^\s<>"'`,]+/gi;
const BARE_DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i;

const JOB_HOSTS = /(^|\.)(upwork\.com|fiverr\.com|freelancer\.com|peopleperhour\.com|guru\.com|indeed\.com|glassdoor\.com|rozee\.pk|wellfound\.com|angel\.co|toptal\.com|workana\.com|truelancer\.com|monster\.com|ziprecruiter\.com)$/i;

/** website / job post / LinkedIn / other, by the link's host and path. */
export function classifyLink(url: string): LinkKind {
  let host = "";
  let path = "";
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = u.pathname.toLowerCase();
  } catch {
    return "other";
  }
  if (host.endsWith("linkedin.com")) return /^\/jobs\b/.test(path) ? "job_post" : "linkedin";
  if (JOB_HOSTS.test(host)) return "job_post";
  if (/\/(jobs?|careers?|vacanc(y|ies)|hiring|apply)(\/|$)/.test(path) && path.length > 6) return "job_post";
  if (/(^|\.)(facebook|instagram|twitter|x|youtube|tiktok)\.com$/.test(host)) return "other";
  return "website";
}

/** "www.acme.com/x," → "https://www.acme.com/x" (trailing punctuation dropped). */
function cleanUrl(raw: string): string {
  const t = raw.trim().replace(/[).,;:!?\]]+$/, "");
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

/** Links in one cell. In a link column (website / job link / LinkedIn) a bare domain ("acme.com") counts too. */
function linksInCell(value: string, linkColumn: boolean): string[] {
  const found = (value.match(URL_RE) ?? []).map(cleanUrl);
  if (found.length === 0 && linkColumn && BARE_DOMAIN_RE.test(value.trim()) && !EMAIL_RE.test(value)) {
    found.push(cleanUrl(value));
  }
  return found;
}

// ── Column meanings ──────────────────────────────────────────────────────────

const HEADER_HINTS: Array<[RegExp, ColumnKind]> = [
  [/e-?mail/i, "email"],
  [/^first[\s_-]?name$|^first$/i, "first_name"],
  [/^last[\s_-]?name$|^last$|surname/i, "last_name"],
  [/^(full[\s_-]?)?name$|contact[\s_-]?name|person/i, "name"],
  [/company|organi[sz]ation|business|^org$|brand/i, "company"],
  [/title|role|designation|position/i, "role"],
  [/linked[\s_-]?in/i, "linkedin"],
  [/job|upwork|fiverr|freelancer|gig|project[\s_-]?link|post/i, "job_link"],
  [/web[\s_-]?site|^url$|domain|^site$|link/i, "website"],
  [/phone|mobile|whats[\s_-]?app|contact[\s_-]?no/i, "phone"],
  [/city|country|location|address|region/i, "location"],
  [/note|comment|description|about|detail/i, "notes"],
];

function kindFromValues(values: string[]): ColumnKind | undefined {
  const filled = values.filter((v) => v !== "");
  if (filled.length === 0) return undefined;
  const share = (test: (v: string) => boolean) => filled.filter(test).length / filled.length;
  if (share((v) => EMAIL_FULL_RE.test(v)) >= 0.6) return "email";
  const links = filled.map((v) => (v.match(URL_RE) ?? []).map(cleanUrl)[0] ?? (BARE_DOMAIN_RE.test(v) ? cleanUrl(v) : ""));
  const linkShare = links.filter(Boolean).length / filled.length;
  if (linkShare >= 0.6) {
    const kinds = links.filter(Boolean).map(classifyLink);
    if (kinds.filter((k) => k === "job_post").length / kinds.length >= 0.5) return "job_link";
    if (kinds.filter((k) => k === "linkedin").length / kinds.length >= 0.5) return "linkedin";
    return "website";
  }
  if (share((v) => /^\+?[\d\s()-]{7,}$/.test(v)) >= 0.6) return "phone";
  return undefined;
}

/** Column meanings without the LLM: values first (an email column is an email column whatever its header), then the header. */
export function guessLayout(table: string[][]): TableLayout {
  const first = table[0] ?? [];
  const width = Math.max(0, ...table.slice(0, 50).map((r) => r.length));
  const firstHasData = first.some((c) => EMAIL_RE.test(c) || /https?:\/\/|www\./i.test(c));
  const hasHeader = table.length > 1 && !firstHasData;
  const dataRows = (hasHeader ? table.slice(1) : table).slice(0, 50);
  const columns: TableColumn[] = [];
  for (let i = 0; i < width; i++) {
    const header = hasHeader ? (first[i] ?? "").trim() : "";
    const byValues = kindFromValues(dataRows.map((r) => r[i] ?? ""));
    const byHeader = HEADER_HINTS.find(([re]) => re.test(header))?.[1];
    columns.push({ index: i, label: header || `Column ${i + 1}`, kind: byValues ?? byHeader ?? "other" });
  }
  return { hasHeader, columns };
}

/** The LLM's answer checked against the table; unknown or missing columns fall back to guessLayout(). */
export function layoutFromLlm(answer: Record<string, unknown> | undefined, table: string[][]): TableLayout {
  const guess = guessLayout(table);
  if (!answer || !Array.isArray(answer.columns)) return guess;
  const byIndex = new Map<number, TableColumn>();
  for (const c of answer.columns as unknown[]) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const index = typeof o.index === "number" ? o.index : Number.NaN;
    const kind = typeof o.kind === "string" && KINDS.has(o.kind as ColumnKind) ? (o.kind as ColumnKind) : undefined;
    if (!Number.isInteger(index) || index < 0 || !kind) continue;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : `Column ${index + 1}`;
    byIndex.set(index, { index, label, kind });
  }
  const hasHeader = typeof answer.hasHeader === "boolean" ? answer.hasHeader : guess.hasHeader;
  const columns = guess.columns.map((g) => {
    const llm = byIndex.get(g.index);
    if (!llm) return g;
    // Values win over the LLM for emails: a column full of addresses is the email column.
    if (g.kind === "email" && llm.kind !== "email") return { ...llm, kind: "email" as const };
    return llm;
  });
  return { hasHeader, columns };
}

// ── Rows → recipients ────────────────────────────────────────────────────────

export interface TableRecipients {
  recipients: CampaignRecipient[];
  skipped: SkippedRow[];
  /** Recipients with at least one link to research. */
  withLinks: number;
}

/** Every row → one recipient (or a skipped row with the reason). Emails are unique per file. */
export function recipientsFromTable(table: string[][], layout: TableLayout): TableRecipients {
  const labels = uniqueLabels(layout.columns);
  const kindOf = new Map(layout.columns.map((c) => [c.index, c.kind]));
  const start = layout.hasHeader ? 1 : 0;
  const recipients: CampaignRecipient[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();

  for (let r = start; r < table.length; r++) {
    const cells = table[r] ?? [];
    const rowNo = r + 1;
    const fields: Record<string, string> = {};
    const pick = (kind: ColumnKind) => cells.find((v, i) => kindOf.get(i) === kind && v.trim() !== "")?.trim();

    cells.forEach((v, i) => {
      if (v.trim() !== "") fields[labels.get(i) ?? `Column ${i + 1}`] = v.trim();
    });

    // The email: the email column first, else the first address in any cell.
    const emailCell = pick("email");
    const email = (emailCell?.match(EMAIL_RE)?.[0] ?? cells.map((c) => c.match(EMAIL_RE)?.[0]).find(Boolean) ?? "").trim();
    if (!email || !EMAIL_FULL_RE.test(email)) {
      skipped.push({ row: rowNo, reason: emailCell ? `invalid email "${emailCell.slice(0, 60)}"` : "no email address" });
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      skipped.push({ row: rowNo, reason: `duplicate email ${email}` });
      continue;
    }
    seen.add(key);

    const urls: string[] = [];
    cells.forEach((v, i) => {
      const kind = kindOf.get(i);
      for (const u of linksInCell(v, kind === "website" || kind === "job_link" || kind === "linkedin")) {
        if (!urls.some((x) => x.toLowerCase() === u.toLowerCase())) urls.push(u);
      }
    });
    // Job posts first (their research is mandatory), then the company site, LinkedIn, the rest.
    const order: Record<LinkKind, number> = { job_post: 0, website: 1, linkedin: 2, other: 3 };
    const links = urls
      .map((url) => ({ url, kind: classifyLink(url) }))
      .sort((a, b) => order[a.kind] - order[b.kind])
      .slice(0, MAX_LINKS_PER_RECIPIENT);

    const first = pick("first_name");
    const last = pick("last_name");
    const name = pick("name") ?? ([first, last].filter(Boolean).join(" ") || undefined);
    const firstName = first ?? name?.split(/\s+/)[0];
    const company = pick("company");

    recipients.push({
      row: rowNo,
      email,
      ...(name ? { name } : {}),
      ...(firstName ? { firstName } : {}),
      ...(company ? { company } : {}),
      fields,
      links,
    });
  }
  return { recipients, skipped, withLinks: recipients.filter((x) => x.links.length > 0).length };
}

function uniqueLabels(columns: TableColumn[]): Map<number, string> {
  const out = new Map<number, string>();
  const used = new Map<string, number>();
  for (const c of columns) {
    const base = c.label || `Column ${c.index + 1}`;
    const n = (used.get(base.toLowerCase()) ?? 0) + 1;
    used.set(base.toLowerCase(), n);
    out.set(c.index, n === 1 ? base : `${base} ${n}`);
  }
  return out;
}
