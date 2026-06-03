import { describe, expect, it } from "vitest";
import {
  classifyIndustryGroup,
  normalizeTemplateStrategy,
  recommendTemplateForGroup,
  resolveTemplateForIndustry,
  sanitizeBulkTemplateContent,
  templateGuidance,
  templateOptions,
} from "../templateInjectionEngine.js";
import { generateExecutiveTemplate } from "../bulkProcessingQueue.js";

describe("Phase 5.4 template selection and injection", () => {
  it("exposes the required template categories", () => {
    const options = templateOptions();
    expect(options).toHaveLength(10);
    expect(options.map((option) => option.id)).toContain("fintech_compliance");
    expect(options.map((option) => option.id)).toContain("enterprise_transformation");
  });

  it("classifies rows and inherits category template selections", () => {
    const strategy = normalizeTemplateStrategy({
      globalTemplate: "executive_consultative",
      globalTone: "professional_soft",
      globalCTAStyle: "strategic_review",
      industryTemplateMap: {
        enterprise_it: "enterprise_transformation",
        fintech: "fintech_compliance",
      },
    });

    expect(classifyIndustryGroup("enterprise IT cloud ERP services")).toBe("enterprise_it");
    expect(classifyIndustryGroup("lending fintech platform")).toBe("fintech");
    expect(resolveTemplateForIndustry("lending fintech platform", strategy)).toBe("fintech_compliance");
    expect(resolveTemplateForIndustry("unknown category", strategy)).toBe("executive_consultative");
  });

  it("injects selected template metadata into generated row templates", () => {
    const template = generateExecutiveTemplate({
      name: "Ali Khan",
      email: "ali@netsoltech.com",
      company: "NETSOL Technologies",
      website: "https://www.netsoltech.com",
      role: "Director Finance Operations",
      industry: "fintech and lending platform",
      services: ["lending platform"],
      signals: ["finance visibility need"],
      confidence: 0.84,
      strategy: normalizeTemplateStrategy({
        globalTemplate: "executive_consultative",
        globalTone: "professional_soft",
        globalCTAStyle: "strategic_review",
        industryTemplateMap: { fintech: "fintech_compliance" },
      }),
    });

    expect(template.selectedTemplateId).toBe("fintech_compliance");
    expect(template.templateName).toMatch(/Fintech/i);
    expect(template.subject).toMatch(/lending|buyer|platform|coordination/i);
    expect(template.body).toMatch(/lending|finance|compliance|workflow/i);
    expect(template.status).toBe("pending_review");
  });

  it("keeps unknown rows on global fallback without unresolved placeholders", () => {
    const template = generateExecutiveTemplate({
      name: "",
      email: "ops@example.com",
      company: "Example Co",
      website: "",
      role: "",
      industry: "unknown",
      services: [],
      signals: [],
      confidence: 0.52,
      strategy: normalizeTemplateStrategy({ globalTemplate: "soft_relationship" }),
    });

    expect(template.selectedTemplateId).toBe("soft_relationship");
    expect(`${template.subject}\n${template.body}\n${template.followup1}\n${template.followup2}`).not.toMatch(/{{first_name}}|{{sender_name}}|\[|\]/);
    expect(template.missingDataWarnings).toContain("missing_website");
  });

  it("sanitizes sender_name and reports unsupported placeholders before campaign draft creation", () => {
    const sanitized = sanitizeBulkTemplateContent({
      subject: "Hello {{company}}",
      body: "Hi {{name}},\n\nBest,\n{{sender_name}}",
      followup1: "Follow up from {{sender_name}} about {{website}}",
      followup2: "Unsupported {{sender_title}}",
      cta: "Review {{persona}} fit",
    }, "Taylor");

    expect(sanitized.body).toContain("Taylor");
    expect(sanitized.followup1).toContain("Taylor");
    expect(`${sanitized.body}\n${sanitized.followup1}\n${sanitized.followup2}\n${sanitized.cta}`).not.toMatch(/{{sender_name}}/);
    expect(sanitized.unsupportedPlaceholders).toEqual(["sender_title"]);
  });

  it("maps detected groups to recommended templates", () => {
    expect(recommendTemplateForGroup("enterprise_it")).toBe("enterprise_transformation");
    expect(recommendTemplateForGroup("fintech")).toBe("fintech_compliance");
    expect(templateGuidance("ai_automation").cta).toMatch(/AI/i);
  });
});
