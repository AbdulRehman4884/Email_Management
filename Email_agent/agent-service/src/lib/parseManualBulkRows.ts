export interface BulkRow {
  company: string;
  website: string;
  email: string;
  first_name?: string;
  last_name?: string;
  role?: string;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const WEBSITE_RE = /https?:\/\/[^\s)\],|]+/i;

export function parseManualBulkRows(message: string): BulkRow[] {
  return message
    .split(/\r?\n/)
    .map(parseManualBulkRow)
    .filter((row): row is BulkRow => Boolean(row));
}

function parseManualBulkRow(rawLine: string): BulkRow | undefined {
  const line = normalizeLine(rawLine);
  if (!line) return undefined;

  const email = line.match(EMAIL_RE)?.[0]?.toLowerCase();
  const rawWebsite = line.match(WEBSITE_RE)?.[0];
  if (!email || !rawWebsite || !isValidEmail(email)) return undefined;

  const website = normalizeWebsite(rawWebsite);
  if (!website) return undefined;

  const company = extractCompany(line, website);
  if (!company) return undefined;

  return { company, website, email };
}

function normalizeLine(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\(\s*mailto:([^)]+)\s*\)/gi, "$2")
    .replace(/^\s*(?:[-*]\s*)?\d+[\).:-]\s*/, "")
    .trim();
}

function normalizeWebsite(rawWebsite: string): string | undefined {
  const website = rawWebsite.replace(/[)\].,;]+$/g, "").trim();
  try {
    const parsed = new URL(website);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (!parsed.hostname.includes(".")) return undefined;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function extractCompany(line: string, website: string): string {
  const websiteIndex = line.indexOf(website);
  const rawCompany = websiteIndex >= 0 ? line.slice(0, websiteIndex) : line;
  return rawCompany
    .replace(/\[([^\]]+)\]\(\s*mailto:([^)]+)\s*\)/gi, "$2")
    .replace(EMAIL_RE, "")
    .replace(/^\s*(?:[-*]\s*)?\d+[\).:-]\s*/, "")
    .replace(/[\s,/|:-]+$/g, "")
    .trim();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
