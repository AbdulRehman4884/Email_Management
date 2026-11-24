import { describe, expect, it } from "vitest";
import { parseCsvFileTool } from "../../mcp/tools/campaign/parseCsvFile.tool.js";
import { createMockToolContext } from "../helpers.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("parse_csv_file", () => {
  it("deduplicates email addresses without regard to case", async () => {
    const result = await parseCsvFileTool.handler({
      fileContent: b64("email,name\nqa.one@example.com,One\nqa.two@example.com,Two\nQA.ONE@example.com,Duplicate\n"),
      filename: "recipients.csv",
    }, createMockToolContext());
    expect(result).toMatchObject({
      success: true,
      data: { totalRows: 3, validRows: 2, invalidRows: 0, duplicateRows: 1 },
    });
    if (result.success) expect(result.data.rows.map((row) => row.email)).toEqual(["qa.one@example.com", "qa.two@example.com"]);
  });

  it("removes a UTF-8 BOM from the header", async () => {
    const result = await parseCsvFileTool.handler({
      fileContent: b64("\uFEFFemail,name\na@example.com,A\n"),
      filename: "recipients.csv",
    }, createMockToolContext());
    expect(result).toMatchObject({ success: true, data: { columns: ["email", "name"], validRows: 1 } });
  });
});
