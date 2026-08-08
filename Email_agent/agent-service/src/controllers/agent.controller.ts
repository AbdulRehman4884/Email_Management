/**
 * src/controllers/agent.controller.ts
 *
 * Thin HTTP layer for the agent chat and approval workflow.
 *
 * Endpoints:
 *   POST /api/agent/chat    — submit a user message, get a response or approval prompt
 *   POST /api/agent/confirm — confirm a pending action and execute it
 *   POST /api/agent/cancel  — cancel a pending action without executing
 *
 * Controllers are intentionally thin:
 *   - Parse + validate request body (Zod)
 *   - Delegate to agentGraph / pendingActionService / toolExecutionService
 *   - Shape the response via agentResponseFormatter
 *   - Forward errors to errorHandler via next()
 *
 * The rawToken is NEVER stored — it is read from the current request's
 * authContext and forwarded to MCP calls only during the same request lifecycle.
 */

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sendSuccess } from "../lib/apiResponse.js";
import {
  formatChatSuccess,
  formatApprovalRequired,
  formatConfirmSuccess,
  formatCancelled,
  formatWorkflowError,
} from "../lib/agentResponseFormatter.js";
import { ValidationError, AppError, ErrorCode } from "../lib/errors.js";
import { agentGraph } from "../graph/workflow/agent.workflow.js";
import { pendingActionService } from "../services/pendingAction.service.js";
import { toolExecutionService } from "../services/toolExecution.service.js";
import { planExecutionService } from "../services/planExecution.service.js";
import { auditLogService } from "../services/auditLog.service.js";
import { asSessionId } from "../types/common.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import type { PlanStepResult } from "../lib/planTypes.js";

// ── Request schemas ───────────────────────────────────────────────────────────

const chatBodySchema = z.object({
  message:   z.string().min(1, "message is required").max(4000, "message too long"),
  sessionId: z.string().uuid("sessionId must be a valid UUID").optional(),
});

const actionBodySchema = z.object({
  pendingActionId: z.string().uuid("pendingActionId must be a valid UUID"),
});

// ── POST /api/agent/chat ──────────────────────────────────────────────────────

export async function chat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten());
    }

    const { message, sessionId: providedSessionId } = parsed.data;
    const authContext = req.authContext!;
    const sessionId  = asSessionId(providedSessionId ?? randomUUID());
    const ctx        = {
      userId:    authContext.userId as string,
      sessionId: sessionId as string,
      requestId: req.requestId as string | undefined,
    };

    auditLogService.chatReceived(ctx, {
      messageLength: message.length,
      sessionId: sessionId as string,
    });

    const result = await agentGraph.invoke({
      userMessage: message,
      sessionId,
      userId:    authContext.userId,
      rawToken:  authContext.rawToken,
      messages:  [],
    } satisfies Partial<AgentGraphStateType>);

    // ── Approval required ────────────────────────────────────────────────────
    if (result.requiresApproval && result.pendingActionId) {
      const action = await pendingActionService.findById(result.pendingActionId);

      if (!action) {
        throw new AppError(
          500,
          ErrorCode.INTERNAL_ERROR,
          "Pending action was created but could not be retrieved",
        );
      }

      sendSuccess(res, formatApprovalRequired(
        sessionId as string,
        result.finalResponse ?? "Please confirm this action to proceed.",
        action,
      ));
      return;
    }

    // ── Chat response ─────────────────────────────────────────────────────────
    // `result.finalResponse` is the authoritative output for every non-approval
    // path — it is always set by either clarificationNode (needs_input) or
    // finalResponseNode (success/error).  We do NOT branch on `result.error`
    // here: state.error may be set by a domain agent as a clarification signal,
    // but clarificationNode has already processed it into a structured JSON
    // finalResponse.  Checking state.error first would bypass that and return
    // the raw markdown clarification text instead of the normalised JSON object.
    sendSuccess(res, formatChatSuccess(
      sessionId as string,
      result.finalResponse ?? "",
      result.toolResult,
    ));

  } catch (err) {
    next(err);
  }
}

// ── POST /api/agent/confirm ───────────────────────────────────────────────────

