/**
 * src/agents/CampaignAgent.ts
 *
 * Handles campaign management intents and SMTP settings intents.
 *
 * Intents handled:
 *   create_campaign  → MCP tool: create_campaign
 *   update_campaign  → MCP tool: update_campaign
 *   start_campaign   → MCP tool: start_campaign   (risky — approval required)
 *   pause_campaign   → MCP tool: pause_campaign
 *   resume_campaign  → MCP tool: resume_campaign  (risky — approval required)
 *   check_smtp       → MCP tool: get_smtp_settings
 *   update_smtp      → MCP tool: update_smtp_settings (risky — approval required)
 *
 * Argument resolution:
 *   toolArgs are built by resolveToolArgs() which merges:
 *     1. state.llmExtractedArgs  — structured args from Gemini intent detection
 *     2. state.activeCampaignId  — session-level fallback for campaignId
 *   userId / accountId / tenantId are NEVER sourced from LLM output.
 *
 * Note on SMTP intents:
 *   INTENT_DOMAIN maps check_smtp / update_smtp to "settings", but these intents
 *   are routed to CampaignAgent because MailFlow manages SMTP as a campaign
 *   infrastructure concern and they share the same access patterns.
 */

import { BaseAgent } from "./BaseAgent.js";
import { resolveToolArgs, CREATE_CAMPAIGN_REQUIRED_FIELDS } from "../lib/toolArgResolver.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { Intent } from "../config/intents.js";
import type { KnownToolName } from "../types/tools.js";

// ── Intent → MCP tool mapping ─────────────────────────────────────────────────

const TOOL_MAP = {
  create_campaign: "create_campaign",
  update_campaign: "update_campaign",
  start_campaign:  "start_campaign",
  pause_campaign:  "pause_campaign",
  resume_campaign: "resume_campaign",
  check_smtp:      "get_smtp_settings",
  update_smtp:     "update_smtp_settings",
} satisfies Partial<Record<Intent, KnownToolName>>;

type CampaignIntent = keyof typeof TOOL_MAP;

function isCampaignIntent(intent: Intent | undefined): intent is CampaignIntent {
  return intent !== undefined && intent in TOOL_MAP;
}

// ── create_campaign validation ────────────────────────────────────────────────

/**
 * Returns true only when all five required create_campaign fields are present
 * as non-empty strings in the resolved toolArgs.
 */
function hasAllCreateCampaignFields(args: Record<string, unknown>): boolean {
  return CREATE_CAMPAIGN_REQUIRED_FIELDS.every(
    (f) => typeof args[f] === "string" && (args[f] as string).length > 0,
  );
}

/**
 * Deterministic fallback extractor for create_campaign fields.
 *
 * When Gemini is unavailable (quota / key not set), llmExtractedArgs will be
 * undefined and resolveToolArgs returns {}.  This function attempts to recover
 * the five required fields directly from the user's message using lightweight
 * regex patterns for the natural-language format we document in the
 * clarification prompt.
 *
 * Patterns recognised (case-insensitive):
 *   name      — "called <name>"  or  "named <name>"
 *   subject   — "subject[: ]<subject>"
 *   fromEmail — first email-like token (word@domain.tld)
 *   fromName  — "from <name> at <email>"
 *   body      — "body[: ]<text>"  (stops at "and then" for multi-step messages)
 *
 * Returns only the fields that matched; missing fields remain absent.
 * The caller merges these with any LLM-extracted args and then checks
 * completeness via hasAllCreateCampaignFields().
 */
