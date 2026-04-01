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
import type { AnyMcpToolDefinition } from "../../types/tool.js";
import type { ToolContext } from "../types/toolContext.js";
import type { McpSession } from "../../types/mcp.js";
import type { MailFlowMcpSession } from "../bootstrap/createServer.js";

// ── Tool imports ──────────────────────────────────────────────────────────────

import { createCampaignTool } from "../tools/campaign/createCampaign.tool.js";
import { updateCampaignTool } from "../tools/campaign/updateCampaign.tool.js";
import { startCampaignTool } from "../tools/campaign/startCampaign.tool.js";
import { pauseCampaignTool } from "../tools/campaign/pauseCampaign.tool.js";
import { resumeCampaignTool } from "../tools/campaign/resumeCampaign.tool.js";
import { getCampaignStatsTool } from "../tools/analytics/getCampaignStats.tool.js";
import { listRepliesTool } from "../tools/inbox/listReplies.tool.js";
import { summarizeRepliesTool } from "../tools/inbox/summarizeReplies.tool.js";
import { getSmtpSettingsTool } from "../tools/settings/getSmtpSettings.tool.js";
import { updateSmtpSettingsTool } from "../tools/settings/updateSmtpSettings.tool.js";

const log = createLogger("toolRegistry");

// ── Tool list ─────────────────────────────────────────────────────────────────

const ALL_TOOLS: AnyMcpToolDefinition[] = [
  // Campaign
  createCampaignTool,
  updateCampaignTool,
  startCampaignTool,
  pauseCampaignTool,
  resumeCampaignTool,
  // Analytics
  getCampaignStatsTool,
  // Inbox
  listRepliesTool,
  summarizeRepliesTool,
  // Settings
  getSmtpSettingsTool,
  updateSmtpSettingsTool,
];

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
        const mailflow: IMailFlowApiClient = env.MOCK_MAILFLOW
          ? createMockMailFlowApiClient()
          : createMailFlowApiClient(auth.bearerToken);

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
        return toolExecutionService.execute(toolDef, args, toolContext);
      },
    });

    log.debug({ toolName: toolDef.name }, "Tool registered");
  }

  log.info({ count: ALL_TOOLS.length }, "All tools registered");
}
