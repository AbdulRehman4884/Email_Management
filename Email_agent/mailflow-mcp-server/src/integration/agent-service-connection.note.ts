/**
 * src/integration/agent-service-connection.note.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW agent-service CONNECTS TO mailflow-mcp-server
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This file is documentation-as-code — it is never executed.
 * It captures the integration design, migration strategy, and code patterns
 * so future engineers have a single authoritative reference.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CURRENT ARCHITECTURE (before integration)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Frontend / Chat UI
 *       ↓
 *   agent-service (Node.js + Express + LangGraph)
 *       ↓  Manager node routes to sub-agents
 *   ┌───────────────┬───────────────┬───────────────┐
 *   ↓               ↓               ↓
 *   Campaign agent  Analytics agent  Inbox agent
 *       ↓               ↓               ↓
 *   LangChain tools (direct HTTP wrappers calling MailFlow)
 *       ↓
 *   MailFlow backend
 *
 *
 * TARGET ARCHITECTURE (after integration)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Frontend / Chat UI
 *       ↓
 *   agent-service (Node.js + Express + LangGraph)
 *       ↓  MCP client (MultiServerMCPClient)
 *   mailflow-mcp-server (FastMCP / SSE)
 *       ↓  HTTP + JWT Bearer
 *   MailFlow backend
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 1 — INSTALL THE MCP ADAPTER IN agent-service
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm install @langchain/mcp-adapters
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 2 — CREATE THE MCP CLIENT IN agent-service
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Create a singleton MCP client that connects to mailflow-mcp-server over SSE.
 * Place this in a shared module, e.g. `src/clients/mailflowMcp.ts`:
 *
 * ```typescript
 * import { MultiServerMCPClient } from "@langchain/mcp-adapters";
 *
 * // Called once at agent-service startup, before the LangGraph graph is built.
 * export async function createMailFlowMcpClient(
 *   userBearerToken: string,
 * ): Promise<MultiServerMCPClient> {
 *   const client = new MultiServerMCPClient({
 *     mcpServers: {
 *       mailflow: {
 *         transport: "sse",
 *         url: process.env.MAILFLOW_MCP_SERVER_URL ?? "http://localhost:3001/sse",
 *         headers: {
 *           // Authenticate this service as a trusted caller
 *           "X-Service-Token": process.env.MCP_SERVICE_SECRET ?? "",
 *           // Forward the end-user bearer token so MailFlow enforces ownership
 *           "X-Forwarded-Authorization": `Bearer ${userBearerToken}`,
 *         },
 *       },
 *     },
 *   });
 *
 *   await client.initializeConnections();
 *   return client;
 * }
 * ```
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 3 — LOAD TOOLS AND BIND TO LangGraph AGENTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * In the LangGraph graph builder:
 *
 * ```typescript
 * import { createMailFlowMcpClient } from "../clients/mailflowMcp.js";
 *
 * async function buildGraph(userBearerToken: string) {
 *   const mcpClient = await createMailFlowMcpClient(userBearerToken);
 *   const allMcpTools = await mcpClient.getTools();
 *
 *   // Route tools to agents by name — matches TOOL_NAMES constants exactly
 *   const campaignTools = allMcpTools.filter((t) =>
 *     ["create_campaign", "update_campaign", "start_campaign",
 *      "pause_campaign", "resume_campaign"].includes(t.name),
 *   );
 *   const analyticsTools = allMcpTools.filter((t) =>
 *     t.name === "get_campaign_stats",
 *   );
 *   const inboxTools = allMcpTools.filter((t) =>
 *     ["list_replies", "summarize_replies"].includes(t.name),
 *   );
 *   const settingsTools = allMcpTools.filter((t) =>
 *     ["get_smtp_settings", "update_smtp_settings"].includes(t.name),
 *   );
 *
 *   // Bind to agents exactly as you would bind direct LangChain tools today
 *   const campaignAgent = campaignModel.bindTools(campaignTools);
 *   const analyticsAgent = analyticsModel.bindTools(analyticsTools);
 *   // ...
 * }
 * ```
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * STEP 4 — REMOVE DIRECT LANGCHAIN TOOL WRAPPERS (MIGRATION)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Current agent-service has LangChain tools that call MailFlow APIs directly,
 * for example:
 *
 * ```typescript
 * // BEFORE — direct wrapper in agent-service
 * const createCampaignTool = tool(
 *   async ({ name, subject, fromEmail, body }) => {
 *     const res = await axios.post(`${MAILFLOW_URL}/campaigns`, { name, ... });
 *     return res.data;
 *   },
 *   { name: "create_campaign", schema: z.object({ ... }) },
 * );
 * ```
 *
 * After integration, these wrappers are deleted entirely. The MCP tool loaded
 * from mailflow-mcp-server has the same `name`, the same Zod schema, and the
 * same return shape — so the agent LLM prompt and graph routing logic require
 * no changes.
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MIGRATION STRATEGY (safe, incremental)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Phase A — Deploy mailflow-mcp-server alongside agent-service
 *   • Both services running; no agent-service code changed yet
 *   • Smoke-test MCP tools directly via curl or the MCP Inspector
 *
 * Phase B — Shadow mode (optional, lower-risk)
 *   • Add the MCP client to agent-service but keep direct tools as primary
 *   • Run both in parallel, compare outputs, log discrepancies
 *   • Gate on parity before removing direct tools
 *
 * Phase C — Migrate one agent at a time
 *   • Replace direct tools on Campaign agent first (highest test coverage)
 *   • Verify in staging; deploy to production
 *   • Repeat for Analytics, Inbox, Settings agents
 *
 * Phase D — Remove direct tool wrappers
 *   • Delete the old LangChain HTTP wrappers from agent-service
 *   • Remove the MailFlow API client from agent-service (no longer needed)
 *   • agent-service no longer holds MailFlow API credentials directly
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTH HEADER PROPAGATION DETAILS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * agent-service holds the end-user's JWT (from its own auth middleware).
 * It forwards it to mailflow-mcp-server in X-Forwarded-Authorization.
 * mailflow-mcp-server passes it unchanged to MailFlow's API.
 * MailFlow enforces ownership — the user can only access their own resources.
 *
 * X-Service-Token is a shared secret between the two services. It prevents
 * direct access to mailflow-mcp-server from unknown callers. Generate it with:
 *
 *   openssl rand -hex 32
 *
 * Store it in:
 *   - agent-service env: MCP_SERVICE_SECRET (used as outbound header value)
 *   - mailflow-mcp-server env: MCP_SERVICE_SECRET (used for inbound validation)
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT VARIABLES REQUIRED IN agent-service
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   MAILFLOW_MCP_SERVER_URL=http://mailflow-mcp-server:3001/sse
 *   MCP_SERVICE_SECRET=<same value as mailflow-mcp-server MCP_SERVICE_SECRET>
 *
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FUTURE ENHANCEMENTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. LLM-powered summarize_replies
 *    Replace buildDeterministicSummary() in summarizeReplies.tool.ts with a
 *    model call (e.g. via @langchain/anthropic). The tool handler, schema,
 *    and ToolContext are unchanged — only the implementation function changes.
 *
 * 2. Tool streaming / progress
 *    For long-running operations, use context.reportProgress() (already wired
 *    in FastMcpExecuteContext) to stream partial results back to the agent.
 *
 * 3. Service-to-service mTLS
 *    Replace the shared-secret X-Service-Token with mutual TLS by updating
 *    only authContext.service.ts and the SSE middleware in createServer.ts.
 *    Tool code is unaffected.
 *
 * 4. Additional MailFlow operations
 *    Follow the "Adding a New Tool" guide in README.md — it's a 6-step process
 *    that touches no existing files beyond constants.ts and toolRegistry.ts.
 */

export {};