function tryExtractFromMessage(message: string): Record<string, string> {
  const extracted: Record<string, string> = {};

  // name — "called Test Campaign" or "named Test Campaign"
  const nameMatch = message.match(
    /\b(?:called|named)\s+([^,]+?)(?=\s*,|\s+subject\b|\s+from\b|\s+body\b|$)/i,
  );
  if (nameMatch) {
    const v = (nameMatch[1] ?? "").trim();
    if (v) extracted.name = v;
  }

  // subject — "subject: Welcome Offer" or "subject Welcome Offer"
  const subjectMatch = message.match(
    /\bsubject[:\s]+([^,]+?)(?=\s*,|\s+from\b|\s+body\b|$)/i,
  );
  if (subjectMatch) {
    const v = (subjectMatch[1] ?? "").trim();
    if (v) extracted.subject = v;
  }

  // fromEmail — first email-address token in the message
  const emailMatch = message.match(/\b[\w.+%-]+@[\w.-]+\.[a-z]{2,}\b/i);
  if (emailMatch) extracted.fromEmail = emailMatch[0];

  // fromName — "from Saad at saad@example.com" → captures "Saad"
  const fromMatch = message.match(/\bfrom\s+(.+?)\s+at\s+[\w.+%-]+@/i);
  if (fromMatch) {
    const v = (fromMatch[1] ?? "").trim();
    if (v) extracted.fromName = v;
  }

  // body — "body: Hello everyone"  (stop before "and then" for multi-step inputs)
  const bodyMatch = message.match(/\bbody[:\s]+(.+?)(?=\s+and\s+then\b|$)/i);
  if (bodyMatch) {
    const v = (bodyMatch[1] ?? "").trim();
    if (v) extracted.body = v;
  }

  return extracted;
}

/**
 * Clarification message returned to the user when create_campaign is requested
 * but one or more required fields are absent from the resolved arguments.
 */
const CREATE_CAMPAIGN_CLARIFICATION =
  "To create a campaign I need a few details. Please provide:\n" +
  "- **name** — the campaign name\n" +
  "- **subject** — the email subject line\n" +
  "- **fromName** — the sender display name\n" +
  "- **fromEmail** — the sender email address\n" +
  "- **body** — the email body content\n\n" +
  "For example: *Create a campaign called Summer Sale, subject: Big Deals, " +
  "from John at john@example.com, body: Check out our latest offers.*";

// ── Agent ─────────────────────────────────────────────────────────────────────

export class CampaignAgent extends BaseAgent {
  readonly domain = "campaign" as const;

  constructor() {
    super("campaign");
  }

  async handle(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { intent, userId, llmExtractedArgs, activeCampaignId } = state;

    if (!isCampaignIntent(intent)) {
      const msg = `CampaignAgent received unhandled intent: ${intent ?? "undefined"}`;
      this.log.error({ intent, userId }, msg);
      return { error: msg };
    }

    const toolName = TOOL_MAP[intent];

    // Log extractedArgs before resolution so failures are diagnosable in prod.
    this.log.debug(
      {
        intent,
        toolName,
        userId,
        llmExtractedArgs: llmExtractedArgs
          ? {
              topLevelKeys:  Object.keys(llmExtractedArgs).filter((k) => k !== "filters"),
              filterKeys:    llmExtractedArgs.filters
                               ? Object.keys(llmExtractedArgs.filters)
                               : [],
            }
          : undefined,
      },
      "CampaignAgent received llmExtractedArgs",
    );

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
      "CampaignAgent resolved tool and args",
    );

    // ── create_campaign pre-dispatch validation ───────────────────────────────
    // All five required fields must be present before the MCP call is allowed.
    if (intent === "create_campaign") {
      let finalArgs = toolArgs;

      // When Gemini is unavailable, resolveToolArgs returns {} because
      // llmExtractedArgs.filters was never populated.  Attempt a lightweight
      // deterministic extraction from the raw user message as a fallback.
      if (!hasAllCreateCampaignFields(finalArgs)) {
        const fromMessage = tryExtractFromMessage(state.userMessage);
        if (Object.keys(fromMessage).length > 0) {
          // LLM-extracted fields take priority; message-extracted fields fill gaps.
          finalArgs = { ...fromMessage, ...finalArgs };
          this.log.debug(
            { intent, userId, extractedKeys: Object.keys(fromMessage) },
            "create_campaign deterministic extraction from userMessage",
          );
        }
      }

      if (!hasAllCreateCampaignFields(finalArgs)) {
        this.log.info(
          { intent, userId, resolvedArgKeys: Object.keys(finalArgs) },
          "create_campaign missing required fields — returning clarification",
        );
        return { toolName: undefined, toolArgs: {}, error: CREATE_CAMPAIGN_CLARIFICATION };
      }

      return { toolName, toolArgs: finalArgs };
    }

    return { toolName, toolArgs };
  }
}

export const campaignAgent = new CampaignAgent();
