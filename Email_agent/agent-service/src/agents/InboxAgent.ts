/**
 * src/agents/InboxAgent.ts
 *
 * Handles inbox / reply management intents.
 *
 * Intents handled:
 *   list_replies      → MCP tool: list_replies
 *   summarize_replies → MCP tool: summarize_replies
 *
 * Argument resolution:
 *   toolArgs are built by resolveToolArgs() which merges:
 *     - list_replies:
 *         campaignId  from llmExtractedArgs or activeCampaignId
 *         limit       from llmExtractedArgs.limit (positive integer)
 *         filters     from llmExtractedArgs.filters (sanitised — no auth keys)
 *     - summarize_replies:
 *         campaignId  from llmExtractedArgs or activeCampaignId
 *         query       from llmExtractedArgs.query
 *         filters     from llmExtractedArgs.filters (sanitised)
 *   userId / accountId / tenantId are NEVER sourced from LLM output.
 */

import { BaseAgent } from "./BaseAgent.js";
import { resolveToolArgs } from "../lib/toolArgResolver.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";
import type { KnownToolName } from "../types/tools.js";

const TOOL_MAP = {
  list_replies:      "list_replies",
  summarize_replies: "summarize_replies",
} satisfies Partial<Record<Intent, KnownToolName>>;

type InboxIntent = keyof typeof TOOL_MAP;

function isInboxIntent(intent: Intent | undefined): intent is InboxIntent {
  return intent !== undefined && intent in TOOL_MAP;
}

export class InboxAgent extends BaseAgent {
  readonly domain = "inbox" as const;

  constructor() {
    super("inbox");
  }

  async handle(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, activeCampaignId } = state;

    if (!isInboxIntent(intent)) {
      const msg = `InboxAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
    }

    const toolName = TOOL_MAP[intent];

    const toolArgs = resolveToolArgs(toolName, {
      extractedArgs:    llmExtractedArgs,
      activeCampaignId,
    });

    this.log.debug(
      {
        intent,
        toolName,
        userId,
        resolvedArgKeys: Object.keys(toolArgs),
      },
      "InboxAgent resolved tool and args",
    );

    return { toolName, toolArgs };
  }
}

export const inboxAgent = new InboxAgent();
