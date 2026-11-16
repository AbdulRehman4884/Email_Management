/**
 * src/schemas/enrichment.schemas.ts
 *
 * Zod input schemas for all enrichment MCP tools.
 *
 * Rules: userId is NEVER a schema field — resolved server-side from the token.
 */

import { z } from "zod";

// ── validate_email ────────────────────────────────────────────────────────────

export const ValidateEmailSchema = z.object({
  email: z.string().min(1, "email is required").trim(),
});
export type ValidateEmailInput = z.infer<typeof ValidateEmailSchema>;

// ── extract_domain ────────────────────────────────────────────────────────────

export const ExtractDomainSchema = z.object({
  input: z
    .string()
    .min(1, "input is required")
    .trim()
    .describe("Email address, URL, or raw domain to extract the domain from"),
});
export type ExtractDomainInput = z.infer<typeof ExtractDomainSchema>;

// ── fetch_website_content ─────────────────────────────────────────────────────

export const FetchWebsiteContentSchema = z.object({
  url: z
    .string()
    .min(1, "url is required")
    .trim()
    .describe("URL of the website to fetch content from (e.g. https://acme.com)"),
  includeSubpages: z.boolean().default(false)
    .describe("Also read the about and services pages and join them with the homepage (up to 16 000 characters)"),
});
export type FetchWebsiteContentInput = z.infer<typeof FetchWebsiteContentSchema>;

// ── enrich_domain ─────────────────────────────────────────────────────────────

export const EnrichDomainSchema = z.object({
  domain: z.string().min(1, "domain is required").trim().toLowerCase(),
});
export type EnrichDomainInput = z.infer<typeof EnrichDomainSchema>;

// ── search_company ────────────────────────────────────────────────────────────

export const SearchCompanySchema = z.object({
  companyName: z.string().min(1, "companyName is required").trim(),
  website: z.string().trim().optional(),
});
export type SearchCompanyInput = z.infer<typeof SearchCompanySchema>;

// ── classify_industry ─────────────────────────────────────────────────────────

export const ClassifyIndustrySchema = z.object({
  companyName:      z.string().trim().optional(),
  websiteText:      z.string().max(4000).trim().optional(),
  domain:           z.string().trim().optional(),
  existingIndustry: z.string().trim().optional(),
});
export type ClassifyIndustryInput = z.infer<typeof ClassifyIndustrySchema>;

// ── score_lead ────────────────────────────────────────────────────────────────

export const ScoreLeadSchema = z.object({
  name:             z.string().trim().optional(),
  email:            z.string().trim().optional(),
  company:          z.string().trim().optional(),
  role:             z.string().trim().optional(),
  industry:         z.string().trim().optional(),
  website:          z.string().trim().optional(),
  hasBusinessEmail: z.boolean().optional(),
});
export type ScoreLeadInput = z.infer<typeof ScoreLeadSchema>;

// ── generate_outreach_template ────────────────────────────────────────────────

export const GenerateOutreachTemplateSchema = z.object({
  campaignId: z
    .string({ required_error: "campaignId is required" })
    .min(1)
    .trim(),
  enrichedSample: z
    .array(z.record(z.unknown()))
    .min(1, "at least one sample contact is required"),
  tone: z
    .enum(["formal", "friendly", "sales-focused", "executive"])
    .default("friendly"),
  customInstructions: z.string().max(2000).trim().optional(),
  cta: z.string().max(500).trim().optional(),
});
export type GenerateOutreachTemplateInput = z.infer<typeof GenerateOutreachTemplateSchema>;

// ── search_company_web ────────────────────────────────────────────────────────

export const SearchCompanyWebSchema = z.object({
  companyName: z.string().min(1, "companyName is required").trim(),
  location:    z.string().trim().optional().describe("City or region (e.g. 'Lahore')"),
  country:     z.string().trim().optional().describe("Country name (e.g. 'Pakistan')"),
  maxResults:  z.coerce.number().int().min(1).max(20).optional().describe("Max candidates to return (default 8)"),
});
export type SearchCompanyWebInput = z.infer<typeof SearchCompanyWebSchema>;

// ── CandidateWebsite (shared shape used by select_official_website input) ─────

export const CandidateWebsiteSchema = z.object({
  title:   z.string(),
  url:     z.string().url("candidate url must be a valid URL"),
  snippet: z.string().default(""),
});

// ── select_official_website ───────────────────────────────────────────────────

export const SelectOfficialWebsiteSchema = z.object({
  companyName: z.string().min(1, "companyName is required").trim(),
  candidates:  z.array(CandidateWebsiteSchema).min(1, "at least one candidate is required"),
  location:    z.string().trim().optional(),
  country:     z.string().trim().optional(),
});
export type SelectOfficialWebsiteInput = z.infer<typeof SelectOfficialWebsiteSchema>;

// ── verify_company_website ────────────────────────────────────────────────────

export const VerifyCompanyWebsiteSchema = z.object({
  companyName:    z.string().min(1, "companyName is required").trim(),
  url:            z.string().url("url must be a valid URL"),
  websiteContent: z.string().max(8000).trim().optional(),
  title:          z.string().trim().optional(),
  snippet:        z.string().trim().optional(),
});
export type VerifyCompanyWebsiteInput = z.infer<typeof VerifyCompanyWebsiteSchema>;

// ── extract_company_profile ───────────────────────────────────────────────────