export async function confirm(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = actionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten());
    }

    const { pendingActionId } = parsed.data;
    const authContext = req.authContext!;
    const ctx = {
      userId:    authContext.userId as string,
      requestId: req.requestId as string | undefined,
    };

    auditLogService.confirmReceived(ctx, { pendingActionId });

    // Atomically transition pending → confirmed (prevents double-execution)
    const action = await pendingActionService.confirm(
      pendingActionId,
      authContext.userId,
    );

    // ── Multi-step plan resumption ────────────────────────────────────────────
    if (action.planContext) {
      const { results, error } = await planExecutionService.resumePlan(
        action.planContext,
        authContext.rawToken!,
        action.userId,
        action.sessionId,
      );

      await pendingActionService.markExecuted(action.id);

      const allResults: PlanStepResult[] = [
        ...action.planContext.completedResults,
        ...results,
      ];

      auditLogService.pendingActionExecuted(
        { userId: authContext.userId as string, sessionId: action.sessionId as string },
        {
          pendingActionId: action.id,
          intent:          action.intent,
          toolName:        action.toolName,
          success:         !error,
        },
      );

      if (error) {
        sendSuccess(res, formatWorkflowError(
          `The operation could not be completed: ${error}`,
        ));
        return;
      }

      // Format a multi-step result response
      const response = formatPlanConfirmSuccess(allResults);
      sendSuccess(res, response);
      return;
    }

    // ── Single-step execution (existing path) ─────────────────────────────────

    // Construct minimal execution state from the stored action
    const execState: AgentGraphStateType = {
      messages:         [],
      userMessage:      "",
      sessionId:        action.sessionId,
      userId:           action.userId,
      rawToken:         authContext.rawToken, // from current request — never stored
      intent:           action.intent,
      confidence:       1.0,
      agentDomain:      undefined,
      llmExtractedArgs: undefined,
      toolName:         action.toolName,
      toolArgs:         action.toolArgs,
      toolResult:       undefined,
      requiresApproval: false,
      pendingActionId:  action.id,
      finalResponse:    undefined,
      error:            undefined,
      activeCampaignId: undefined,
      plan:             undefined,
      planIndex:        0,
      planResults:      [],
    };

    const patch = await toolExecutionService.executeFromState(execState);

    // Mark as executed regardless of isToolError — the tool ran
    await pendingActionService.markExecuted(action.id);

    auditLogService.pendingActionExecuted(
      { userId: authContext.userId as string, sessionId: action.sessionId as string },
      {
        pendingActionId: action.id,
        intent:          action.intent,
        toolName:        action.toolName,
        success:         !patch.error && !(patch.toolResult?.isToolError),
      },
    );

    if (patch.error) {
      sendSuccess(res, formatWorkflowError(
        `The operation could not be completed: ${patch.error}`,
      ));
      return;
    }

    sendSuccess(res, formatConfirmSuccess(action.intent, patch.toolResult));

  } catch (err) {
    next(err);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Returns a brief human-readable description of a tool result without
 * embedding raw JSON.  Mirrors the logic in finalResponse.node.ts
 * describeToolResult so both chat and confirm paths behave consistently.
 */
function describeConfirmStepResult(toolName: string, data: unknown): string {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return "Completed.";

  const d = data as Record<string, unknown>;

  switch (toolName) {
    case "create_campaign":
    case "update_campaign": {
      const name   = typeof d.name   === "string" ? d.name   : "untitled";
      const status = typeof d.status === "string" ? d.status : "created";
      return `Campaign "${name}" — status: ${status}.`;
    }
    case "start_campaign":
    case "pause_campaign":
    case "resume_campaign": {
      const name = typeof d.name === "string" ? d.name : typeof d.id === "string" ? d.id : "";
      const verb = toolName.replace(/_/g, " ");
      return name ? `Campaign "${name}" — ${verb} successfully.` : `${verb} completed.`;
    }
    case "get_campaign_stats": {
      const sent     = typeof d.sent     === "number" ? d.sent     : 0;
      const openRate = typeof d.openRate === "number" ? Math.round(d.openRate * 100) : 0;
      return `Sent ${sent.toLocaleString()} emails (${openRate}% open rate).`;
    }
    case "list_replies":
    case "summarize_replies": {
      const total = typeof d.total === "number" ? d.total
        : Array.isArray(d.items) ? (d.items as unknown[]).length
        : 0;
      return `${total} ${total === 1 ? "reply" : "replies"} retrieved.`;
    }
    case "get_smtp_settings":
    case "update_smtp_settings": {
      const host = typeof d.host === "string" ? d.host : "";
      const port = typeof d.port === "number" ? d.port : "";
      return host ? `SMTP: ${host}:${port}.` : "SMTP settings retrieved.";
    }
    default:
      return "Step completed.";
  }
}

/**
 * Formats a confirm response for a multi-step plan that has completed.
 * Shows a brief summary of each step's outcome — never embeds raw JSON.
 */
function formatPlanConfirmSuccess(results: PlanStepResult[]): { response: string } {
  if (results.length === 0) {
    return { response: "All plan steps completed." };
  }

  const lines: string[] = [
    results.length === 1 ? "1 step completed:" : `${results.length} steps completed:`,
    "",
  ];

  for (const r of results) {
    const label = `Step ${r.stepIndex + 1} (${r.toolName.replace(/_/g, " ")})`;
    if (r.toolResult.isToolError) {
      const detail = describeConfirmStepResult(r.toolName, r.toolResult.data);
      lines.push(`${label}: Error — ${detail}`);
    } else {
      lines.push(`${label}: ${describeConfirmStepResult(r.toolName, r.toolResult.data)}`);
    }
  }

  return { response: lines.join("\n") };
}

// ── POST /api/agent/cancel ────────────────────────────────────────────────────

export async function cancel(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = actionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid request body", parsed.error.flatten());
    }

    const { pendingActionId } = parsed.data;
    const authContext = req.authContext!;

    await pendingActionService.cancel(pendingActionId, authContext.userId);

    sendSuccess(res, formatCancelled());

  } catch (err) {
    next(err);
  }
}
