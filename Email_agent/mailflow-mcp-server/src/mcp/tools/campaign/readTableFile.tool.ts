/**
 * src/mcp/tools/campaign/readTableFile.tool.ts
 *
 * Pure in-process tool — does NOT call the MailFlow backend.
 * Reads a base64 CSV / XLSX file as a plain table: every cell of every row, no header
 * handling and no email filter. Used by the chat campaign flow, which works out the
 * meaning of each column itself (files may have no header or unclear headers).
 * XLSX: first non-empty sheet. Limits: MAX_ROWS rows, MAX_COLS columns, MAX_CELL characters per cell.
 */

import { parse as parseCsvSync } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { TOOL_NAMES } from "../../../config/constants.js";
import { ReadTableFileSchema } from "../../../schemas/index.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import { ErrorCode } from "../../../lib/errors.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export const MAX_ROWS = 1000;
const MAX_COLS = 50;
const MAX_CELL = 2000;

export interface TableFileResult {
  /** Every row as cell strings, in file order (the header row too, if there is one). */
  table: string[][];
  /** Rows in the file (before the MAX_ROWS cut). */
  totalRows: number;
  truncated: boolean;
  sheetName?: string;
}

const cell = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CELL);

/** Rows of cells, empty rows dropped. */
export function tableFromBuffer(buffer: Buffer, filename: string): { rows: string[][]; sheetName?: string } {
  let raw: unknown[][];
  let sheetName: string | undefined;
  if (/\.(xlsx|xls)$/i.test(filename)) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    raw = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: false });
      if (rows.length > 0) {
        raw = rows;
        sheetName = name;
        break;
      }
    }
  } else {
    raw = parseCsvSync(buffer, { relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  }
  const rows = raw
    .map((r) => (Array.isArray(r) ? r : []).slice(0, MAX_COLS).map(cell))
    .filter((r) => r.some((c) => c !== ""));
  return sheetName ? { rows, sheetName } : { rows };
}

export const readTableFileTool: McpToolDefinition<typeof ReadTableFileSchema, TableFileResult> = {
  name: TOOL_NAMES.READ_TABLE_FILE,
  description:
    "Reads a base64-encoded CSV or XLSX file as a plain table (every cell of every row, header row included). " +
    "Does not interpret columns and saves nothing. Returns: table, totalRows, truncated.",
  inputSchema: ReadTableFileSchema,
  handler: async (input, context) => {
    try {
      const { rows, sheetName } = tableFromBuffer(Buffer.from(input.fileContent, "base64"), input.filename);
      context.log.info({ filename: input.filename, rows: rows.length }, "readTableFile: done");
      return toolSuccess<TableFileResult>({
        table: rows.slice(0, MAX_ROWS),
        totalRows: rows.length,
        truncated: rows.length > MAX_ROWS,
        ...(sheetName ? { sheetName } : {}),
      });
    } catch (err) {
      context.log.error({ err }, "readTableFile: failed to parse file");
      return toolFailure(ErrorCode.TOOL_VALIDATION_ERROR, "Failed to read the file — make sure it is a valid CSV or Excel file.");
    }
  },
};
