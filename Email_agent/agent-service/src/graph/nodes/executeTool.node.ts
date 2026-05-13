/**
 * src/graph/nodes/executeTool.node.ts
 *
 * Executes the MCP tool that was selected and prepared by a domain agent node.
 *
 * This node runs only when requiresApproval=false (safe actions).
 * Risky actions (start_campaign, resume_campaign, update_smtp) are routed
 * directly to finalResponse by the conditional edge on the approval node —
 * they bypass this node until the user confirms via POST /api/agent/confirm.
 *
 * On success: sets state.toolResult
 * On failure: sets state.error (toolResult remains undefined)
 *
 * The finalResponse node reads both toolResult and error to shape its output.
 *
 * Audit events emitted:
 *   tool.attempt  — before the call starts
 *   tool.success  — when the service returns (even if isToolError=true)
 *   tool.failure  — when the service returns state.error or throws (auth errors)
 */

import { createLogger } from "../../lib/logger.js";
import { toolExecutionService } from "../../services/toolExecution.service.js";
import { auditLogService } from "../../services/auditLog.service.js";
import type { AgentGraphStateType } from "../state/agentGraph.state.js";

const log = createLogger("node:executeTool");

export async function executeToolNode(
  state: AgentGraphStateType,
): Promise<Partial<AgentGraphStateType>> {
  const { toolName, userId, sessionId } = state;

  log.debug({ toolName, sessionId }, "executeTool node entered");

  const ctx = {
    userId:    userId    as string | undefined,
    sessionId: sessionId as string | undefined,
  };

  auditLogService.toolAttempt(ctx, { toolName: toolName ?? "(unknown)" });

  const startMs = Date.now();

  try {
    const patch = await toolExecutionService.executeFromState(state);
    const durationMs = Date.now() - startMs;

    if (patch.error) {
      // Service swallowed the error into state — treat as failure for audit
      auditLogService.toolFailure(ctx, {
        toolName:     toolName ?? "(unknown)",
        durationMs,
        errorMessage: patch.error,
      });
      log.info(
        { toolName, userId, sessionId, durationMs, error: patch.error, toolArgs: state.toolArgs },
        "executeTool: FAILED — tool error in state",
      );
    } else {
      auditLogService.toolSuccess(ctx, {
        toolName:    toolName ?? "(unknown)",
        durationMs,
        isToolError: patch.toolResult?.isToolError ?? false,
      });
      log.info(
        {
          toolName, userId, sessionId, durationMs,
          isToolError:  patch.toolResult?.isToolError,
          resultData:   patch.toolResult?.data,
          toolArgs:     state.toolArgs,
        },
        "executeTool: SUCCESS — result data",
      );
    }

    return patch;

  } catch (err) {
    // Only auth errors propagate here (re-thrown by toolExecutionService)
    const durationMs = Date.now() - startMs;

    auditLogService.toolFailure(ctx, {
      toolName:     toolName ?? "(unknown)",
      durationMs,
      errorCode:
        err instanceof Error && "code" in err
          ? String((err as { code: unknown }).code)
          : undefined,
      errorMessage: err instanceof Error ? err.message : "unknown error",
    });

    throw err;
  }
}
