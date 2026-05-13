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
