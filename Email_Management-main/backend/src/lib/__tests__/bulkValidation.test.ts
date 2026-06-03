import { describe, expect, it } from "vitest";
import { normalizeBulkWebsite, validateBulkRows } from "../bulkValidation.js";

describe("bulkValidation", () => {
  it("validates emails, domains, missing fields, and duplicates", () => {
    const result = validateBulkRows([
      { rowNumber: 2, name: "A", email: "a@example.com", company: "Acme", website: "acme.com" },
      { rowNumber: 3, name: "B", email: "bad", company: "Beta", website: "https://beta.com" },
      { rowNumber: 4, name: "C", email: "c@example.com", company: "", website: "" },
      { rowNumber: 5, name: "D", email: "a@example.com", company: "Delta", website: "delta.com" },
      { rowNumber: 6, name: "E", email: "e@example.com", company: "Acme", website: "acme.co" },
    ]);

    expect(result.summary.totalRows).toBe(5);
    expect(result.summary.valid).toBe(1);
    expect(result.summary.invalid).toBe(2);
    expect(result.summary.duplicates).toBe(2);
    expect(result.summary.invalidEmail).toBe(1);
    expect(result.summary.missingCompany).toBe(1);
    expect(result.summary.missingWebsite).toBe(1);
  });

  it("normalizes supported company websites", () => {
    expect(normalizeBulkWebsite("example.com/path/")).toBe("https://example.com/path");
    expect(normalizeBulkWebsite("https://www.example.com?q=1")).toBe("https://www.example.com");
    expect(normalizeBulkWebsite("localhost")).toBe("");
  });
});
