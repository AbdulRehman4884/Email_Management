/**
 * src/mcp/tools/enrichment/generateOutreachTemplate.tool.ts
 *
 * Deterministic outreach template builder — no external API calls.
 * Builds a personalised email template from enriched sample contacts
 * and a tone setting. Variables ({{name}}, {{company}}, etc.) are left
 * as tokens for the personalised-email generator to fill later.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { GenerateOutreachTemplateSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";

export interface GenerateOutreachTemplateResult {
  subject: string;
  body: string;
  variables: string[];
  tone: string;
}

type Tone = "formal" | "friendly" | "sales-focused" | "executive";

function detectDominantIndustry(sample: Array<Record<string, unknown>>): string | undefined {
  const counts: Record<string, number> = {};
  for (const row of sample) {
    const ind = row["industry"];
    if (typeof ind === "string" && ind.trim()) {
      counts[ind] = (counts[ind] ?? 0) + 1;
    }
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0];
}

function buildTemplate(
  tone: Tone,
  industry: string | undefined,
  cta: string | undefined,
  customInstructions: string | undefined,
): { subject: string; body: string } {
  const industryPhrase = industry ? ` in the ${industry} sector` : "";
  const ctaLine = cta ?? "schedule a quick 15-minute call this week";

  const openings: Record<Tone, string> = {
    formal:          "Dear {{name}},",
    friendly:        "Hi {{name}},",
    "sales-focused": "Hi {{name}},",
    executive:       "Dear {{name}},",
  };

  const intros: Record<Tone, string> = {
    formal:
      `I am reaching out to professionals${industryPhrase} who may benefit from our solutions. ` +
      "We help companies like {{company}} streamline operations and achieve measurable results.",
    friendly:
      `I came across {{company}} and thought I'd reach out — ` +
      `we've been working with a number of teams${industryPhrase} and the results have been great.`,
    "sales-focused":
      `Companies${industryPhrase} like {{company}} are seeing real ROI from our platform. ` +
      "I'd love to show you how we can deliver the same results for your team.",
    executive:
      `I'm contacting senior leaders${industryPhrase} to share how our solution is helping ` +
      "organisations similar to {{company}} drive measurable business impact.",
  };

  const closings: Record<Tone, string> = {
    formal:
      `I would welcome the opportunity to discuss this further. Please feel free to ${ctaLine}.`,
    friendly:
      `Would love to chat — happy to ${ctaLine} if that works!`,
    "sales-focused":
      `Let's connect — I can walk you through our ROI figures. Can we ${ctaLine}?`,
    executive:
      `I believe this warrants a brief conversation. I'd appreciate the chance to ${ctaLine}.`,
  };

  const subjects: Record<Tone, string> = {
    formal:          "Partnership Opportunity for {{company}}",
    friendly:        "Quick note for {{name}} at {{company}}",
    "sales-focused": "How {{company}} can achieve results — worth 15 mins?",
    executive:       "Relevant opportunity for {{company}} leadership",
  };

  const body = [
    openings[tone],
    "",
    intros[tone],
    "",
    ...(customInstructions ? [customInstructions, ""] : []),
    closings[tone],
    "",
    "Best regards,",
    "{{sender_name}}",
  ].join("\n");

  return { subject: subjects[tone], body };
}

export const generateOutreachTemplateTool: McpToolDefinition<
  typeof GenerateOutreachTemplateSchema,
  GenerateOutreachTemplateResult
> = {
  name: TOOL_NAMES.GENERATE_OUTREACH_TEMPLATE,

  description:
    "Generates a personalised outreach email template from enriched contact samples. " +
    "Returns subject, body with {{variable}} tokens, and a list of variable names. " +
    "No external API calls — deterministic output based on tone and dominant industry.",

  inputSchema: GenerateOutreachTemplateSchema,

  handler: async (input, context) => {
    const { campaignId, enrichedSample, tone, customInstructions, cta } = input;

    const dominantIndustry = detectDominantIndustry(
      enrichedSample as Array<Record<string, unknown>>,
    );
    const { subject, body } = buildTemplate(
      tone as Tone,
      dominantIndustry,
      cta,
      customInstructions,
    );

    // Extract all {{variable}} tokens from subject + body
    const tokenRe = /\{\{(\w+)\}\}/g;
    const vars = new Set<string>();
    for (const str of [subject, body]) {
      let m: RegExpExecArray | null;
      // Reset lastIndex for each string since we reuse the regex object
      tokenRe.lastIndex = 0;
      while ((m = tokenRe.exec(str)) !== null) {
        vars.add(m[1]!);
      }
    }

    context.log.debug(
      { campaignId, tone, dominantIndustry },
      "generateOutreachTemplate: done",
    );
    return toolSuccess<GenerateOutreachTemplateResult>({
      subject,
      body,
      variables: Array.from(vars),
      tone,
    });
  },
};
