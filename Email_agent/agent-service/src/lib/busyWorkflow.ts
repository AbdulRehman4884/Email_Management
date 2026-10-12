/**
 * src/lib/busyWorkflow.ts
 *
 * "Finish what you started" guard for multi-step chat flows.
 *
 * While a flow is waiting for the user's next answer (AI campaign setup,
 * campaign selection, enrichment review, bulk workflow…), a message that is
 * clearly a different command — a suggested-prompt chip or the same phrase
 * typed — must not be swallowed as the answer (e.g. "Show all campaigns"
 * becoming the campaign name). Instead the user gets a "busy" reply and the
 * flow stays exactly where it was.
 *
 * Only whole-message command phrases count, so real answers ("Summer Sale",
 * a subject line, "yes") are never blocked.
 */

import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";

/** Whole messages that are always a command, never a wizard answer. */
const COMMAND_PHRASES: ReadonlySet<string> = new Set([
  // Suggested-prompt chips in the web chat
  "create an ai campaign",
  "show all campaigns",
  "check smtp configuration",
  "show inbox replies",
  "generate personalized emails",
  "pause a campaign",
  "script generation",
  // Common typed forms of the same commands
  "create ai campaign",
  "create a campaign",
  "create campaign",
  "new campaign",
  "show campaigns",
  "list campaigns",
  "list all campaigns",
  "my campaigns",
  "check smtp",
  "smtp settings",
  "show smtp settings",
  "show replies",
  "show inbox",
  "inbox replies",
  "campaign stats",
  "show campaign stats",
  "campaign analytics",
  "campaign analysis",
  "show analytics",
  "pause campaign",
  "resume campaign",
  "resume a campaign",
  "start campaign",
  "start a campaign",
  "show hot leads",
]);

function normalise(message: string): string {
  return message.toLowerCase().trim().replace(/[.!?,;:]+$/g, "").replace(/\s+/g, " ").trim();
}

/** True when the whole message is a known command (chip text or its typed form). */
export function isStandaloneCommand(message: string): boolean {
  return COMMAND_PHRASES.has(normalise(message));
}

export interface ActiveWorkflow {
  /** Shown to the user: "You're in the middle of the {label}". */
  label: string;
  /** What the user can reply to stop the flow. */
  cancelWord: string;
}

/** The flow currently waiting for the user's answer, if any. */
export function activeWorkflow(state: AgentGraphStateType): ActiveWorkflow | undefined {
  if (state.pendingAiCampaignStep)      return { label: "AI campaign setup", cancelWord: "cancel" };
  if (state.pendingCampaignDraft)       return { label: "campaign setup", cancelWord: "cancel" };
  if (state.pendingSmtpSelectionAction) return { label: "SMTP selection", cancelWord: "cancel" };
  if (state.pendingCampaignAction)      return { label: "campaign selection", cancelWord: "cancel" };
  if (state.pendingEnrichmentStep || state.pendingEnrichmentAction) {
    return { label: "contact enrichment review", cancelWord: "discard" };
  }
  if (state.bulkWorkflow)               return { label: "bulk campaign workflow", cancelWord: "reset bulk workflow" };
  return undefined;
}

/**
 * Structured "busy" reply. The web chat shows it as a popup instead of a
 * chat message; other clients still get a readable message.
 */
export function buildBusyResponse(flow: ActiveWorkflow, command: string): string {
  return JSON.stringify({
    status:  "busy",
    intent:  "workflow_busy",
    message:
      `You're in the middle of the **${flow.label}**. Please finish it first, ` +
      `or reply **${flow.cancelWord}** to stop it — then try “${command.trim()}” again.`,
    activeWorkflow: flow.label,
  });
}
