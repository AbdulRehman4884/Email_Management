/**
 * Phase 3 enrichment chaining — after fetch_website_content succeeds, dispatches
 * the next MCP tool(s) deterministically (no planner). Loops with executeTool.
 */

import { createLogger } from "../../lib/logger.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";
import type { KnownToolName } from "../../types/tools.js";

const log = createLogger("node:phase3Continuation");

/** Minimum cleaned text length before AI tools can run meaningfully. */
const MIN_WEBSITE_CONTENT_CHARS = 80;

export { PHASE3_TOOL_QUEUE } from "../../lib/phase3ToolChains.js";

function unwrapMcpData(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const d = raw as Record<string, unknown>;
  if (d.data && typeof d.data === "object" && !Array.isArray(d.data)) {
    return d.data as Record<string, unknown>;
  }
  return d;
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "Company";
  }
}

function stringifyEnvelope(
  status: string,
  intent: string | undefined,
  message: string,
  data: Record<string, unknown> = {},
): string {
  return JSON.stringify({ status, intent: intent ?? "general_help", message, data });
}

function clearPhase3Fields(): Partial<AgentGraphStateType> {
  return {
    pendingPhase3EnrichmentAction: undefined,
    pendingPhase3CompanyName: undefined,
    pendingPhase3Url: undefined,
    pendingPhase3WebsiteContent: undefined,
    pendingPhase3ToolQueue: undefined,
    pendingPhase3Scratch: undefined,
    pendingPhase3ContinueExecute: false,
  };
}

function mergeScratch(
  prev: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(prev ?? {}), ...patch };
}

function mapPainPointsForDraft(raw: unknown): Array<{
  title: string;
  description: string;
  confidence?: "high" | "medium" | "low";
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ title: string; description: string; confidence?: "high" | "medium" | "low" }> = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : "";
    const description = typeof o.description === "string" ? o.description : "";
    const confidence = o.confidence;
    const entry: { title: string; description: string; confidence?: "high" | "medium" | "low" } = {
      title,
      description,
    };
    if (confidence === "high" || confidence === "medium" || confidence === "low") {
      entry.confidence = confidence;
    }
    if (title || description) out.push(entry);
  }
  return out;
}

export async function phase3ContinuationNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const action = state.pendingPhase3EnrichmentAction;
  const queue = state.pendingPhase3ToolQueue;

  if (!action || !Array.isArray(queue) || queue.length === 0) {
    return { pendingPhase3ContinueExecute: false };
  }

  const lastTool = state.toolName;
  const tr = state.toolResult;

  // Tool failure — stop chain, leave toolResult for finalResponse error formatting
  if (state.error || (tr && tr.isToolError)) {
    log.info({ action, lastTool }, "phase3Continuation: chain aborted due to error");
    return clearPhase3Fields();
  }

  if (!tr || tr.isToolError) {
    return { pendingPhase3ContinueExecute: false };
  }

  const companyName =
    state.pendingPhase3CompanyName?.trim() ||
    hostnameFromUrl(state.pendingPhase3Url ?? "https://unknown.invalid");
  const sourceUrl = state.pendingPhase3Url ?? "";

  // ── Step A: just finished fetch_website_content → prime first chained tool ──
  if (lastTool === "fetch_website_content") {
    const d = unwrapMcpData(tr.data);
    const content = typeof d.content === "string" ? d.content : "";
    const fetchedUrl = typeof d.url === "string" ? d.url : sourceUrl;

    if (content.trim().length < MIN_WEBSITE_CONTENT_CHARS) {
      log.info({ len: content.trim().length }, "phase3Continuation: insufficient website text");
      return {
        ...clearPhase3Fields(),
        formattedResponse: stringifyEnvelope(
          "error",
          state.intent,
          [
            "**Not enough website content**",
            "",
            "The page returned very little readable text (it may be gated, mostly JavaScript, or blocked).",
            "Try another URL, a public marketing page, or paste key details manually.",
          ].join("\n"),
          {},
        ),
        toolName: undefined,
        toolArgs: {},
      };
    }

    const capped = content.length > 8000 ? content.slice(0, 8000) : content;
    const firstTool = queue[0] as KnownToolName;
    const scratchIn = state.pendingPhase3Scratch ?? {};

    const args = buildArgsForTool(firstTool, {
      state,
      companyName,
      sourceUrl: fetchedUrl || sourceUrl,
      websiteContent: capped,
      scratch: scratchIn,
    });

    log.info({ action, firstTool }, "phase3Continuation: scheduling first chained tool after fetch");

    return {
      pendingPhase3WebsiteContent: capped,
      pendingPhase3Scratch: scratchIn,
      toolName: firstTool,
      toolArgs: args,
      pendingPhase3ContinueExecute: true,
    };
  }

  // ── Step B: completed a chained tool → advance or finish ────────────────────
  if (queue.length === 0) {
    return { pendingPhase3ContinueExecute: false };
  }

  const expected = queue[0];
  if (lastTool !== expected) {
    log.warn({ lastTool, expected, queue }, "phase3Continuation: unexpected tool order");
    return { pendingPhase3ContinueExecute: false };
  }

  let scratch = { ...(state.pendingPhase3Scratch ?? {}) };

  // Update scratch from tool that just finished
  const doneData = unwrapMcpData(tr.data);
  switch (lastTool) {
    case "extract_company_profile": {
      const ind = typeof doneData.industry === "string" ? doneData.industry : undefined;
      const summary = typeof doneData.businessSummary === "string" ? doneData.businessSummary : undefined;
      scratch = mergeScratch(scratch, {
        extractIndustry: ind,
        businessSummary: summary,
      });
      break;
    }
    case "classify_industry": {
      const ind = typeof doneData.industry === "string" ? doneData.industry : "Unknown";
      scratch = mergeScratch(scratch, { classifyIndustry: ind });
      break;
    }
    case "detect_pain_points": {
      const pps = mapPainPointsForDraft(doneData.painPoints);
      scratch = mergeScratch(scratch, { detectPainPoints: pps });
      break;
    }
    default:
      break;
  }

  const rest = queue.slice(1);
  if (rest.length === 0) {
    log.info({ action, lastTool }, "phase3Continuation: chain complete");
    return {
      ...clearPhase3Fields(),
      pendingPhase3Scratch: undefined,
    };
  }

  const nextTool = rest[0] as KnownToolName;
  const wc = state.pendingPhase3WebsiteContent ?? "";
  const args = buildArgsForTool(nextTool, {
    state,
    companyName,
    sourceUrl: sourceUrl || (typeof doneData.url === "string" ? doneData.url : ""),
    websiteContent: wc,
    scratch,
  });

  log.info({ action, nextTool }, "phase3Continuation: scheduling next chained tool");

  return {
    pendingPhase3ToolQueue: rest,
    pendingPhase3Scratch: scratch,
    toolName: nextTool,
    toolArgs: args,
    pendingPhase3ContinueExecute: true,
  };
}

