/**
 * src/graph/nodes/manager.node.ts
 *
 * Manager node — resolves intent → agentDomain and drives conditional routing.
 *
 * Two exports:
 *  - `managerNode`   — LangGraph node function; sets agentDomain on state
 *  - `routeToAgent`  — conditional-edge routing function consumed by agent.workflow.ts
 *
 * Routing table:
 *   "campaign"  → campaign node  (create/update/start/pause/resume)
 *   "settings"  → campaign node  (check_smtp/update_smtp handled by CampaignAgent)
 *   "analytics" → analytics node
 *   "inbox"     → inbox node
 *   "general"   → formatResponse node (no tool execution needed)
 *   undefined   → formatResponse node (defensive fallback)
 */

import { createLogger } from "../../lib/logger.js";
import { INTENT_DOMAIN } from "../../config/intents.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:manager");

// ── Route destinations ────────────────────────────────────────────────────────

export type AgentRoute = "campaign" | "analytics" | "inbox" | "formatResponse";

// ── Node ──────────────────────────────────────────────────────────────────────

export async function managerNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const intent = state.intent ?? "general_help";
  const domain = INTENT_DOMAIN[intent];
  const routedTo = resolveRoute(domain);

  log.info(
    { sessionId: state.sessionId, userId: state.userId, intent, domain },
    "Manager routing decision",
  );

  auditLogService.agentSelected(
    {
      userId:    state.userId    as string | undefined,
      sessionId: state.sessionId as string | undefined,
    },
    { intent, agentDomain: domain, routedTo },
  );

  return { agentDomain: domain };
}

// ── Conditional routing function ──────────────────────────────────────────────

/**
 * Determines which node to execute next based on agentDomain.
 *
 * "settings" is mapped to "campaign" because CampaignAgent owns SMTP intents.
 * This is the single place that encodes that routing decision.
 */
export function routeToAgent(state: AgentGraphStateType): AgentRoute {
  return resolveRoute(state.agentDomain);
}

function resolveRoute(domain: string | undefined): AgentRoute {
  switch (domain) {
    case "campaign":
    case "settings":
      return "campaign";
    case "analytics":
      return "analytics";
    case "inbox":
      return "inbox";
    default:
      return "formatResponse";
  }
}
