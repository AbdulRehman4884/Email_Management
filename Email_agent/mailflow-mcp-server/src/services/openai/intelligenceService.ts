/**
 * src/services/openai/intelligenceService.ts
 *
 * OpenAI-powered company intelligence service for Phase 3 enrichment.
 *
 * Responsibilities:
 *   - Extract structured company profiles from raw website content
 *   - Detect pain points and business needs from website messaging
 *   - Generate targeted outreach drafts grounded in real company context
 *
 * Design rules:
 *   - All prompts use response_format: json_object — no free-text escaping
 *   - Website content is trimmed to MAX_CONTENT_CHARS before every call
 *   - OpenAI timeout: 15 s (AbortSignal + Promise.race)
 *   - If OPENAI_API_KEY is absent the factory returns undefined; tools degrade gracefully
 *   - No hallucinated facts — prompts explicitly forbid invented company data
 *   - No raw OpenAI responses ever returned to callers; every path validates the JSON
 */

import OpenAI from "openai";
import { env } from "../../config/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("service:intelligence");

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CONTENT_CHARS = 8_000;
const OPENAI_TIMEOUT_MS = 15_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface PainPoint {
  title:       string;
  description: string;
  confidence:  "high" | "medium" | "low";
}

export interface CompanyProfileResult {
  /** Brief summary of what the company does (1-2 sentences). */
  businessSummary:      string | null;
  /** Main products or services offered (up to 5). */
  productsServices:     string[];
  /** Primary target customer segment. */
  targetCustomers:      string | null;
  /** Rough size estimate: "startup" | "smb" | "mid-market" | "enterprise" | "unknown" */
  companySizeEstimate:  "startup" | "smb" | "mid-market" | "enterprise" | "unknown";
  /** Geographic focus of the business. */
  geographicFocus:      string | null;
  /** Technology signals detected (CRM, analytics tools, frameworks, etc.). */
  techIndicators:       string[];
  /** How ready the company appears for AI adoption. */
  aiReadiness:          "high" | "medium" | "low";
  /** Industry (heuristic or AI-classified). */
  industry:             string;
  /** Sub-industry or vertical if detectable. */
  subIndustry:          string | null;
  /** Detected pain points inferred from website messaging. */
  painPoints:           PainPoint[];
  /** Lead quality score 0-100. */
  score:                number;
  /** Lead quality category. */
  category:             "hot" | "warm" | "cold";
  /** Reasons contributing to the lead score. */
  scoreReasons:         string[];
  /** Primary recommended outreach angle. */
  primaryAngle:         string;
  /** Supporting outreach angle. */
  secondaryAngle:       string | null;
  /** Recommended communication tone. */
  recommendedTone:      string;
  /** Conversation hooks to mention in outreach. */
  hooks:                string[];
  /** Which MailFlow services fit best. */
  serviceFit:           string;
  /** Ready-to-send email subject line. */
  emailSubject:         string;
  /** Ready-to-send email body (plain text, ≤ 200 words). */
  emailBody:            string;
  /** Whether AI analysis ran (false = fallback only). */
  aiGenerated:          boolean;
  /** AI confidence in the analysis, 0-100. */
  confidence:           number;
}

export interface PainPointsResult {
  painPoints:   PainPoint[];
  aiGenerated:  boolean;
}

export interface OutreachDraftResult {
  subject:              string;
  emailBody:            string;
  tone:                 string;
  personalizationUsed:  string[];
  aiGenerated:          boolean;
}

// ── Error type ────────────────────────────────────────────────────────────────

export class IntelligenceServiceError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "IntelligenceServiceError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trimContent(content: string): string {
  return content.length > MAX_CONTENT_CHARS
    ? content.slice(0, MAX_CONTENT_CHARS) + "\n[content trimmed]"
    : content;
}

async function callOpenAIWithTimeout(
  client: OpenAI,
  model: string,
  prompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const completion = await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      },
      { signal: controller.signal },
    );
    return completion.choices[0]?.message?.content ?? "{}";
  } finally {
    clearTimeout(timer);
  }
}

// ── Fallbacks ─────────────────────────────────────────────────────────────────

