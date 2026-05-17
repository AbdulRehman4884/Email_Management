/**
 * src/agents/EnrichmentAgent.ts
 *
 * Handles contact enrichment flows: CSV parse → batch enrichment preview → confirm/save,
 * plus Phase 1–3 MCP enrichment tools with deterministic argument extraction.
 */

import { BaseAgent } from "./BaseAgent.js";
import {
  enrichBatch,
  generateTemplate,
  type EnrichedContact,
  type EnrichmentSummary,
} from "../lib/contactEnrichment.js";
import { createLogger } from "../lib/logger.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";
import { PHASE3_TOOL_QUEUE } from "../lib/phase3ToolChains.js";
import {
  isEmailLike,
  isValidWebsiteInput,
  normalizeWebsiteUrlOrUndefined,
} from "../lib/websiteInput.js";
import { inferPhase3IntentFromUserMessage } from "../lib/phase3IntentFromMessage.js";
import {
  buildEnrichmentSnapshot,
  clearEnrichmentUiState,
  createWorkflowLock,
  isLockExpired,
  pushWorkflowStack,
} from "../lib/workflowConcurrency.js";

type OutreachTone = "formal" | "friendly" | "sales-focused" | "executive";

const PHASE3_INTENTS = new Set<Intent>([
  "analyze_company",
  "detect_pain_points",
  "generate_outreach",
  "enrich_company",
]);

const LOCATION_TAIL_WORDS = new Set([
  "pakistan",
  "india",
  "usa",
  "uk",
  "canada",
  "australia",
  "france",
  "germany",
  "spain",
  "italy",
  "brazil",
  "mexico",
  "china",
  "japan",
  "korea",
  "netherlands",
  "belgium",
  "sweden",
  "norway",
  "finland",
  "denmark",
  "poland",
  "turkey",
  "uae",
  "singapore",
]);

export class EnrichmentAgent extends BaseAgent {
  readonly domain = "enrichment" as const;

  private readonly diag = createLogger("EnrichmentAgent");

  constructor() {
    super("EnrichmentAgent");
  }