function buildArgsForTool(
  tool: KnownToolName,
  ctx: {
    state: AgentGraphStateType;
    companyName: string;
    sourceUrl: string;
    websiteContent: string;
    scratch: Record<string, unknown>;
  },
): Record<string, unknown> {
  const { companyName, sourceUrl, websiteContent, scratch } = ctx;
  const domain = hostnameFromUrl(sourceUrl || "https://placeholder.local");

  switch (tool) {
    case "extract_company_profile":
      return {
        companyName,
        sourceUrl: sourceUrl.startsWith("http") ? sourceUrl : `https://${sourceUrl.replace(/^\/+/, "")}`,
        websiteContent,
      };
    case "classify_industry": {
      const existing =
        typeof scratch.extractIndustry === "string" ? scratch.extractIndustry : undefined;
      return {
        companyName,
        websiteText: websiteContent,
        domain,
        ...(existing !== undefined ? { existingIndustry: existing } : {}),
      };
    }
    case "detect_pain_points": {
      const industry =
        typeof scratch.classifyIndustry === "string"
          ? scratch.classifyIndustry
          : typeof scratch.extractIndustry === "string"
            ? scratch.extractIndustry
            : undefined;
      const businessSummary =
        typeof scratch.businessSummary === "string" ? scratch.businessSummary : undefined;
      const args: Record<string, unknown> = {
        companyName,
        websiteContent,
      };
      if (industry !== undefined) args.industry = industry;
      if (businessSummary !== undefined) args.businessSummary = businessSummary;
      return args;
    }
    case "score_lead": {
      const industry =
        typeof scratch.classifyIndustry === "string"
          ? scratch.classifyIndustry
          : typeof scratch.extractIndustry === "string"
            ? scratch.extractIndustry
            : "Unknown";
      return {
        company: companyName,
        industry,
        website: sourceUrl.startsWith("http") ? sourceUrl : `https://${sourceUrl}`,
      };
    }
    case "generate_outreach_draft": {
      const industry =
        typeof scratch.classifyIndustry === "string"
          ? scratch.classifyIndustry
          : typeof scratch.extractIndustry === "string"
            ? scratch.extractIndustry
            : "Unknown";
      const painPoints = Array.isArray(scratch.detectPainPoints)
        ? (scratch.detectPainPoints as Array<{ title: string; description: string; confidence?: "high" | "medium" | "low" }>)
        : [];
      const businessSummary =
        typeof scratch.businessSummary === "string" ? scratch.businessSummary : undefined;
      const args: Record<string, unknown> = {
        companyName,
        industry,
        painPoints,
        tone: "professional",
      };
      if (businessSummary !== undefined) args.businessSummary = businessSummary;
      return args;
    }
    default:
      return {};
  }
}

export function routeAfterPhase3Continuation(state: AgentGraphStateType): "executeTool" | "formatResponse" {
  return state.pendingPhase3ContinueExecute === true ? "executeTool" : "formatResponse";
}
