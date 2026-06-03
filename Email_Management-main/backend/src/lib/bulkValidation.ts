export interface BulkLeadInput {
  rowNumber: number;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  website?: string | null;
  role?: string | null;
  industry?: string | null;
}

export interface BulkLeadRow extends Required<BulkLeadInput> {
  normalizedEmail: string;
  normalizedWebsite: string;
  errors: string[];
  duplicate: boolean;
  valid: boolean;
}

export interface BulkValidationResult {
  rows: BulkLeadRow[];
  validRows: BulkLeadRow[];
  invalidRows: BulkLeadRow[];
  duplicates: BulkLeadRow[];
  summary: {
    totalRows: number;
    valid: number;
    duplicates: number;
    invalid: number;
    missingCompany: number;
    missingWebsite: number;
    invalidEmail: number;
    invalidDomain: number;
  };
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeBulkWebsite(value: string | null | undefined): string {
  const raw = String(value ?? "").trim().replace(/[>,.;)\]}]+$/g, "");
  if (!raw) return "";

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!url.hostname.includes(".")) return "";
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.protocol = "https:";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/g, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function validateBulkRows(inputRows: BulkLeadInput[]): BulkValidationResult {
  const seenEmails = new Set<string>();
  const seenCompanies = new Set<string>();
  const rows: BulkLeadRow[] = [];

  for (const input of inputRows) {
    const email = clean(input.email).toLowerCase();
    const company = clean(input.company);
    const website = clean(input.website);
    const normalizedWebsite = normalizeBulkWebsite(website);
    const companyKey = company.toLowerCase();
    const errors: string[] = [];

    if (!email || !EMAIL_REGEX.test(email)) errors.push("invalid_email");
    if (!company) errors.push("missing_company");
    if (!website) errors.push("missing_website");
    if (website && !normalizedWebsite) errors.push("invalid_domain");

    const duplicateEmail = email ? seenEmails.has(email) : false;
    const duplicateCompany = companyKey ? seenCompanies.has(companyKey) : false;
    const duplicate = duplicateEmail || duplicateCompany;
    if (duplicate) errors.push(duplicateEmail ? "duplicate_email" : "duplicate_company");

    if (email) seenEmails.add(email);
    if (companyKey) seenCompanies.add(companyKey);

    rows.push({
      rowNumber: input.rowNumber,
      name: clean(input.name),
      email,
      company,
      website,
      role: clean(input.role),
      industry: clean(input.industry),
      normalizedEmail: email,
      normalizedWebsite,
      errors,
      duplicate,
      valid: errors.length === 0,
    });
  }

  const validRows = rows.filter((row) => row.valid);
  const invalidRows = rows.filter((row) => !row.valid && !row.duplicate);
  const duplicates = rows.filter((row) => row.duplicate);
  const countError = (code: string) => rows.filter((row) => row.errors.includes(code)).length;

  return {
    rows,
    validRows,
    invalidRows,
    duplicates,
    summary: {
      totalRows: rows.length,
      valid: validRows.length,
      duplicates: duplicates.length,
      invalid: invalidRows.length,
      missingCompany: countError("missing_company"),
      missingWebsite: countError("missing_website"),
      invalidEmail: countError("invalid_email"),
      invalidDomain: countError("invalid_domain"),
    },
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}
