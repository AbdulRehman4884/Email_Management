/**
 * src/mcp/registry/toolRegistry.ts
 *
 * Central registry that maps every McpToolDefinition onto a FastMCP addTool() call.
 *
 * The execute() wrapper built here is the glue between FastMCP's transport layer
 * and our application layer:
 *   FastMCP (validate input, call execute)
 *     → resolve auth from session
 *     → create MailFlowApiClient
 *     → build ToolContext
 *     → toolExecutionService.execute()
 *       → tool handler(input, context)
 *         → mailflow API client
 *
 * Adding a new tool: import it below and add it to ALL_TOOLS. Nothing else changes.
 */

import { randomUUID } from "node:crypto";
import type { FastMCP } from "fastmcp";
import { createLogger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { authContextService } from "../../services/authContext.service.js";
import { toolExecutionService } from "../../services/toolExecution.service.js";
import { createMailFlowApiClient } from "../../lib/mailflowApiClient.js";
import { createMockMailFlowApiClient } from "../../lib/mockMailflowApiClient.js";
import type { IMailFlowApiClient } from "../../lib/mailflowApiClient.js";
import type { AnyMcpToolDefinition, McpToolDefinition } from "../../types/tool.js";
import type { ToolContext } from "../types/toolContext.js";
import type { McpSession } from "../../types/mcp.js";
import type { MailFlowMcpSession } from "../bootstrap/createServer.js";

// ── Tool imports ──────────────────────────────────────────────────────────────

import { getAllCampaignsTool } from "../tools/campaign/getAllCampaigns.tool.js";
import { createCampaignTool } from "../tools/campaign/createCampaign.tool.js";
import { updateCampaignTool } from "../tools/campaign/updateCampaign.tool.js";
import { startCampaignTool } from "../tools/campaign/startCampaign.tool.js";
import { pauseCampaignTool } from "../tools/campaign/pauseCampaign.tool.js";
import { resumeCampaignTool } from "../tools/campaign/resumeCampaign.tool.js";
import { getSequenceProgressTool } from "../tools/campaign/getSequenceProgress.tool.js";
import { getPendingFollowUpsTool } from "../tools/campaign/getPendingFollowUps.tool.js";
import { getRecipientTouchHistoryTool } from "../tools/campaign/getRecipientTouchHistory.tool.js";
import { markRecipientRepliedTool } from "../tools/campaign/markRecipientReplied.tool.js";
import { markRecipientBouncedTool } from "../tools/campaign/markRecipientBounced.tool.js";
import { getCampaignStatsTool } from "../tools/analytics/getCampaignStats.tool.js";
import { listRepliesTool } from "../tools/inbox/listReplies.tool.js";
import { summarizeRepliesTool } from "../tools/inbox/summarizeReplies.tool.js";
import { getReplyIntelligenceSummaryTool } from "../tools/inbox/getReplyIntelligenceSummary.tool.js";
import { showHotLeadsTool } from "../tools/inbox/showHotLeads.tool.js";
import { showMeetingReadyLeadsTool } from "../tools/inbox/showMeetingReadyLeads.tool.js";
import { draftReplySuggestionTool } from "../tools/inbox/draftReplySuggestion.tool.js";
import { markReplyHumanReviewTool } from "../tools/inbox/markReplyHumanReview.tool.js";
import { getAutonomousRecommendationTool } from "../tools/inbox/getAutonomousRecommendation.tool.js";
import { getCampaignAutonomousSummaryTool } from "../tools/inbox/getCampaignAutonomousSummary.tool.js";
import { previewSequenceAdaptationTool } from "../tools/inbox/previewSequenceAdaptation.tool.js";
import { getSmtpSettingsTool } from "../tools/settings/getSmtpSettings.tool.js";
import { updateSmtpSettingsTool } from "../tools/settings/updateSmtpSettings.tool.js";
import { getRecipientCountTool } from "../tools/campaign/getRecipientCount.tool.js";
import { saveAiPromptTool } from "../tools/campaign/saveAiPrompt.tool.js";
import { generatePersonalizedEmailsTool } from "../tools/campaign/generatePersonalizedEmails.tool.js";
import { getPersonalizedEmailsTool } from "../tools/campaign/getPersonalizedEmails.tool.js";
import { parseCsvFileTool } from "../tools/campaign/parseCsvFile.tool.js";
import { saveCsvRecipientsTool } from "../tools/campaign/saveCsvRecipients.tool.js";
import { validateEmailTool } from "../tools/enrichment/validateEmail.tool.js";
import { extractDomainTool } from "../tools/enrichment/extractDomain.tool.js";
import { fetchWebsiteContentTool } from "../tools/enrichment/fetchWebsiteContent.tool.js";
import { enrichDomainTool } from "../tools/enrichment/enrichDomain.tool.js";
import { searchCompanyTool } from "../tools/enrichment/searchCompany.tool.js";
import { classifyIndustryTool } from "../tools/enrichment/classifyIndustry.tool.js";
import { scoreLeadTool } from "../tools/enrichment/scoreLead.tool.js";
import { generateOutreachTemplateTool } from "../tools/enrichment/generateOutreachTemplate.tool.js";
import { saveEnrichedContactsTool } from "../tools/enrichment/saveEnrichedContacts.tool.js";
import { searchCompanyWebTool } from "../tools/enrichment/searchCompanyWeb.tool.js";
import { selectOfficialWebsiteTool } from "../tools/enrichment/selectOfficialWebsite.tool.js";
import { verifyCompanyWebsiteTool } from "../tools/enrichment/verifyCompanyWebsite.tool.js";
import { extractCompanyProfileTool } from "../tools/enrichment/extractCompanyProfile.tool.js";
import { detectPainPointsTool } from "../tools/enrichment/detectPainPoints.tool.js";
import { generateOutreachDraftTool } from "../tools/enrichment/generateOutreachDraft.tool.js";

const log = createLogger("toolRegistry");

// ── Tool list ─────────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  // Campaign
  getAllCampaignsTool,
  createCampaignTool,
  updateCampaignTool,
  startCampaignTool,
  pauseCampaignTool,
  resumeCampaignTool,
  getSequenceProgressTool,
  getPendingFollowUpsTool,
  getRecipientTouchHistoryTool,
  markRecipientRepliedTool,
  markRecipientBouncedTool,
  // Analytics
  getCampaignStatsTool,
  // Inbox
  listRepliesTool,
  summarizeRepliesTool,
  getReplyIntelligenceSummaryTool,
  showHotLeadsTool,
  showMeetingReadyLeadsTool,
  draftReplySuggestionTool,
  markReplyHumanReviewTool,
  getAutonomousRecommendationTool,
  getCampaignAutonomousSummaryTool,
  previewSequenceAdaptationTool,
  // Settings
  getSmtpSettingsTool,
  updateSmtpSettingsTool,
  // Phase 1: AI Campaign
  getRecipientCountTool,
  saveAiPromptTool,
  generatePersonalizedEmailsTool,
  getPersonalizedEmailsTool,
  // CSV file ingestion
  parseCsvFileTool,
  saveCsvRecipientsTool,
  // Enrichment
  validateEmailTool,
  extractDomainTool,
  fetchWebsiteContentTool,
  enrichDomainTool,
  searchCompanyTool,
  classifyIndustryTool,
  scoreLeadTool,
  generateOutreachTemplateTool,
  saveEnrichedContactsTool,
  // Phase 2: Company Search + Official Website Discovery
  searchCompanyWebTool,
  selectOfficialWebsiteTool,
  verifyCompanyWebsiteTool,
  // Phase 3: AI Company Intelligence
  extractCompanyProfileTool,
  detectPainPointsTool,
  generateOutreachDraftTool,
] as const satisfies ReadonlyArray<McpToolDefinition<any, any>>;

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers all tools on the FastMCP server instance.
 * Called once during bootstrap in createServer.ts.
 */
