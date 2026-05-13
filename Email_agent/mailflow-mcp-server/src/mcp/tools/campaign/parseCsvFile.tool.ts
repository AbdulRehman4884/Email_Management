/**
 * src/mcp/tools/campaign/parseCsvFile.tool.ts
 *
 * Pure in-process parsing tool — does NOT call the MailFlow backend.
 * Decodes a base64-encoded CSV or XLSX file, normalises column names,
 * validates email addresses, and returns a preview + summary.
 *
 * Column name aliases (same as the backend upload endpoint):
 *   email column : "email" | "email_address"
 *   name column  : "name"  | "full_name"
 * All other columns are treated as custom personalisation fields.
 */

import { parse as parseCsvSync } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { TOOL_NAMES } from "../../../config/constants.js";
import { ParseCsvFileSchema } from "../../../schemas/index.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import { ErrorCode } from "../../../lib/errors.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { CsvParseResult, CsvPreviewRow } from "../../../types/mailflow.js";

const EMAIL_ALIASES = new Set(["email", "email_address"]);
const NAME_ALIASES  = new Set(["name", "full_name"]);
const PREVIEW_LIMIT = 5;

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function normaliseKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function rowsFromBuffer(buffer: Buffer, filename: string): Array<Record<string, string>> {
  const isXlsx = /\.(xlsx|xls)$/i.test(filename);

  if (isXlsx) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return [];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    return raw.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, String(v ?? "")]),
      ),
    );
  }

  // CSV path
  const records = parseCsvSync(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>;
  return records;
}

export const parseCsvFileTool: McpToolDefinition<
  typeof ParseCsvFileSchema,
  CsvParseResult
> = {
  name: TOOL_NAMES.PARSE_CSV_FILE,

  description:
    "Parses a base64-encoded CSV or XLSX file and returns a preview with statistics. " +
    "Does not save any data — call save_csv_recipients to persist the recipients. " +
    "Returns: totalRows, validRows (valid email), invalidRows, columns, preview (first 5 rows).",

  inputSchema: ParseCsvFileSchema,

  handler: async (input, context) => {
    const { fileContent, filename } = input;
    context.log.info({ filename }, "parseCsvFile: starting");

    let rawRows: Array<Record<string, string>>;
    try {
      const buffer = Buffer.from(fileContent, "base64");
      rawRows = rowsFromBuffer(buffer, filename);
    } catch (err) {
      context.log.error({ err }, "parseCsvFile: failed to decode/parse file");
      return toolFailure(ErrorCode.TOOL_VALIDATION_ERROR, "Failed to parse file — ensure it is a valid CSV or XLSX.");
    }

    if (rawRows.length === 0) {
      return toolSuccess<CsvParseResult>({
        totalRows: 0, validRows: 0, invalidRows: 0, columns: [], preview: [], rows: [],
      });
    }

    // Detect original column names from first row
    const originalColumns = Object.keys(rawRows[0]!);
    const columns = originalColumns;

    let validRows = 0;
    let invalidRows = 0;
    const preview: CsvPreviewRow[] = [];
    const allRows: Array<Record<string, string>> = [];

    for (const rawRow of rawRows) {
      // Normalise keys
      const normRow: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawRow)) {
        normRow[normaliseKey(k)] = String(v ?? "").trim();
      }

      // Resolve email field
      let email = "";
      for (const alias of EMAIL_ALIASES) {
        if (normRow[alias]) { email = normRow[alias]!; break; }
      }

      // Resolve name field
      let name = "";
      for (const alias of NAME_ALIASES) {
        if (normRow[alias]) { name = normRow[alias]!; break; }
      }

      if (!email || !isValidEmail(email)) {
        invalidRows++;
        continue;
      }

      validRows++;

      // Build normalised row for storage (all valid rows)
      const storedRow: Record<string, string> = { email };
      if (name) storedRow["name"] = name;
      for (const [k, v] of Object.entries(normRow)) {
        if (!EMAIL_ALIASES.has(k) && !NAME_ALIASES.has(k) && v) {
          storedRow[k] = v;
        }
      }
      allRows.push(storedRow);

      if (preview.length < PREVIEW_LIMIT) {
        preview.push({ ...storedRow });
      }
    }

    context.log.info(
      { totalRows: rawRows.length, validRows, invalidRows },
      "parseCsvFile: done",
    );

    return toolSuccess<CsvParseResult>({
      totalRows:   rawRows.length,
      validRows,
      invalidRows,
      columns,
      preview,
      rows: allRows,
    });
  },
};
