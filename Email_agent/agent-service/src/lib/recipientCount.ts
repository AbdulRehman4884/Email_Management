/**
 * src/lib/recipientCount.ts
 *
 * "How many recipients does Campaign 3 have?" (bug A-19). The recipient_status_help
 * intent used to answer from session state only, so a campaign named in the message
 * was ignored and the user got "I don't have an active campaign selected".
 */

import { mcpClientService } from "../services/mcpClient.service.js";
import { authFromState, campaignNameFrom, matchCampaigns, type CampaignRef } from "./campaignLookup.js";
import type { LLMIntentArguments } from "../schemas/llmIntent.schema.js";

interface CampaignWithCount extends CampaignRef {
  recipients?: number;
}

/** "does Campaign 3 have", "in BM AI Services", "for campaign 20" → the raw name/id text. */
function rawCampaignRef(message: string): string | undefined {
  const m =
    message.match(/\b(?:does|do)\s+(?:the\s+)?["']?(.+?)["']?\s+(?:have|has|contain)\b/i) ??
    message.match(/\b(?:in|for|of)\s+(?:the\s+)?["']?(.+?)["']?\s*(?:campaign)?\s*[?.!]*$/i);
  const v = m?.[1]?.trim();
  return v && !/^(i|we|you|it|this|that|my|our|the|all|total|campaigns?|(?:my|this|that|the)\s+campaigns?)$/i.test(v) ? v : undefined;
}

async function listCampaigns(state: { rawToken?: string | undefined; userId?: unknown }): Promise<CampaignWithCount[] | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  try {
    const result = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const env = result.data as { success?: boolean; data?: unknown } | undefined;
    if (result.isToolError || env?.success === false || !Array.isArray(env?.data)) return undefined;
    return (env.data as Array<Record<string, unknown>>)
      .filter((c) => c.id !== undefined && typeof c.name === "string")
      .map((c) => {
        const count = c.recipientCount ?? c.recieptCount;
        return {
          id: String(c.id),
          name: String(c.name),
          status: typeof c.status === "string" ? c.status : "unknown",
          ...(typeof count === "number" ? { recipients: count } : {}),
        };
      });
  } catch {
    return undefined;
  }
}

function describe(c: CampaignWithCount): string {
  if (c.recipients === undefined) return `I couldn't read the recipient count for **${c.name}** (#${c.id}).`;
  const n = c.recipients;
  const line = `**${c.name}** (#${c.id}) has **${n} ${n === 1 ? "recipient" : "recipients"}**.`;
  return n === 0 ? `${line} Upload a CSV with the 📎 button to add recipients.` : line;
}

/**
 * The answer for a recipient-count question, or undefined when the message names no
 * campaign and there is no active one (caller keeps its generic guidance).
 */
export async function recipientCountAnswer(state: {
  userMessage: string;
  llmExtractedArgs?: LLMIntentArguments | undefined;
  activeCampaignId?: string | undefined;
  rawToken?: string | undefined;
  userId?: unknown;
}): Promise<string | undefined> {
  const raw = rawCampaignRef(state.userMessage);
  const name = campaignNameFrom(state.llmExtractedArgs, state.userMessage);
  const idInMessage = state.userMessage.match(/#(\d+)\b|\bcampaign\s+id\s*(\d+)\b/i);
  const id = idInMessage?.[1] ?? idInMessage?.[2];
  if (!raw && !name && !id && !state.activeCampaignId) return undefined;

  const all = await listCampaigns(state);
  if (!all) return undefined;

  if (id) {
    const hit = all.find((c) => c.id === id);
    return hit ? describe(hit) : `I couldn't find campaign **#${id}** in your account.`;
  }
  for (const candidate of [raw, name]) {
    if (!candidate) continue;
    const matches = matchCampaigns(candidate, all) as CampaignWithCount[];
    if (matches.length === 1) return describe(matches[0]!);
    if (matches.length > 1) return matches.map(describe).join("\n");
  }
  if (raw || name) return `I couldn't find a campaign named **${raw ?? name}**. Say **list my campaigns** to see them.`;

  const active = all.find((c) => c.id === state.activeCampaignId);
  return active ? describe(active) : undefined;
}