export function registerAllTools(
  server: FastMCP<MailFlowMcpSession>,
): void {
  for (const toolDef of ALL_TOOLS) {
    server.addTool({
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.inputSchema,

      execute: async (args, fastMcpContext) => {
        // ── 1. Extract session ID ─────────────────────────────────────────────
        const rawSession = fastMcpContext.session as MailFlowMcpSession & { id?: string };
        const sessionId: string =
          typeof rawSession.id === "string" ? rawSession.id : randomUUID();

        // ── 2. Resolve auth from session (set by authenticate hook) ───────────
        const auth = authContextService.resolve(rawSession.rawAuth);

        // ── 3. Build McpSession ───────────────────────────────────────────────
        const session: McpSession = { sessionId, rawAuth: rawSession.rawAuth };

        // ── 4. Instantiate MailFlow API client ────────────────────────────────
        // In mock mode (MOCK_MAILFLOW=true / development only) use the in-process
        // mock client so tool calls succeed without a real MailFlow backend.
        const isMock = env.MOCK_MAILFLOW;
        const mailflow: IMailFlowApiClient = isMock
          ? createMockMailFlowApiClient()
          : createMailFlowApiClient(auth.bearerToken);

        log.info(
          { toolName: toolDef.name, userId: auth.userId, sessionId, isMock },
          "Tool execution: starting",
        );

        // ── 5. Create a tool-scoped logger bound to session context ───────────
        const toolLog = createLogger(toolDef.name).child({ sessionId });

        // ── 6. Compose ToolContext ────────────────────────────────────────────
        const toolContext: ToolContext = {
          auth,
          session,
          log: toolLog,
          mailflow,
        };

        // ── 7. Delegate to execution service ─────────────────────────────────
        return toolExecutionService.execute(
          toolDef as unknown as AnyMcpToolDefinition,
          args,
          toolContext,
        );
      },
    });

    log.debug({ toolName: toolDef.name }, "Tool registered");
  }

  log.info({ count: ALL_TOOLS.length }, "All tools registered");
}
