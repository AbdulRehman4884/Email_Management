import { describe, expect, it } from "vitest";
import { parseManualBulkRows } from "../parseManualBulkRows.js";

describe("parseManualBulkRows", () => {
  it("parses numbered slash-separated rows", () => {
    const rows = parseManualBulkRows([
      "1. Systems Limited / https://www.systemsltd.com / test1@example.com",
      "2. NETSOL Technologies / https://www.netsoltech.com / test2@example.com",
    ].join("\n"));

    expect(rows).toEqual([
      { company: "Systems Limited", website: "https://www.systemsltd.com", email: "test1@example.com" },
      { company: "NETSOL Technologies", website: "https://www.netsoltech.com", email: "test2@example.com" },
    ]);
  });

  it("parses comma-separated rows", () => {
    const rows = parseManualBulkRows("Systems Limited, https://www.systemsltd.com, test1@example.com");

    expect(rows).toEqual([
      { company: "Systems Limited", website: "https://www.systemsltd.com", email: "test1@example.com" },
    ]);
  });

  it("parses pipe-separated rows", () => {
    const rows = parseManualBulkRows("Systems Limited | https://www.systemsltd.com | test1@example.com");

    expect(rows).toEqual([
      { company: "Systems Limited", website: "https://www.systemsltd.com", email: "test1@example.com" },
    ]);
  });

  it("parses markdown mailto links", () => {
    const rows = parseManualBulkRows("1. Systems Limited / https://www.systemsltd.com / [test1@example.com](mailto:test1@example.com)");

    expect(rows).toEqual([
      { company: "Systems Limited", website: "https://www.systemsltd.com", email: "test1@example.com" },
    ]);
  });

  it("ignores unrelated and invalid rows while preserving valid rows", () => {
    const rows = parseManualBulkRows([
      "Here are the rows:",
      "Systems Limited / https://www.systemsltd.com / test1@example.com",
      "Missing email / https://example.com",
      "Malformed email / https://example.com / not-an-email",
      "Bad website / ftp://example.com / test2@example.com",
    ].join("\n"));

    expect(rows).toEqual([
      { company: "Systems Limited", website: "https://www.systemsltd.com", email: "test1@example.com" },
    ]);
  });

  it("returns an empty array for empty or malformed input", () => {
    expect(parseManualBulkRows("")).toEqual([]);
    expect(parseManualBulkRows("Company / website / email")).toEqual([]);
  });
});
