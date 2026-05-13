import { randomUUID } from "node:crypto";
import type {
  ActiveWorkflowLock,
  WorkflowType,
  WorkflowStackItem,
} from "../graph/state/agentGraph.state.js";
import { computeWorkflowDeadlineIso, WORKFLOW_PENDING_TTL_MS } from "./mcpErrorMapping.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";

export function createWorkflowLock(
  type: WorkflowType,
  opts: { interruptible: boolean; workflowId?: string } = { interruptible: false },
): ActiveWorkflowLock {
  const nowIso = new Date().toISOString();
  return {
    workflowId: opts.workflowId ?? randomUUID(),
    type,
    startedAtIso: nowIso,
    expiresAtIso: computeWorkflowDeadlineIso(),
    interruptible: opts.interruptible,
  };
}

export function isLockExpired(lock: ActiveWorkflowLock | undefined): boolean {
  if (!lock?.expiresAtIso) return false;
  const t = Date.parse(lock.expiresAtIso);
  if (Number.isNaN(t)) return true;
  return Date.now() > t;
}

export function isStackItemExpired(item: WorkflowStackItem): boolean {
  const t = Date.parse(item.createdAtIso);
  if (Number.isNaN(t)) return true;
  return Date.now() > t + WORKFLOW_PENDING_TTL_MS;
}

export function pushWorkflowStack(
  stack: WorkflowStackItem[] | undefined,
  item: Omit<WorkflowStackItem, "createdAtIso">,
): WorkflowStackItem[] {
  const next: WorkflowStackItem = {
    ...item,
    createdAtIso: new Date().toISOString(),
  };
  return [...(Array.isArray(stack) ? stack : []), next];
}

export function popWorkflowStack(
  stack: WorkflowStackItem[] | undefined,
): { nextStack: WorkflowStackItem[] | undefined; item: WorkflowStackItem | undefined } {
  if (!Array.isArray(stack) || stack.length === 0) return { nextStack: stack, item: undefined };
  const next = stack.slice(0, -1);
  const item = stack[stack.length - 1];
  return { nextStack: next.length > 0 ? next : undefined, item };
}

export function buildEnrichmentSnapshot(state: AgentGraphStateType): Partial<AgentGraphStateType> {
  return {
    activeCampaignId: state.activeCampaignId,
    campaignSelectionList: state.campaignSelectionList,
    pendingCsvData: state.pendingCsvData,
    pendingEnrichmentStep: state.pendingEnrichmentStep,
    pendingEnrichmentData: state.pendingEnrichmentData,
    pendingOutreachDraft: state.pendingOutreachDraft,
    pendingEnrichmentAction: state.pendingEnrichmentAction,
    pendingWorkflowDeadlineIso: state.pendingWorkflowDeadlineIso,
  };
}

export function clearEnrichmentUiState(): Partial<AgentGraphStateType> {
  return {
    pendingEnrichmentStep: undefined,
    pendingEnrichmentData: undefined,
    pendingOutreachDraft: undefined,
    pendingEnrichmentAction: undefined,
    pendingCsvData: undefined,
    campaignSelectionList: undefined,
    pendingWorkflowDeadlineIso: undefined,
  };
}

