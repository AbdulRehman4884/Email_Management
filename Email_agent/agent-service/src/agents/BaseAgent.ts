/**
 * src/agents/BaseAgent.ts
 *
 * Abstract base class for all domain agents.
 *
 * Domain agents are responsible for:
 *  1. Mapping the detected intent to the correct MCP tool name
 *  2. Preparing tool arguments (placeholder in Phase 4; LLM extraction in Phase 6)
 *  3. Returning a state patch to be merged by the LangGraph engine
 *
 * Agents do NOT:
 *  - Call MCP directly (that is the executeTool node's job, Phase 5+)
 *  - Make approval decisions (that is the approval node's job)
 *  - Format responses (that is the finalResponse node's job)
 */

import { createLogger } from "../lib/logger.js";
import type { Logger } from "../lib/logger.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";

export abstract class BaseAgent {
  protected readonly log: Logger;

  /** Domain this agent is responsible for — used for routing and logging. */
  abstract readonly domain: "campaign" | "analytics" | "inbox" | "settings" | "enrichment" | "research" | "scripts" | "crm" | "leadgen";

  constructor(agentName: string) {
    this.log = createLogger(`agent:${agentName}`);
  }

  /**
   * Processes the current graph state and returns a state patch.
   *
   * Implementations must set at minimum `toolName` and `toolArgs`.
   * They may also set `error` if the intent cannot be handled.
   *
   * @param state - Current graph state (read-only by convention)
   * @returns Partial state patch to be merged by LangGraph
   */
  abstract handle(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>>;

  /**
   * A request this agent cannot handle. The technical reason goes to the log only;
   * the user gets a plain message (it used to read "CampaignAgent received unhandled
   * intent: recipient_status_help", bug A-19).
   */
  protected unhandledIntent(intent: string | undefined, userId: unknown): Partial<AgentGraphStateType> {
    this.log.error({ intent, userId }, `${this.constructor.name} received unhandled intent: ${intent ?? "undefined"}`);
    return {
      error:
        "Sorry, I couldn't work that out. Could you say it another way? For example: " +
        "**show all campaigns**, **stats for <campaign name>** or **how many recipients does <campaign name> have?**",
    };
  }
}
