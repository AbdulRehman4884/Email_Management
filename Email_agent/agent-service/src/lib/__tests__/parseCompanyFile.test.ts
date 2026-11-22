import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { formatParseReport, normaliseCompanyWebsite, parseCompanyFile } from "../parseCompanyFile.js";

function xlsxBase64(rows: unknown[][], extraSheet?: unknown[][]): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Leads");
  if (extraSheet) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extraSheet), "Other");
  return (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}

function csvBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("parseCompanyFile", () => {
  it("detects columns case-insensitively and keeps other columns as extraFields", () => {
    const result = parseCompanyFile(xlsxBase64([
      ["COMPANY_NAME", "Domain", "Industry", "Contact Name"],
      ["Acme", "acme.com", "Logistics", "Sara Khan"],
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([{
      rowNumber:   2,
      companyName: "Acme",
      website:     "https://acme.com",
      extraFields: { Industry: "Logistics", "Contact Name": "Sara Khan" },
    }]);
  });

  it("reads CSV files too", () => {
    const result = parseCompanyFile(csvBase64("name,url\nBeta Dental,https://www.betadental.com/\n"));
    expect(result.ok && result.rows[0]?.website).toBe("https://www.betadental.com");
  });

  it("keeps UTF-8 Urdu company names in CSV files with or without a BOM", () => {
    const text = "Company Name,Website\nاردو کمپنی,example.info\n";
    const withoutBom = parseCompanyFile(csvBase64(text));
    const withBom = parseCompanyFile(csvBase64(`\uFEFF${text}`));
    expect(withoutBom.ok && withoutBom.rows[0]?.companyName).toBe("اردو کمپنی");
    expect(withBom.ok && withBom.rows[0]?.companyName).toBe("اردو کمپنی");
  });

  it("returns a clear error when the Website column is missing", () => {
    const result = parseCompanyFile(xlsxBase64([["Company", "City"], ["Acme", "Lahore"]]));
    expect(result).toEqual({ ok: false, error: 'The file is missing the required **Website** column. Columns found: "Company", "City". Please rename or add the columns and attach the file again.' });
  });

  it("returns a clear error when the Company column is missing", () => {
    const result = parseCompanyFile(xlsxBase64([["Website"], ["acme.com"]]));
    expect(result.ok).toBe(false);
  });

  it("skips empty/invalid websites, missing names and duplicates, counts and names each (QA P4 bug 29)", () => {
    const result = parseCompanyFile(xlsxBase64([
      ["Company", "Website"],
      ["Acme", "acme.com"],
      ["acme", "https://www.acme.com/"],
      ["Acme Labs", "https://www.acme.com/"],
      ["No Site", ""],
      ["Email Site", "info@acme.com"],
      ["", "nameless.com"],
      ["Beta", "beta.io"],
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A different company at the same website is kept; the same company again is a duplicate.
    expect(result.rows.map((r) => r.companyName)).toEqual(["Acme", "Acme Labs", "Beta"]);
    expect(result.report).toEqual({
      totalRows: 7, validRows: 3, missingWebsite: 1, invalidWebsite: 1, missingCompanyName: 1, duplicates: 1,
    });
    expect(result.skipped).toEqual([
      { rowNumber: 3, companyName: "acme", reason: "duplicate" },
      { rowNumber: 5, companyName: "No Site", reason: "missing website" },
      { rowNumber: 6, companyName: "Email Site", reason: "invalid website" },
      { rowNumber: 7, companyName: "", reason: "missing company name" },
    ]);
  });

  it("uses only the first sheet", () => {
    const result = parseCompanyFile(xlsxBase64(
      [["Company", "Website"], ["Acme", "acme.com"]],
      [["Company", "Website"], ["Ignored", "ignored.com"]],
    ));
    expect(result.ok && result.rows.length).toBe(1);
  });
});

describe("normaliseCompanyWebsite", () => {
  it("accepts bare domains and paths, rejects emails and junk", () => {
    expect(normaliseCompanyWebsite("www.acme.com/about")).toBe("https://www.acme.com/about");
    expect(normaliseCompanyWebsite("http://acme.com")).toBe("http://acme.com");
    expect(normaliseCompanyWebsite("sales@acme.com")).toBeUndefined();
    expect(normaliseCompanyWebsite("n/a")).toBeUndefined();
  });
});

describe("formatParseReport", () => {
  it("matches the planned wording and leaves out zero counts", () => {
    expect(formatParseReport({
      totalRows: 10_000, validRows: 9_640, missingWebsite: 210, invalidWebsite: 0, missingCompanyName: 0, duplicates: 150,
    })).toBe("10,000 rows: 9,640 valid, 210 missing website, 150 duplicate.");
  });
});