export function fallbackProfile(companyName: string): CompanyProfileResult {
  return {
    businessSummary:     null,
    productsServices:    [],
    targetCustomers:     null,
    companySizeEstimate: "unknown",
    geographicFocus:     null,
    techIndicators:      [],
    aiReadiness:         "low",
    industry:            "Unknown",
    subIndustry:         null,
    painPoints:          [],
    score:               20,
    category:            "cold",
    scoreReasons:        ["Insufficient website data for scoring"],
    primaryAngle:        `Help ${companyName} grow with AI-powered email outreach`,
    secondaryAngle:      null,
    recommendedTone:     "professional",
    hooks:               [],
    serviceFit:          "Email marketing automation",
    emailSubject:        `Quick question for ${companyName}`,
    emailBody:           `Hi,\n\nI came across ${companyName} and wanted to reach out about how we help businesses like yours with AI-powered email marketing.\n\nWould you be open to a quick chat?\n\nBest regards`,
    aiGenerated:         false,
    confidence:          0,
  };
}

function fallbackPainPoints(): PainPointsResult {
  return { painPoints: [], aiGenerated: false };
}

function fallbackDraft(companyName: string, tone: string): OutreachDraftResult {
  return {
    subject:             `Quick question for ${companyName}`,
    emailBody:           `Hi,\n\nI wanted to reach out to ${companyName} about how we can help streamline your outbound email efforts.\n\nWould you have 15 minutes for a quick chat?\n\nBest regards`,
    tone,
    personalizationUsed: [],
    aiGenerated:         false,
  };
}

// ── Safe JSON parse ───────────────────────────────────────────────────────────

function safeParseObj(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; }
  catch { return {}; }
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function getStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key];
  return typeof v === "number" && isFinite(v) ? Math.round(v) : fallback;
}

function parsePainPoints(obj: Record<string, unknown>): PainPoint[] {
  const raw = obj["painPoints"];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const p = item as Record<string, unknown>;
    const title       = getString(p, "title");
    const description = getString(p, "description");
    if (!title || !description) return [];
    const conf = getString(p, "confidence");
    const confidence: PainPoint["confidence"] =
      conf === "high" || conf === "medium" || conf === "low" ? conf : "medium";
    return [{ title, description, confidence }] as PainPoint[];
  });
}

// ── Service ───────────────────────────────────────────────────────────────────