  async handle(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType>> {
    this.diag.debug(
      {
        intent: state.intent,
        pendingEnrichmentStep: state.pendingEnrichmentStep,
        pendingEnrichmentAction: state.pendingEnrichmentAction,
        hasCsvFile: !!state.pendingCsvFile,
      },
      "handle: entry",
    );

    const intent = state.intent;

    if (state.pendingCsvFile) {
      const { fileContent, filename } = state.pendingCsvFile;
      return {
        ...this.clearPhase3StatePatch(),
        toolName: "parse_csv_file",
        toolArgs: { fileContent, filename },
      };
    }

    // User switched to Phase 3 while CSV confirm or enrichment campaign-pick is active — abandon wizard/save UI.
    if (
      intent &&
      PHASE3_INTENTS.has(intent) &&
      (state.pendingEnrichmentStep === "confirm" || state.pendingEnrichmentAction === "save_enriched_contacts")
    ) {
      const enrichmentLock =
        state.activeWorkflowLock?.type === "enrichment" && !isLockExpired(state.activeWorkflowLock)
          ? state.activeWorkflowLock
          : createWorkflowLock("enrichment", { interruptible: true });

      const nextStack = pushWorkflowStack(state.workflowStack, {
        workflowId:   enrichmentLock.workflowId,
        type:         "enrichment",
        resumeIntent: "enrich_contacts",
        snapshot:     buildEnrichmentSnapshot(state) as unknown as Record<string, unknown>,
      });

      const merged: AgentGraphStateType = {
        ...state,
        workflowStack: nextStack,
        activeWorkflowLock: createWorkflowLock("phase3", { interruptible: false }),
        ...clearEnrichmentUiState(),
      };

      return {
        ...this.dispatchPhase3Intent(merged),
        workflowStack: nextStack.length > 0 ? nextStack : undefined,
        activeWorkflowLock: merged.activeWorkflowLock,
        ...clearEnrichmentUiState(),
      };
    }

    if (state.pendingEnrichmentStep === "enrich") {
      if (state.intent === "discard_enrichment") {
        return this.clearEnrichmentState(state, "discard_enrichment", true);
      }
      if (state.pendingCsvData?.rows && Array.isArray(state.pendingCsvData.rows)) {
        return this.runEnrichmentPreview(state);
      }
    }

    // Campaign pick for save_enriched_contacts must run before confirm — otherwise
    // numeric/name replies are handled as Review (enrich_contacts + confirm step).
    if (state.pendingEnrichmentAction === "save_enriched_contacts") {
      return this.handleCampaignSelection(state);
    }

    if (state.pendingEnrichmentStep === "confirm") {
      return this.handleConfirmStep(state);
    }

    switch (intent) {
      case "validate_email":
        return this.handleValidateEmail(state);
      case "extract_domain":
        return this.handleExtractDomain(state);
      case "fetch_company_website":
        return this.handleFetchWebsite(state);
      case "enrich_contact":
        return this.handleEnrichContact(state);
      case "search_company_web":
        return this.handleSearchCompanyWeb(state);
      case "select_official_website":
        return this.handleSelectOfficialWebsite(state);
      case "verify_company_website":
        return this.handleVerifyCompanyWebsite(state);
      case "analyze_company":
        return this.handleAnalyzeCompany(state);
      case "detect_pain_points":
        return this.handleDetectPainPoints(state);
      case "generate_outreach":
        return this.handleGenerateOutreach(state);
      case "enrich_company":
        return this.handleEnrichCompany(state);
      default:
        break;
    }

    return {};
  }

  private startPhase3Chain(
    state: AgentGraphStateType,
    action: NonNullable<AgentGraphStateType["pendingPhase3EnrichmentAction"]>,
    normalizedUrl: string,
    companyName: string,
  ): Partial<AgentGraphStateType> {
    const q = PHASE3_TOOL_QUEUE[action];
    return {
      ...this.clearStaleCsvForPhase3Intent(),
      activeWorkflowLock:
        state.activeWorkflowLock?.type === "phase3" && !isLockExpired(state.activeWorkflowLock)
          ? state.activeWorkflowLock
          : createWorkflowLock("phase3", { interruptible: false }),
      pendingPhase3EnrichmentAction: action,
      pendingPhase3CompanyName: companyName.trim(),
      pendingPhase3Url: normalizedUrl,
      pendingPhase3ToolQueue: [...q],
      pendingPhase3Scratch: {},
      pendingPhase3ContinueExecute: false,
      pendingPhase3WebsiteContent: undefined,
      toolName: "fetch_website_content",
      toolArgs: { url: normalizedUrl },
    };
  }

  private dispatchPhase3Intent(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    switch (state.intent) {
      case "analyze_company":
        return this.handleAnalyzeCompany(state);
      case "detect_pain_points":
        return this.handleDetectPainPoints(state);
      case "generate_outreach":
        return this.handleGenerateOutreach(state);
      case "enrich_company":
        return this.handleEnrichCompany(state);
      default:
        return {};
    }
  }

  /** Clears in-flight Phase 3 chain state (used when CSV upload starts or enrichment is discarded). */
  private clearPhase3StatePatch(): Partial<AgentGraphStateType> {
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

  /** After successful save_enriched_contacts or equivalent completion — wipe enrichment + Phase 3 UI state. */
  private clearAfterEnrichmentSavePatch(): Partial<AgentGraphStateType> {
    return {
      pendingEnrichmentData: undefined,
      pendingOutreachDraft: undefined,
      pendingEnrichmentStep: undefined,
      pendingCsvData: undefined,
      pendingEnrichmentAction: undefined,
      campaignSelectionList: undefined,
      ...this.clearPhase3StatePatch(),
    };
  }

  /** Starting a Phase 3 chain — drop stale CSV / wizard state so it cannot leak into intelligence tools. */
  private clearStaleCsvForPhase3Intent(): Partial<AgentGraphStateType> {
    return {
      pendingCsvData: undefined,
      pendingEnrichmentStep: undefined,
      pendingEnrichmentData: undefined,
      pendingOutreachDraft: undefined,
      pendingEnrichmentAction: undefined,
      campaignSelectionList: undefined,
    };
  }

  private phase3NeedsWebsiteNotEmail(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    return this.needsInputEnvelope(
      state,
      "Please provide a company website URL or domain, not an email address.",
    );
  }

  private isAffirmationOnlyMessage(message: string): boolean {
    const s = message.trim().toLowerCase().replace(/[!?.]+$/g, "");
    if (!s) return false;
    const tokens = s.split(/\s+/).filter(Boolean);
    const affirm = new Set([
      "yes",
      "y",
      "ok",
      "okay",
      "save",
      "confirm",
      "proceed",
      "yeah",
      "yep",
      "please",
      "do",
      "it",
      "go",
      "ahead",
      "sounds",
      "good",
      "just",
    ]);
    return tokens.length > 0 && tokens.every((t) => affirm.has(t));
  }

  /**
   * Resolves a normalized https URL for Phase 3, or undefined if missing / invalid / email-like.
   */
  private extractPhase3UrlCandidate(message: string): string | undefined {
    const http = this.extractUrlFromText(message);
    if (http && isValidWebsiteInput(http)) {
      const n = normalizeWebsiteUrlOrUndefined(http);
      if (n) return n;
    }

    const webTok = /\bwebsite\s+(\S+)/i.exec(message);
    if (webTok?.[1]) {
      const tok = webTok[1].replace(/[>,.;)\]}]+$/, "");
      if (isEmailLike(tok)) return undefined;
      if (isValidWebsiteInput(tok)) {
        const n = normalizeWebsiteUrlOrUndefined(tok);
        if (n) return n;
      }
    }