export const ExtractCompanyProfileSchema = z.object({
  companyName:    z.string().min(1, "companyName is required").trim(),
  sourceUrl:      z.string().url("sourceUrl must be a valid URL"),
  websiteContent: z.string().min(1, "websiteContent is required").max(80_000).trim()
    .describe("Raw website text fetched by fetch_website_content. Trimmed to 8 000 chars before AI call."),
});
export type ExtractCompanyProfileInput = z.infer<typeof ExtractCompanyProfileSchema>;

// ── detect_pain_points ────────────────────────────────────────────────────────

export const DetectPainPointsSchema = z.object({
  companyName:    z.string().min(1, "companyName is required").trim(),
  websiteContent: z.string().min(1, "websiteContent is required").max(80_000).trim(),
  industry:       z.string().trim().optional()
    .describe("Industry hint from classify_industry or extract_company_profile"),
  businessSummary: z.string().trim().optional()
    .describe("Business summary hint to improve pain-point inference"),
});
export type DetectPainPointsInput = z.infer<typeof DetectPainPointsSchema>;

// ── generate_outreach_draft ───────────────────────────────────────────────────

const PainPointInputSchema = z.object({
  title:       z.string().trim(),
  description: z.string().trim(),
  confidence:  z.enum(["high", "medium", "low"]).optional(),
});

export const GenerateOutreachDraftSchema = z.object({
  companyName:     z.string().min(1, "companyName is required").trim(),
  industry:        z.string().trim().default("Unknown"),
  painPoints:      z.array(PainPointInputSchema).max(6).default([]),
  businessSummary: z.string().trim().optional(),
  tone:            z.enum(["executive", "consultative", "friendly", "direct", "professional"])
    .default("professional"),
});
export type GenerateOutreachDraftInput = z.infer<typeof GenerateOutreachDraftSchema>;

// ── save_enriched_contacts ────────────────────────────────────────────────────

export const SaveEnrichedContactsSchema = z.object({
  campaignId: z
    .string({ required_error: "campaignId is required" })
    .min(1)
    .trim(),
  contacts: z
    .array(z.record(z.unknown()))
    .min(1, "contacts must contain at least one entry"),
});
export type SaveEnrichedContactsInput = z.infer<typeof SaveEnrichedContactsSchema>;

// ── generate_outreach_script ──────────────────────────────────────────────────

export const SCRIPT_TYPES = ["cold_email", "cold_call", "linkedin"] as const;
export const ScriptTypeSchema = z.enum(SCRIPT_TYPES);
export type ScriptType = z.infer<typeof ScriptTypeSchema>;

export const GenerateOutreachScriptSchema = z.object({
  scriptType:     ScriptTypeSchema
    .describe("cold_email (medium, with subject), cold_call (long, spoken) or linkedin (short)"),
  companyName:    z.string().min(1, "companyName is required").max(255).trim(),
  website:        z.string().min(1, "website is required").max(500).trim(),
  websiteContent: z.string().max(80_000).trim().default("")
    .describe("Raw website text fetched by fetch_website_content. Trimmed before the AI call."),
  extraFields:    z.record(z.string().max(500)).optional()
    .describe("Other columns from the uploaded file (industry, contact name, city…) used as context"),
  userInstructions: z.string().max(500).trim().optional()
    .describe("User's prompt. May change focus and tone only — never the rules."),
});
export type GenerateOutreachScriptInput = z.infer<typeof GenerateOutreachScriptSchema>;

// ── save_script_file ──────────────────────────────────────────────────────────

const ScriptFileCompanySchema = z.object({
  rowNumber:   z.number().int().min(1),
  companyName: z.string().min(1).max(255).trim(),
  website:     z.string().min(1).max(500).trim(),
  extraFields: z.record(z.string().max(500)).default({}),
});

export const SaveScriptFileSchema = z.object({
  filename:         z.string().min(1).max(255).trim(),
  userInstructions: z.string().max(500).trim().optional(),
  report:           z.record(z.number()),
  companies:        z.array(ScriptFileCompanySchema).min(1, "at least one company is required").max(50_000),
});
export type SaveScriptFileInput = z.infer<typeof SaveScriptFileSchema>;

// ── get_script_company ────────────────────────────────────────────────────────

export const GetScriptCompanySchema = z.object({
  companyId:      z.coerce.number().int().positive(),
  includeContent: z.boolean().default(false)
    .describe("Also return the cached website text (used before generating a script)"),
});
export type GetScriptCompanyInput = z.infer<typeof GetScriptCompanySchema>;

// ── save_company_script ───────────────────────────────────────────────────────

export const SaveCompanyScriptSchema = z.object({
  companyId:           z.coerce.number().int().positive(),
  scriptType:          ScriptTypeSchema,
  status:              z.enum(["ok", "insufficient_data"]),
  angle:               z.enum(["website", "industry"]).default("website")
    .describe("website = problem seen on their site; industry = best-guess from their industry"),
  whatTheySell:        z.string().max(2000).default(""),
  problemStatement:    z.string().max(2000).default(""),
  painPoints:          z.array(z.string().max(1000)).max(10).default([]),
  recommendedServices: z.array(z.string().max(100)).max(2).default([]),
  subject:             z.string().max(255).optional(),
  script:              z.string().max(10_000).default(""),
  wordCount:           z.number().int().min(0).default(0),
  websiteContent:      z.string().max(80_000).optional()
    .describe("Website text to cache on the company so later scripts skip the fetch"),
});
export type SaveCompanyScriptInput = z.infer<typeof SaveCompanyScriptSchema>;
