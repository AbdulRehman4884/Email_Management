/**
 * src/lib/parseCompanyFile.ts
 *
 * Parses an uploaded Excel/CSV company list for the cold-call script generator.
 *
 * Rules:
 *   - First sheet only.
 *   - Required columns (case-insensitive): Company Name + Website.
 *   - Every other column goes into extraFields as script context.
 *   - Rows with an empty/invalid website or no company name are skipped and counted.
 *   - Duplicate websites: first one kept, the rest skipped and counted.
 */

import * as XLSX from "xlsx";
import { isEmailLike, normalizeWebsiteUrlOrUndefined } from "./websiteInput.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompanyRow {
  /** 1-based row number in the sheet (header = row 1), for the user's reference. */
  rowNumber:   number;
  companyName: string;
  website:     string;
  extraFields: Record<string, string>;
}

export interface CompanyFileReport {
  totalRows:          number;
  validRows:          number;
  missingWebsite:     number;
  invalidWebsite:     number;
  missingCompanyName: number;
  duplicates:         number;
}

export type ParseCompanyFileResult =
  | { ok: true; rows: CompanyRow[]; report: CompanyFileReport }
  | { ok: false; error: string };

// ── Column detection ──────────────────────────────────────────────────────────

const COMPANY_HEADERS = ["company", "company name", "companyname", "name"];
const WEBSITE_HEADERS = ["website", "url", "domain", "site", "website url", "company website", "web site"];

const MAX_EXTRA_VALUE_CHARS = 500;

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** Finds the first header matching the candidates, in candidate priority order. */
function findColumn(headers: string[], candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const match = headers.find((h) => normaliseHeader(h) === candidate);
    if (match !== undefined) return match;
  }
  return undefined;
}

// ── Website normalisation ─────────────────────────────────────────────────────

/** Accepts "acme.com", "www.acme.com/", "https://acme.com/about". Rejects emails. */
export function normaliseCompanyWebsite(raw: string): string | undefined {
  const t = raw.trim();
  if (!t || isEmailLike(t)) return undefined;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, "")}`;
  return normalizeWebsiteUrlOrUndefined(withScheme);
}

function dedupeKey(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseCompanyFile(fileContentBase64: string): ParseCompanyFileResult {
  let sheetRows: Record<string, unknown>[];
  let headers: string[];

  try {
    const wb = XLSX.read(Buffer.from(fileContentBase64, "base64"), { type: "buffer", cellDates: true });
    const firstSheetName = wb.SheetNames[0];
    const sheet = firstSheetName ? wb.Sheets[firstSheetName] : undefined;
    if (!sheet) return { ok: false, error: "Aapki file khali hai — koi sheet nahi mili." };

    sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const headerRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: 0 })[0] ?? [];
    headers = headerRow.map((h) => cellToString(h)).filter(Boolean);
  } catch {
    return { ok: false, error: "File parh nahi saka — check karein ke ye sahi Excel (.xlsx/.xls) ya CSV file hai." };
  }

  const companyCol = findColumn(headers, COMPANY_HEADERS);
  const websiteCol = findColumn(headers, WEBSITE_HEADERS);

  if (!websiteCol) return { ok: false, error: "Aapki file mein 'Website' column nahi mila." };
  if (!companyCol) return { ok: false, error: "Aapki file mein 'Company Name' column nahi mila." };

  const extraCols = headers.filter((h) => h !== companyCol && h !== websiteCol && !h.startsWith("__EMPTY"));

  const report: CompanyFileReport = {
    totalRows:          sheetRows.length,
    validRows:          0,
    missingWebsite:     0,
    invalidWebsite:     0,
    missingCompanyName: 0,
    duplicates:         0,
  };

  const rows: CompanyRow[] = [];
  const seen = new Set<string>();

  sheetRows.forEach((raw, i) => {
    const rawWebsite  = cellToString(raw[websiteCol]);
    const companyName = cellToString(raw[companyCol]);

    if (!rawWebsite) { report.missingWebsite++; return; }
    const website = normaliseCompanyWebsite(rawWebsite);
    if (!website) { report.invalidWebsite++; return; }
    if (!companyName) { report.missingCompanyName++; return; }

    const key = dedupeKey(website);
    if (seen.has(key)) { report.duplicates++; return; }
    seen.add(key);

    const extraFields: Record<string, string> = {};
    for (const col of extraCols) {
      const value = cellToString(raw[col]);
      if (value) extraFields[col.trim()] = value.slice(0, MAX_EXTRA_VALUE_CHARS);
    }

    rows.push({ rowNumber: i + 2, companyName: companyName.slice(0, 200), website, extraFields });
  });

  report.validRows = rows.length;
  return { ok: true, rows, report };
}

/** "10,000 rows: 9,640 valid, 210 bina website, 150 duplicate." — zero counts are left out. */
export function formatParseReport(report: CompanyFileReport): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const parts = [`${n(report.validRows)} valid`];
  if (report.missingWebsite)     parts.push(`${n(report.missingWebsite)} bina website`);
  if (report.invalidWebsite)     parts.push(`${n(report.invalidWebsite)} ghalat website`);
  if (report.missingCompanyName) parts.push(`${n(report.missingCompanyName)} bina company name`);
  if (report.duplicates)         parts.push(`${n(report.duplicates)} duplicate`);
  return `${n(report.totalRows)} rows: ${parts.join(", ")}.`;
}