    const stripped = message.replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+\b/g,
      " ",
    );
    if (!/^https?:\/\//i.test(message)) {
      const bare = stripped.match(/\b((?:[\w-]+\.)+[a-z]{2,})\b/i);
      if (bare?.[1]) {
        const domain = bare[1].toLowerCase();
        if (!domain.includes("..")) {
          const cand = `https://${domain}`;
          const n = normalizeWebsiteUrlOrUndefined(cand);
          if (n) return n;
        }
      }
    }

    return undefined;
  }

  private companyLabelFromHostname(url: string): string {
    try {
      const h = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
      const base = h.split(".")[0] ?? h;
      if (!base) return "Company";
      return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
    } catch {
      return "Company";
    }
  }

  /**
   * Extracts a company name from common Phase 3 phrasing; falls back to undefined
   * so hostname heuristics can be used.
   */
  extractPhase3CompanyLabel(userMessage: string, _normalizedUrl: string): string | undefined {
    const msg = userMessage.trim();
    const mAc = msg.match(/(?:analyze|analyse)\s+company\s+(.+?)\s+using\s+website/i);
    if (mAc?.[1] && !/https?:\/\//i.test(mAc[1].trim())) {
      return mAc[1].trim();
    }
    const mDp = msg.match(/detect\s+pain\s+points?\s+(?:for\s+)?(.+?)\s+using\s+/i);
    if (mDp?.[1] && !mDp[1].includes("http")) {
      return mDp[1].trim();
    }
    const mGo = msg.match(/generate\s+outreach\s+(?:email\s+)?for\s+(.+?)\s+using\s+/i);
    if (mGo?.[1] && !mGo[1].includes("http")) {
      return mGo[1].trim();
    }
    const mEc = msg.match(/(?:fully\s+)?enrich\s+company\s+(.+?)\s+(?:using|from|at)\s+/i);
    if (mEc?.[1] && !mEc[1].includes("http")) {
      return mEc[1].trim();
    }
    return undefined;
  }

  // ── CSV enrichment wizard ────────────────────────────────────────────────────

  private runEnrichmentPreview(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const rows = state.pendingCsvData?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return this.needsInputEnvelope(
        state,
        "No parsed CSV rows are available. Upload a CSV file first.",
      );
    }

    const stringRows: Array<Record<string, string>> = [];
    for (const row of rows) {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
          out[k] = v === undefined || v === null ? "" : String(v);
        }
        stringRows.push(out);
      }
    }

    const batch = enrichBatch(stringRows);
    const tone = this.parseOutreachTone(state.userMessage);
    const tpl = generateTemplate(batch.contacts as EnrichedContact[], tone);

    const contactsPayload: Array<Record<string, unknown>> = [];
    for (const c of batch.contacts) {
      contactsPayload.push({ ...(c as Record<string, unknown>) });
    }

    const summary: EnrichmentSummary = batch.summary;

    const message = this.formatEnrichmentPreviewMarkdown(batch, tpl);

    return {
      pendingEnrichmentData: {
        contacts: contactsPayload,
        totalProcessed: batch.totalProcessed,
        enrichedCount: batch.enrichedCount,
        summary,
      },
      pendingOutreachDraft: {
        subject: tpl.subject,
        body: tpl.body,
        variables: Array.isArray(tpl.variables) ? tpl.variables : [],
        tone: tpl.tone,
      },
      pendingEnrichmentStep: "confirm",
      activeWorkflowLock:
        state.activeWorkflowLock?.type === "enrichment" && !isLockExpired(state.activeWorkflowLock)
          ? state.activeWorkflowLock
          : createWorkflowLock("enrichment", { interruptible: true }),
      formattedResponse: this.stringifyEnvelope(
        "success",
        "enrich_contacts",
        message,
        {
          enrichment: {
            totalProcessed: batch.totalProcessed,
            enrichedCount: batch.enrichedCount,
            summary,
          },
          outreachDraft: {
            subject: tpl.subject,
            body: tpl.body,
            variables: tpl.variables,
            tone: tpl.tone,
          },
        },
      ),
    };
  }

  private formatEnrichmentPreviewMarkdown(
    batch: ReturnType<typeof enrichBatch>,
    tpl: ReturnType<typeof generateTemplate>,
  ): string {
    const s = batch.summary;
    const industries = Object.entries(s.byIndustry)
      .map(([k, v]) => `**${k}**: ${v}`)
      .join(", ");

    const lines: string[] = [
      "### Enrichment complete",
      "",
      `- **Processed:** ${batch.totalProcessed}`,
      `- **Enriched:** ${batch.enrichedCount}`,
      `- **Hot leads:** ${s.hotLeads} · **Warm:** ${s.warmLeads} · **Cold:** ${s.coldLeads}`,
      `- **Business emails:** ${s.businessEmails}`,
    ];

    if (industries.length > 0) {
      lines.push(`- **By industry:** ${industries}`);
    }

    lines.push(
      "",
      "**Suggested subject:**",
      `> ${tpl.subject}`,
      "",
      "**Suggested body (preview):**",
      ...tpl.body.split("\n").map((l) => `> ${l}`),
      "",
      `I've enriched **${batch.enrichedCount}** contact${batch.enrichedCount !== 1 ? "s" : ""} and drafted outreach you can edit. Say **yes** or **save** to add them to your campaign, **customize** with a tone (e.g. formal), or **discard** to cancel.`,
    );

    return lines.join("\n");
  }

  private handleConfirmStep(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const intent = state.intent;

    if (intent === "discard_enrichment") {
      return this.clearEnrichmentState(state, "discard_enrichment", true);
    }

    // Explicit Phase 3 commands while CSV confirm is active — abandon wizard (preferred path).
    const phase3FromText = inferPhase3IntentFromUserMessage(state.userMessage);
    if (phase3FromText) {
      const enrichmentLock =
        state.activeWorkflowLock?.type === "enrichment" && !isLockExpired(state.activeWorkflowLock)
          ? state.activeWorkflowLock
          : createWorkflowLock("enrichment", { interruptible: true });

      const nextStack = pushWorkflowStack(state.workflowStack, {
        workflowId:   enrichmentLock.workflowId,
        type:         "enrichment",
        resumeIntent: "enrich_contacts",
        snapshot:     buildEnrichmentSnapshot(state) as unknown as Record<string, unknown>,
      });

      const merged: AgentGraphStateType = {
        ...state,
        intent: phase3FromText,
        workflowStack: nextStack,
        activeWorkflowLock: createWorkflowLock("phase3", { interruptible: false }),
        ...clearEnrichmentUiState(),
      };
      // Important: include workflowStack in the returned patch (dispatchPhase3Intent
      // returns only tool fields). Otherwise the stack is lost.
      return {
        ...this.dispatchPhase3Intent(merged),
        workflowStack: nextStack.length > 0 ? nextStack : undefined,
        activeWorkflowLock: merged.activeWorkflowLock,
        ...clearEnrichmentUiState(),
      };
    }

    if (intent === "customize_outreach") {
      const data = state.pendingEnrichmentData;
      const tone = this.parseOutreachTone(state.userMessage);
      if (!data?.contacts || !Array.isArray(data.contacts)) {
        return this.needsInputEnvelope(state, "Nothing to customize — run enrichment first.");
      }

      const contacts = data.contacts as EnrichedContact[];
      const tpl = generateTemplate(contacts, tone);

      return {
        pendingOutreachDraft: {
          subject: tpl.subject,
          body: tpl.body,
          variables: Array.isArray(tpl.variables) ? tpl.variables : [],
          tone: tpl.tone,
        },
        pendingEnrichmentStep: "confirm",
        formattedResponse: this.stringifyEnvelope(
          "success",
          "enrich_contacts",
          this.formatEnrichmentPreviewMarkdown(
            {
              contacts,
              totalProcessed: data.totalProcessed,
              enrichedCount: data.enrichedCount,
              summary: data.summary,
            },
            tpl,
          ),
          {
            enrichment: {
              totalProcessed: data.totalProcessed,
              enrichedCount: data.enrichedCount,
              summary: data.summary,
            },
            outreachDraft: {
              subject: tpl.subject,
              body: tpl.body,
              variables: tpl.variables,
              tone: tpl.tone,
            },
          },
        ),
      };
    }

    if (intent === "confirm_enrichment") {
      const data = state.pendingEnrichmentData;
      if (!data?.contacts || !Array.isArray(data.contacts)) {
        return this.needsInputEnvelope(state, "No enriched contacts to save.");
      }

      const campaignId = state.activeCampaignId?.trim();
      if (!campaignId) {
        return {
          toolName: "get_all_campaigns",
          toolArgs: {},
          pendingEnrichmentAction: "save_enriched_contacts",
          pendingEnrichmentStep: undefined,
        };
      }

      return {
        toolName: "save_enriched_contacts",
        toolArgs: {
          campaignId,
          contacts: data.contacts,
        },
        ...this.clearAfterEnrichmentSavePatch(),
      };
    }

    return {
      formattedResponse: this.stringifyEnvelope(
        "success",
        "enrich_contacts",
        [
          "### Ready when you are",
          "",
          "Say **yes** or **save** to add these leads to your campaign, **customize** with a tone like **formal** or **friendly** to rewrite the draft, or **discard** to cancel.",
        ].join("\n"),
        {
          outreachDraft: state.pendingOutreachDraft,
          enrichmentSummary: state.pendingEnrichmentData?.summary,
        },
      ),
    };
  }

  private handleCampaignSelection(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const list = state.campaignSelectionList;
    const data = state.pendingEnrichmentData;

    if (!data?.contacts || !Array.isArray(data.contacts)) {
      return {
        pendingEnrichmentAction: undefined,
        formattedResponse: this.stringifyEnvelope(
          "error",
          "enrich_contacts",
          "Enrichment data expired. Please upload and enrich your CSV again.",
          {},
        ),
      };
    }

    if (this.isAffirmationOnlyMessage(state.userMessage)) {
      return {
        pendingEnrichmentAction: "save_enriched_contacts",
        formattedResponse: this.stringifyEnvelope(
          "needs_input",
          "enrich_contacts",
          "Your contacts are ready. Reply with a **campaign number** or **campaign name** from the list so I know where to save them.",
          {},
        ),
      };
    }

    if (!Array.isArray(list) || list.length === 0) {
      return this.needsInputEnvelope(
        state,
        "I don't have your campaign list loaded yet. Say **save** again in a moment and I'll show the list to pick from.",
      );
    }

    const entry = this.matchCampaignEntry(state.userMessage, list);
    if (!entry) {
      const items = list
        .map((c, i) => `${i + 1}. **${c.name}** (ID ${c.id}, ${c.status})`)
        .join("\n");
      return {
        pendingEnrichmentAction: "save_enriched_contacts",
        formattedResponse: this.stringifyEnvelope(
          "success",
          "enrich_contacts",
          [
            "I could not match that to a campaign. Reply with a **number** or **campaign name** from:",
            "",
            items,
          ].join("\n"),
          {},
        ),
      };
    }

    return {
      toolName: "save_enriched_contacts",
      toolArgs: {
        campaignId: entry.id,
        contacts: data.contacts,
      },
      ...this.clearAfterEnrichmentSavePatch(),
    };
  }

  private matchCampaignEntry(
    userMessage: string,
    list: Array<{ id: string; name: string; status: string }>,
  ): { id: string; name: string; status: string } | undefined {
    const trimmed = userMessage.trim();
    if (!trimmed) return undefined;

    const n = parseInt(trimmed, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= list.length) {
      return list[n - 1];
    }

    for (const c of list) {
      if (c.id === trimmed) return c;
    }

    const lower = trimmed.toLowerCase();
    return list.find(
      (c) =>
        c.name.toLowerCase().includes(lower) ||
        lower.includes(c.name.toLowerCase()),
    );
  }

  private clearEnrichmentState(
    state: AgentGraphStateType,
    intent: Intent,
    clearCsv: boolean,
  ): Partial<AgentGraphStateType> {
    const clearedLock =
      state.activeWorkflowLock?.type === "enrichment" ? undefined : state.activeWorkflowLock;
    const clearedStackRaw = Array.isArray(state.workflowStack)
      ? state.workflowStack.filter((w) => w.type !== "enrichment")
      : state.workflowStack;
    const clearedStack =
      Array.isArray(clearedStackRaw) && clearedStackRaw.length === 0 ? undefined : clearedStackRaw;

    const patch: Partial<AgentGraphStateType> = {
      pendingEnrichmentStep: undefined,
      pendingEnrichmentData: undefined,
      pendingOutreachDraft: undefined,
      pendingEnrichmentAction: undefined,
      campaignSelectionList: undefined,
      ...this.clearPhase3StatePatch(),
      activeWorkflowLock: clearedLock,
      workflowStack: clearedStack,
      formattedResponse: this.stringifyEnvelope(
        "success",
        intent,
        "Enrichment cancelled — you can upload a new file whenever you are ready.",
        {},
      ),
    };

    if (clearCsv) {
      patch.pendingCsvData = undefined;
    }

    return patch;
  }

  // ── Phase 1 ─────────────────────────────────────────────────────────────────

  private handleValidateEmail(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const m = state.userMessage.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (!m) {
      return this.needsInputEnvelope(state, "Please include an email address to validate.");
    }
    return {
      toolName: "validate_email",
      toolArgs: { email: m[0] },
    };
  }

  private handleExtractDomain(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    let raw = state.userMessage.trim();
    raw = raw
      .replace(/^(?:extract\s+domain\s+from|domain\s+from|parse\s+domain\s+from|get\s+domain\s+from)\s+/i, "")
      .trim();
    if (!raw) {
      return this.needsInputEnvelope(state, "Tell me an email, URL, or domain to extract.");
    }
    return {
      toolName: "extract_domain",
      toolArgs: { input: raw },
    };
  }

  private handleFetchWebsite(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const url = this.extractUrlFromText(state.userMessage) ?? this.extractBareDomainAsUrl(state.userMessage);
    if (!url) {
      return this.needsInputEnvelope(state, "Please provide a **URL** (e.g. https://example.com) to fetch.");
    }
    return {
      toolName: "fetch_website_content",
      toolArgs: { url: this.normalizeWebsiteUrl(url) },
    };
  }

  private handleEnrichContact(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;
    const emailMatch = msg.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (emailMatch) {
      const at = emailMatch[0].indexOf("@");
      const domain = emailMatch[0].slice(at + 1).toLowerCase();
      return {
        toolName: "enrich_domain",
        toolArgs: { domain },
      };
    }

    let rest = msg.replace(/\b(enrich|lookup|look\s*up)\s+(contact|email|company)?\b/gi, "").trim();
    rest = rest.replace(/^this\s+/i, "").trim();
    if (!rest) {
      return this.needsInputEnvelope(
        state,
        "Provide a **company name** or **email address** to enrich.",
      );
    }

    return {
      toolName: "search_company",
      toolArgs: { companyName: rest },
    };
  }

  // ── Phase 2 ─────────────────────────────────────────────────────────────────

  private handleSearchCompanyWeb(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const stripped = this.stripSearchCommandPrefix(state.userMessage);
    const { companyName, location, country } = this.extractCompanyAndLocation(stripped);
    if (!companyName) {
      return this.needsInputEnvelope(
        state,
        "Tell me which **company** you want to find the official website for.",
      );
    }
    const args: Record<string, unknown> = { companyName };
    if (location !== undefined) args.location = location;
    if (country !== undefined) args.country = country;
    return {
      toolName: "search_company_web",
      toolArgs: args,
    };
  }

  private handleSelectOfficialWebsite(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;
    const urls = this.extractAllUrls(msg);
    if (!Array.isArray(urls) || urls.length === 0) {
      return this.needsInputEnvelope(
        state,
        "Provide at least one candidate **URL** to select from.",
      );
    }

    let company =
      this.extractBetween(msg, /official\s+website\s+for\s+/i, /\s+from\s+/i) ??
      this.extractAfterPhrase(msg, /select\s+(?:the\s+)?official\s+website\s+for\s+/i);

    company = company?.trim() ?? "";

    if (!company) {
      company = this.extractCompanyAndLocation(this.stripSearchCommandPrefix(msg)).companyName;
    }

    if (!company) {
      return this.needsInputEnvelope(state, "Which **company** are these websites for?");
    }

    const candidates = urls.map((url) => ({
      title: company,
      url: this.normalizeWebsiteUrl(url),
      snippet: "",
    }));

    const { location, country } = this.extractCompanyAndLocation(this.stripSearchCommandPrefix(msg));

    const args: Record<string, unknown> = { companyName: company, candidates };
    if (location !== undefined) args.location = location;
    if (country !== undefined) args.country = country;

    return {
      toolName: "select_official_website",
      toolArgs: args,
    };
  }

  private handleVerifyCompanyWebsite(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;
    const url =
      this.extractUrlFromText(msg) ??
      (msg.match(/https?:\/\/[^\s)]+/i)?.[0] ?? undefined);

    let company: string | undefined;

    const belongs = msg.match(/belongs\s+to\s+([^:]+):\s*(https?:\/\/[^\s]+)/i);
    if (belongs) {
      company = belongs[1]?.trim();
    }

    if (!company) {
      company =
        this.extractBetween(msg, /verify\s+(?:company\s+)?website\s+for\s+/i, /\s+at\s+/i)?.trim() ??
        this.extractBetween(msg, /verify\s+(?:that\s+)?(?:this\s+)?website\s+for\s+/i, /\s+at\s+/i)?.trim();
    }

    if (!company) {
      const beforeUrl = msg.split(/https?:\/\//i)[0] ?? "";
      company = beforeUrl.replace(/verify\s+company\s+website\s+for\s+/i, "").trim();
      company = company.replace(/\s+at\s*$/i, "").trim();
    }

    if (!company || company.length < 2) {
      company = this.extractCompanyAndLocation(this.stripSearchCommandPrefix(msg)).companyName;
    }

    if (!url || !company) {
      return this.needsInputEnvelope(
        state,
        "Provide the **company name** and **URL** to verify (e.g. verify company website for Acme at https://acme.com).",
      );
    }

    return {
      toolName: "verify_company_website",
      toolArgs: {
        companyName: company,
        url: this.normalizeWebsiteUrl(url),
      },
    };
  }

  // ── Phase 3 ─────────────────────────────────────────────────────────────────

  private handleAnalyzeCompany(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;
    const explicitWebsite = /\bwebsite\s+(\S+)/i.exec(msg)?.[1]?.replace(/[>,.;)\]}]+$/, "");
    if (explicitWebsite && isEmailLike(explicitWebsite)) {
      return this.phase3NeedsWebsiteNotEmail(state);
    }

    const norm = this.extractPhase3UrlCandidate(msg);
    if (!norm) {
      return this.needsInputEnvelope(
        state,
        "Please include a **website URL** so I can analyze the company.",
      );
    }

    const company =
      this.extractPhase3CompanyLabel(msg, norm) ?? this.companyLabelFromHostname(norm);
    return this.startPhase3Chain(state, "analyze_company", norm, company);
  }

  private handleDetectPainPoints(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;
    const explicitWebsite = /\bwebsite\s+(\S+)/i.exec(msg)?.[1]?.replace(/[>,.;)\]}]+$/, "");
    if (explicitWebsite && isEmailLike(explicitWebsite)) {
      return this.phase3NeedsWebsiteNotEmail(state);
    }

    const norm = this.extractPhase3UrlCandidate(msg);
    if (!norm) {
      return this.needsInputEnvelope(
        state,
        "Please include a **URL** of the company website to detect pain points.",
      );
    }

    const company =
      this.extractPhase3CompanyLabel(msg, norm) ?? this.companyLabelFromHostname(norm);
    return this.startPhase3Chain(state, "detect_pain_points", norm, company);
  }

  private handleGenerateOutreach(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;

    const explicitWebsite = /\bwebsite\s+(\S+)/i.exec(msg)?.[1]?.replace(/[>,.;)\]}]+$/, "");
    if (explicitWebsite && isEmailLike(explicitWebsite)) {
      return this.phase3NeedsWebsiteNotEmail(state);
    }

    const norm = this.extractPhase3UrlCandidate(msg);
    if (norm) {
      const company =
        this.extractPhase3CompanyLabel(msg, norm) ??
        this.extractCompanyNameForOutreach(msg) ??
        this.companyLabelFromHostname(norm);
      return this.startPhase3Chain(state, "generate_outreach", norm, company);
    }

    const company = this.extractCompanyNameForOutreach(msg);
    if (!company) {
      return this.needsInputEnvelope(
        state,
        "Tell me which company to write to (e.g. **generate outreach for Acme Corp**) or provide a **website URL**.",
      );
    }

    return {
      toolName: "generate_outreach_draft",
      toolArgs: {
        companyName: company,
        industry: "Unknown",
        painPoints: [],
        tone: "professional",
      },
    };
  }

  private handleEnrichCompany(state: AgentGraphStateType): Partial<AgentGraphStateType> {
    const msg = state.userMessage;
    const explicitWebsite = /\bwebsite\s+(\S+)/i.exec(msg)?.[1]?.replace(/[>,.;)\]}]+$/, "");
    if (explicitWebsite && isEmailLike(explicitWebsite)) {
      return this.phase3NeedsWebsiteNotEmail(state);
    }

    const norm = this.extractPhase3UrlCandidate(msg);
    if (!norm) {
      return this.needsInputEnvelope(
        state,
        "Please include a **company website URL** to run full enrichment.",
      );
    }

    const company =
      this.extractPhase3CompanyLabel(msg, norm) ?? this.companyLabelFromHostname(norm);
    return this.startPhase3Chain(state, "enrich_company", norm, company);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private stringifyEnvelope(
    status: string,
    intent: Intent | string,
    message: string,
    data: Record<string, unknown>,
  ): string {
    return JSON.stringify({ status, intent, message, data });
  }

  private needsInputEnvelope(state: AgentGraphStateType, message: string): Partial<AgentGraphStateType> {
    return {
      formattedResponse: this.stringifyEnvelope(
        "needs_input",
        state.intent ?? "general_help",
        message,
        {},
      ),
    };
  }

  private parseOutreachTone(msg: string): OutreachTone {
    const m = msg.toLowerCase();
    if (m.includes("formal")) return "formal";
    if (m.includes("executive")) return "executive";
    if (m.includes("sales")) return "sales-focused";
    if (m.includes("friendly")) return "friendly";
    return "friendly";
  }

  normalizeWebsiteUrl(raw: string): string {
    const n = normalizeWebsiteUrlOrUndefined(raw);
    if (n) return n;
    const t = raw.trim();
    if (/^https?:\/\//i.test(t)) return t;
    return `https://${t.replace(/^\/+/, "")}`;
  }

  extractUrlFromText(text: string): string | undefined {
    const m = text.match(/https?:\/\/[^\s>)'"]+/i);
    return m?.[0];
  }

  extractCompanyNameForAnalyze(text: string): string | undefined {
    let s = text.replace(/\b(analyze|analyse)\s+company\b/gi, "").trim();
    s = s.replace(/^["'\s]+|["'\s]+$/g, "");
    s = s.replace(/https?:\/\/\S+/gi, "").trim();
    return s.length > 0 ? s : undefined;
  }

  extractCompanyNameForOutreach(text: string): string | undefined {
    const m = /\b(?:for|about)\s+([^?\n!.]+)/i.exec(text);
    if (m?.[1]) {
      return m[1].trim().replace(/\s+$/, "");
    }
    return undefined;
  }

  stripSearchCommandPrefix(msg: string): string {
    return msg.replace(/^\s*\d+\.\s*/, "").trim();
  }

  extractCompanyAndLocation(text: string): {
    companyName: string;
    location?: string;
    country?: string;
  } {
    let s = this.stripSearchCommandPrefix(text);
    const prefixes = [
      /find\s+official\s+website\s+of\s+/i,
      /search\s+company\s+website\s+for\s+/i,
      /find\s+website\s+for\s+/i,
      /find\s+official\s+website\s+for\s+/i,
    ];
    for (const p of prefixes) {
      s = s.replace(p, "").trim();
    }

    const words = s.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      const last = words[words.length - 1]!;
      if (LOCATION_TAIL_WORDS.has(last.toLowerCase())) {
        return {
          companyName: words.slice(0, -1).join(" "),
          location: last,
          country: last,
        };
      }
    }

    return { companyName: s };
  }

  private extractBareDomainAsUrl(text: string): string | undefined {
    if (/https?:\/\//i.test(text)) return undefined;
    const m = text.match(/\b((?:[\w-]+\.)+[a-z]{2,})\b/i);
    if (!m?.[1]) return undefined;
    const domain = m[1].toLowerCase();
    if (domain.includes("..")) return undefined;
    return `https://${domain}`;
  }

  private extractAllUrls(text: string): string[] {
    const out: string[] = [];
    const re = /https?:\/\/[^\s>)'"]+/gi;
    let x: RegExpExecArray | null;
    while ((x = re.exec(text)) !== null) {
      out.push(x[0]);
    }
    return out;
  }

  private extractBetween(text: string, start: RegExp, end: RegExp): string | undefined {
    const sMatch = text.match(start);
    if (!sMatch || sMatch.index === undefined) return undefined;
    const startIdx = sMatch.index + sMatch[0].length;
    const rest = text.slice(startIdx);
    const eMatch = end.exec(rest);
    if (!eMatch || eMatch.index === undefined) return undefined;
    return rest.slice(0, eMatch.index);
  }

  private extractAfterPhrase(text: string, phrase: RegExp): string | undefined {
    const m = text.match(phrase);
    if (!m || m.index === undefined) return undefined;
    return text.slice(m.index + m[0].length).trim();
  }
}

export const enrichmentAgent = new EnrichmentAgent();
