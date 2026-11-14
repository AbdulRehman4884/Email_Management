import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { readTableFileTool } from "../../mcp/tools/campaign/readTableFile.tool.js";
import { toScheduleWallClock } from "../../lib/scheduleTime.js";
import { createMockToolContext } from "../helpers.js";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("read_table_file", () => {
  it("returns every cell of every row, header row included, uneven rows allowed", async () => {
    const csv = "Acme,needs react https://upwork.com/jobs/1,ali@acme.com\nBeta,,sara@beta.io,extra\n,,\n";
    const result = await readTableFileTool.handler({ fileContent: b64(csv), filename: "leads.csv" }, createMockToolContext());
    expect(result).toEqual({
      success: true,
      data: {
        table: [
          ["Acme", "needs react https://upwork.com/jobs/1", "ali@acme.com"],
          ["Beta", "", "sara@beta.io", "extra"],
        ],
        totalRows: 2,
        truncated: false,
      },
    });
  });

  it("reads the first non-empty Excel sheet", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), "Empty");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Email", "Site"], ["a@b.com", "b.com"]]), "Leads");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const result = await readTableFileTool.handler({ fileContent: buffer.toString("base64"), filename: "leads.xlsx" }, createMockToolContext());
    expect(result).toMatchObject({ success: true, data: { table: [["Email", "Site"], ["a@b.com", "b.com"]], sheetName: "Leads" } });
  });
});

describe("schedule time for the backend", () => {
  it("ISO with an offset becomes the backend's wall clock", () => {
    expect(toScheduleWallClock("2026-11-12T05:00:00.000Z", "Asia/Karachi")).toBe("2026-11-12 10:00:00");
    expect(toScheduleWallClock("2026-11-12T10:00:00+05:00", "Asia/Karachi")).toBe("2026-11-12 10:00:00");
  });
});
