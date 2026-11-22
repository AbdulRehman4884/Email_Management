/**
 * src/lib/parseCompanyFile.ts
 *
 * Parses an uploaded Excel/CSV company list for the cold-call script generator.
 *
 * Rules:
 *   - First sheet only.
 *   - Required columns (case-insensitive): Company Name + Website.
 *   - Every other column goes into extraFields as script context.
 *   - Rows with an empty/invalid website or no company name are skipped, counted and named (row + reason).
 *   - Duplicates: the same company name at the same website (first kept). Two DIFFERENT companies that
 *     share a website are both kept (QA P4 bug 29: the second one disappeared without a word).
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

/** A row that was not saved, for the reply ("Row 5 — QA Bad Site Co: invalid website"). */
export interface SkippedCompanyRow {
  rowNumber:   number;
  companyName: string;
  reason:      "missing website" | "invalid website" | "missing company name" | "duplicate";
}

export type ParseCompanyFileResult =
  | { ok: true; rows: CompanyRow[]; report: CompanyFileReport; skipped: SkippedCompanyRow[] }
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

  const EMPTY_FILE = "The file is empty. Please add a header row with **Company Name** and **Website**, and at least one company below it.";
  try {
    const bytes = Buffer.from(fileContentBase64, "base64");
    if (bytes.toString("utf8").replace(/^﻿/, "").trim() === "") return { ok: false, error: EMPTY_FILE };
    const isXlsx = bytes.subarray(0, 2).equals(Buffer.from([0x50, 0x4b]));
    // SheetJS's Buffer/CSV path can treat UTF-8 bytes without a BOM as a legacy codepage.
    // Decode CSV explicitly as UTF-8 so Urdu/Arabic names survive the upload unchanged.
    const wb = isXlsx
      ? XLSX.read(bytes, { type: "buffer", cellDates: true })
      : XLSX.read(bytes.toString("utf8").replace(/^\uFEFF/, ""), { type: "string", cellDates: true });
    const firstSheetName = wb.SheetNames[0];
    const sheet = firstSheetName ? wb.Sheets[firstSheetName] : undefined;
    if (!sheet) return { ok: false, error: EMPTY_FILE };

    sheetRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const headerRow = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: 0 })[0] ?? [];
    headers = headerRow.map((h) => cellToString(h)).filter(Boolean);
  } catch {
    return { ok: false, error: "I couldn't read this file. Please check that it is a real Excel (.xlsx / .xls) or CSV file." };
  }

  if (headers.length === 0) return { ok: false, error: EMPTY_FILE };

  const companyCol = findColumn(headers, COMPANY_HEADERS);
  const websiteCol = findColumn(headers, WEBSITE_HEADERS);

  // Name every missing column at once, and show what was found (QA P4 bug 12).
  const missing = [!companyCol && "**Company Name**", !websiteCol && "**Website**"].filter(Boolean) as string[];
  if (missing.length) {
    const found = headers.filter((h) => !h.startsWith("__EMPTY")).map((h) => `"${h}"`).join(", ");
    return {
      ok: false,
      error: `The file is missing the required ${missing.join(" and ")} ${missing.length === 1 ? "column" : "columns"}. ` +
        `Columns found: ${found || "none"}. Please rename or add the columns and attach the file again.`,
    };
  }
  if (!companyCol || !websiteCol) return { ok: false, error: EMPTY_FILE }; // unreachable; narrows the types

  if (sheetRows.length === 0) {
    return { ok: false, error: "The file has the **Company Name** and **Website** columns but no companies below them. Please add at least one company." };
  }

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
  const skipped: SkippedCompanyRow[] = [];
  const seen = new Set<string>();

  sheetRows.forEach((raw, i) => {
    const rawWebsite  = cellToString(raw[websiteCol]);
    const companyName = cellToString(raw[companyCol]);
    const rowNumber   = i + 2;
    const skip = (reason: SkippedCompanyRow["reason"]) => skipped.push({ rowNumber, companyName: companyName.slice(0, 200), reason });

    if (!rawWebsite) { report.missingWebsite++; skip("missing website"); return; }
    const website = normaliseCompanyWebsite(rawWebsite);
    if (!website) { report.invalidWebsite++; skip("invalid website"); return; }
    if (!companyName) { report.missingCompanyName++; skip("missing company name"); return; }

    // Same company at the same website = duplicate; a different company at that website is kept.
    const key = `${dedupeKey(website)}|${companyName.toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) { report.duplicates++; skip("duplicate"); return; }
    seen.add(key);

    const extraFields: Record<string, string> = {};
    for (const col of extraCols) {
      const value = cellToString(raw[col]);
      if (value) extraFields[col.trim()] = value.slice(0, MAX_EXTRA_VALUE_CHARS);
    }

    rows.push({ rowNumber, companyName: companyName.slice(0, 200), website, extraFields });
  });

  report.validRows = rows.length;
  return { ok: true, rows, report, skipped };
}

/** "Row 5 — QA Bad Site Co: invalid website" lines (at most `max`, then "…and N more"). */
export function formatSkippedRows(skipped: SkippedCompanyRow[], max = 10): string[] {
  const lines = skipped.slice(0, max).map((s) => `Row ${s.rowNumber} — ${s.companyName || "(no company name)"}: ${s.reason}`);
  if (skipped.length > max) lines.push(`…and ${skipped.length - max} more`);
  return lines;
}

/** "10,000 rows: 9,640 valid, 210 missing website, 150 duplicate." — zero counts are left out. English only. */
export function formatParseReport(report: CompanyFileReport): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const parts = [`${n(report.validRows)} valid`];
  if (report.missingWebsite)     parts.push(`${n(report.missingWebsite)} missing website`);
  if (report.invalidWebsite)     parts.push(`${n(report.invalidWebsite)} invalid website`);
  if (report.missingCompanyName) parts.push(`${n(report.missingCompanyName)} missing company name`);
  if (report.duplicates)         parts.push(`${n(report.duplicates)} duplicate`);
  return `${n(report.totalRows)} rows: ${parts.join(", ")}.`;
}