export class IntelligenceService {
  private readonly client: OpenAI;
  private readonly model:  string;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
    this.model  = env.OPENAI_MODEL;
    log.info({ model: this.model }, "IntelligenceService initialised");
  }

  // ── Full Company Profile Analysis ─────────────────────────────────────────────

  /**
   * Extracts a complete company intelligence profile from website content.
   * One OpenAI call produces: profile, industry, pain points, lead score,
   * outreach angle, and email draft.
   *
   * Returns a graceful fallback if AI fails or content is too short.
   */
  async extractCompanyProfile(
    companyName: string,
    sourceUrl:     string,
    websiteContent: string,
  ): Promise<CompanyProfileResult> {
    const content = trimContent(websiteContent);

    if (content.trim().length < 50) {
      log.warn({ companyName }, "extractCompanyProfile: website content too short — using fallback");
      return fallbackProfile(companyName);
    }

    const prompt = this.buildProfilePrompt(companyName, sourceUrl, content);

    try {
      const raw     = await callOpenAIWithTimeout(this.client, this.model, prompt);
      const obj     = safeParseObj(raw);
      const profile = this.parseProfileResponse(companyName, obj);
      log.info({ companyName, score: profile.score, industry: profile.industry }, "extractCompanyProfile: success");
      return profile;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      log.warn({ companyName, error: msg }, "extractCompanyProfile: AI call failed — using fallback");
      return fallbackProfile(companyName);
    }
  }

  // ── Pain Point Detection ──────────────────────────────────────────────────────

  async detectPainPoints(
    companyName:    string,
    websiteContent: string,
    industry?:      string,
  ): Promise<PainPointsResult> {
    const content = trimContent(websiteContent);

    if (content.trim().length < 50) {
      log.warn({ companyName }, "detectPainPoints: content too short — empty result");
      return fallbackPainPoints();
    }

    const prompt = this.buildPainPointsPrompt(companyName, content, industry);

    try {
      const raw  = await callOpenAIWithTimeout(this.client, this.model, prompt);
      const obj  = safeParseObj(raw);
      const pts  = parsePainPoints(obj);
      log.info({ companyName, count: pts.length }, "detectPainPoints: success");
      return { painPoints: pts, aiGenerated: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      log.warn({ companyName, error: msg }, "detectPainPoints: AI call failed — empty result");
      return fallbackPainPoints();
    }
  }

  // ── Outreach Draft Generation ─────────────────────────────────────────────────

  async generateOutreachDraft(
    companyName:     string,
    industry:        string,
    painPoints:      PainPoint[],
    businessSummary: string | null,
    tone:            string = "professional",
  ): Promise<OutreachDraftResult> {
    if (!companyName.trim()) {
      return fallbackDraft(companyName, tone);
    }

    const prompt = this.buildDraftPrompt(companyName, industry, painPoints, businessSummary, tone);

    try {
      const raw = await callOpenAIWithTimeout(this.client, this.model, prompt);
      const obj = safeParseObj(raw);

      const subject = getString(obj, "subject") ?? `Quick question for ${companyName}`;
      const body    = getString(obj, "emailBody") ?? getString(obj, "body") ?? fallbackDraft(companyName, tone).emailBody;
      const detectedTone = getString(obj, "tone") ?? tone;
      const perso   = getStringArray(obj, "personalizationUsed");

      log.info({ companyName }, "generateOutreachDraft: success");
      return { subject, emailBody: body, tone: detectedTone, personalizationUsed: perso, aiGenerated: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      log.warn({ companyName, error: msg }, "generateOutreachDraft: AI call failed — fallback");
      return fallbackDraft(companyName, tone);
    }
  }

  // ── Prompt builders ───────────────────────────────────────────────────────────

  private buildProfilePrompt(
    companyName: string,
    sourceUrl:   string,
    content:     string,
  ): string {
    return [
      "You are a B2B sales intelligence analyst. Analyse the website content below and return a JSON object.",
      "",
      "STRICT RULES:",
      "  - Extract ONLY from the provided content. Do NOT invent funding rounds, employee counts, or news.",
      "  - If information is unclear, use null for string fields and empty arrays for lists.",
      "  - Never hallucinate facts about the company.",
      "  - emailBody must be plain text, ≤ 200 words, human-sounding, no spam language.",
      "",
      `Company name: ${companyName}`,
      `Website URL:  ${sourceUrl}`,
      "",
      "Website content:",
      content,
      "",
      "Return ONLY a JSON object with EXACTLY these keys (no extras, no markdown):",
      "{",
      '  "businessSummary":     "<1-2 sentences>",',
      '  "productsServices":    ["<service1>", "..."],',
      '  "targetCustomers":     "<who they serve>",',
      '  "companySizeEstimate": "startup|smb|mid-market|enterprise|unknown",',
      '  "geographicFocus":     "<country/region or null>",',
      '  "techIndicators":      ["<tech1>", "..."],',
      '  "aiReadiness":         "high|medium|low",',
      '  "industry":            "<industry>",',
      '  "subIndustry":         "<sub-industry or null>",',
      '  "painPoints": [',
      '    { "title": "<short title>", "description": "<1-2 sentences from site evidence>", "confidence": "high|medium|low" }',
      "  ],",
      '  "score":         <integer 0-100>,',
      '  "category":      "hot|warm|cold",',
      '  "scoreReasons":  ["<reason1>", "..."],',
      '  "primaryAngle":  "<main outreach angle>",',
      '  "secondaryAngle": "<supporting angle or null>",',
      '  "recommendedTone": "<executive|consultative|friendly|direct>",',
      '  "hooks":         ["<hook1>", "..."],',
      '  "serviceFit":    "<which MailFlow services fit best>",',
      '  "emailSubject":  "<compelling subject line ≤ 60 chars>",',
      '  "emailBody":     "<plain text email body, 3-4 short paragraphs, ≤ 200 words>",',
      '  "confidence":    <integer 0-100>',
      "}",
      "",
      "Scoring guidance:",
      "  - score 70-100 (hot):  clear business email, active website, specific pain points, good AI fit",
      "  - score 40-69 (warm):  some signals present but incomplete",
      "  - score 0-39 (cold):   weak website, no clear pain points, low AI relevance",
      "",
      "Return ONLY valid JSON — no markdown fences, no preamble.",
    ].join("\n");
  }

  private buildPainPointsPrompt(
    companyName: string,
    content:     string,
    industry?:   string,
  ): string {
    return [
      "You are a B2B sales analyst. Identify pain points from the company website content below.",
      "",
      "STRICT RULES:",
      "  - Infer pain points ONLY from: website messaging, missing capabilities, company type, and maturity signals.",
      "  - Do NOT invent pain points not supported by the content.",
      "  - Each pain point must have a specific title, description with evidence from the site, and confidence.",
      "",
      `Company: ${companyName}`,
      ...(industry ? [`Industry: ${industry}`] : []),
      "",
      "Website content:",
      content,
      "",
      "Return ONLY a JSON object:",
      "{",
      '  "painPoints": [',
      '    {',
      '      "title":       "<concise pain point title>",',
      '      "description": "<what you observed on the site that signals this need>",',
      '      "confidence":  "high|medium|low"',
      '    }',
      "  ]",
      "}",
      "",
      "Return 3-6 pain points. If content is insufficient, return fewer. Return ONLY valid JSON.",
    ].join("\n");
  }

  private buildDraftPrompt(
    companyName:     string,
    industry:        string,
    painPoints:      PainPoint[],
    businessSummary: string | null,
    tone:            string,
  ): string {
    const painPointList = painPoints
      .slice(0, 3)
      .map((p) => `  - ${p.title}: ${p.description}`)
      .join("\n");

    return [
      "You are a senior SDR writing a first outreach email. Generate a concise, professional email.",
      "",
      "STRICT RULES:",
      "  - Under 200 words total.",
      "  - Human-sounding — no spam trigger words.",
      "  - Mention ONLY facts from the company context below — no invented claims.",
      "  - Clear, single CTA at the end.",
      "  - No 'I hope this email finds you well' or similar filler.",
      "",
      `Company: ${companyName}`,
      `Industry: ${industry}`,
      `Tone: ${tone}`,
      ...(businessSummary ? [`Business summary: ${businessSummary}`] : []),
      ...(painPointList ? ["", "Detected needs:", painPointList] : []),
      "",
      "Return ONLY a JSON object:",
      "{",
      '  "subject":             "<email subject ≤ 60 chars>",',
      '  "emailBody":           "<plain text body, 3-4 paragraphs, ≤ 200 words>",',
      '  "tone":                "<tone used>",',
      '  "personalizationUsed": ["<what you personalized — e.g. industry, specific pain point>"]',
      "}",
      "",
      "Return ONLY valid JSON — no markdown fences.",
    ].join("\n");
  }

  // ── Response parser ───────────────────────────────────────────────────────────

  private parseProfileResponse(
    companyName: string,
    obj: Record<string, unknown>,
  ): CompanyProfileResult {
    const sizeRaw = getString(obj, "companySizeEstimate");
    const companySizeEstimate: CompanyProfileResult["companySizeEstimate"] =
      sizeRaw === "startup" || sizeRaw === "smb" ||
      sizeRaw === "mid-market" || sizeRaw === "enterprise"
        ? sizeRaw : "unknown";

    const aiReadinessRaw = getString(obj, "aiReadiness");
    const aiReadiness: CompanyProfileResult["aiReadiness"] =
      aiReadinessRaw === "high" || aiReadinessRaw === "medium" ? aiReadinessRaw : "low";

    const rawScore = getNumber(obj, "score", 20);
    const score    = Math.min(100, Math.max(0, rawScore));
    const catRaw   = getString(obj, "category");
    const category: CompanyProfileResult["category"] =
      catRaw === "hot" || catRaw === "warm" ? catRaw : "cold";

    const emailBody = getString(obj, "emailBody") ?? fallbackProfile(companyName).emailBody;

    return {
      businessSummary:     getString(obj, "businessSummary"),
      productsServices:    getStringArray(obj, "productsServices"),
      targetCustomers:     getString(obj, "targetCustomers"),
      companySizeEstimate,
      geographicFocus:     getString(obj, "geographicFocus"),
      techIndicators:      getStringArray(obj, "techIndicators"),
      aiReadiness,
      industry:            getString(obj, "industry") ?? "Unknown",
      subIndustry:         getString(obj, "subIndustry"),
      painPoints:          parsePainPoints(obj),
      score,
      category,
      scoreReasons:        getStringArray(obj, "scoreReasons"),
      primaryAngle:        getString(obj, "primaryAngle") ?? `Help ${companyName} grow`,
      secondaryAngle:      getString(obj, "secondaryAngle"),
      recommendedTone:     getString(obj, "recommendedTone") ?? "professional",
      hooks:               getStringArray(obj, "hooks"),
      serviceFit:          getString(obj, "serviceFit") ?? "Email marketing automation",
      emailSubject:        getString(obj, "emailSubject") ?? `Quick question for ${companyName}`,
      emailBody,
      aiGenerated:         true,
      confidence:          getNumber(obj, "confidence", 50),
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: IntelligenceService | undefined;

/**
 * Returns the IntelligenceService singleton, or `undefined` when
 * OPENAI_API_KEY is not configured. Callers must handle the `undefined`
 * case and return a graceful fallback — no error is thrown.
 */
export function getIntelligenceService(): IntelligenceService | undefined {
  if (!env.OPENAI_API_KEY) return undefined;
  if (!_instance) _instance = new IntelligenceService(env.OPENAI_API_KEY);
  return _instance;
}
