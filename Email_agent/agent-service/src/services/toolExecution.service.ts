/**
 * src/services/toolExecution.service.ts
 *
 * Graph adapter — bridges LangGraph state to the MCP tool layer.
 *
 * This service is the single point called by the executeTool graph node.
 * It is responsible for:
 *
 *   1. Reading toolName, toolArgs, rawToken, userId from graph state
 *   2. Validating that the tool name is known
 *   3. Constructing an AuthContext from the state credentials
 *   4. For create_campaign: resolving smtpSettingsId via pre-dispatch SMTP lookup
 *      if it is not already present in toolArgs (see resolveSmtpForCreateCampaign).
 *   5. Delegating to McpClientService.dispatch()
 *   6. Returning a state patch:
 *        - { toolResult }   on success
 *        - { error }        on any recoverable failure (logged; not thrown)
 *
 * Only McpError instances that are unrecoverable (e.g. AUTH errors) are
 * re-thrown; all other errors are captured into state.error so the
 * finalResponse node can produce a user-facing message without crashing.
 */

import { createLogger } from "../lib/logger.js";
import { McpError, ErrorCode } from "../lib/errors.js";
import { toUserSafeMcpMessage } from "../lib/mcpErrorMapping.js";
import { mcpClientService } from "./mcpClient.service.js";
import { isKnownTool } from "../types/tools.js";
import { asUserId } from "../types/common.js";
import type { AuthContext } from "../types/common.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";

const log = createLogger("toolExecution");

// ── Auth errors that should propagate (not be swallowed into state.error) ─────

const PROPAGATE_CODES = new Set<ErrorCode>([
  ErrorCode.AUTH_MISSING_TOKEN,
  ErrorCode.AUTH_INVALID_TOKEN,
  ErrorCode.AUTH_EXPIRED_TOKEN,
  ErrorCode.AUTH_FORBIDDEN,
]);

// ── Service ───────────────────────────────────────────────────────────────────

export class ToolExecutionService {
  /**
   * Executes the MCP tool described in graph state and returns a state patch.
   *
   * Always resolves (never rejects) unless an auth error occurs.
   * The caller (executeToolNode) can merge the returned patch directly into state.
   */
  async executeFromState(
    state: AgentGraphStateType,
  ): Promise<Partial<AgentGraphStateType>> {
    const { toolName, toolArgs, rawToken, userId, sessionId } = state;

    // ── Pre-flight checks ────────────────────────────────────────────────────

    if (!toolName) {
      log.warn({ sessionId }, "executeFromState: toolName missing in state");
      return { error: "No tool was selected for this request." };
    }

    if (!rawToken) {
      log.warn({ sessionId, toolName }, "executeFromState: rawToken missing in state");
      return { error: "Authentication credentials are not available. Please log in again." };
    }

    if (!isKnownTool(toolName)) {
      log.error({ sessionId, toolName }, "executeFromState: unknown tool name in state");
      return { error: `Unknown tool "${toolName}". This is an internal configuration error.` };
    }

    // ── Construct auth context ───────────────────────────────────────────────

    const authContext: AuthContext = {
      // userId may be undefined for service-account calls; fallback keeps
      // the type satisfied — actual authorization is enforced by the bearer token.
      userId: userId ?? asUserId("unknown"),
      rawToken,
    };

    // ── Execute ──────────────────────────────────────────────────────────────

    // For create_campaign: inject smtpSettingsId before dispatch if absent.
    // The MCP tool resolves SMTP internally via listSmtpProfiles(), but that
    // call can silently return id:0 (parsing edge case) causing the backend to
    // reject with "smtpSettingsId is required". Pre-resolving here guarantees
    // a valid id reaches the MCP tool regardless of that internal lookup.
    let resolvedToolArgs = toolArgs as Record<string, unknown>;
    if (toolName === "create_campaign" && !resolvedToolArgs.smtpSettingsId) {
      const smtpResolution = await this.resolveSmtpForCreateCampaign(authContext, sessionId);
      if (smtpResolution.error) {
        log.warn({ sessionId, userId, error: smtpResolution.error }, "create_campaign: SMTP pre-resolution failed");
        return { error: smtpResolution.error };
      }
      if (smtpResolution.smtpSettingsId) {
        resolvedToolArgs = { ...resolvedToolArgs, smtpSettingsId: smtpResolution.smtpSettingsId };
        log.info(
          { sessionId, userId, smtpSettingsId: smtpResolution.smtpSettingsId, fromEmail: smtpResolution.fromEmail },
          "create_campaign: smtpSettingsId injected before MCP dispatch",
        );
      }
    }

    const startMs = Date.now();
    log.info({ toolName, userId, sessionId, toolArgs: resolvedToolArgs }, "Executing MCP tool — toolArgs (final)");

    try {
      const toolResult = await mcpClientService.dispatch(
        toolName,
        resolvedToolArgs,
        authContext,
      );

      log.info(
        {
          toolName,
          userId,
          sessionId,
          durationMs: Date.now() - startMs,
          isToolError: toolResult.isToolError,
        },
        "Tool executed successfully",
      );

      return { toolResult };

    } catch (err) {
      const durationMs = Date.now() - startMs;

      if (err instanceof McpError) {
        // Auth errors are re-thrown — the HTTP layer handles them as 401/403
        if (PROPAGATE_CODES.has(err.code)) {
          throw err;
        }

        log.error(
          { toolName, userId, sessionId, durationMs, code: err.code, message: err.message },
          "MCP tool error",
        );

        return { error: this.userMessage(err) };
      }

      // Unknown error — log full detail, return generic message
      log.error(
        { toolName, userId, sessionId, durationMs, err },
        "Unexpected error during tool execution",
      );

      return { error: "An unexpected error occurred while processing your request. Please try again." };
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private userMessage(err: McpError): string {
    return toUserSafeMcpMessage(err);
  }

  /**
   * Pre-dispatch SMTP resolver for create_campaign.
   *
   * Calls get_smtp_settings to obtain the authenticated user's SMTP profile and
   * extracts a valid numeric smtpSettingsId. This bypasses a parsing edge-case
   * in the MCP tool's internal listSmtpProfiles() that can return id:0 (from
   * Number(undefined ?? 0)), causing the backend to reject with
   * "smtpSettingsId is required".
   *
   * Returns:
   *   { smtpSettingsId, fromEmail } — inject these into toolArgs before dispatch
   *   { }                           — skip injection; let MCP tool handle SMTP
   *   { error }                     — surface to caller (e.g. auth failures)
   *
   * Never throws — all errors are caught and logged.
   */
  private async resolveSmtpForCreateCampaign(
    authContext: AuthContext,
    sessionId: string | undefined,
  ): Promise<{ smtpSettingsId?: number; fromEmail?: string; error?: string }> {
    try {
      const result = await mcpClientService.dispatch("get_smtp_settings", {}, authContext);

      if (result.isToolError) {
        // Transport-level error — skip injection, MCP tool will emit its own error
        log.warn({ sessionId }, "create_campaign: SMTP pre-resolution — get_smtp_settings transport error; skipping injection");
        return {};
      }

      const envelope = result.data as Record<string, unknown> | undefined;
      if (!envelope || envelope.success === false) {
        // No SMTP configured — let MCP tool produce NO_SMTP_PROFILES
        log.warn({ sessionId }, "create_campaign: SMTP pre-resolution — no SMTP settings returned; skipping injection");
        return {};
      }

      // Unwrap { success: true, data: SmtpSettingsDisplay }
      const settings =
        typeof envelope.data === "object" && envelope.data !== null
          ? (envelope.data as Record<string, unknown>)
          : envelope;

      const rawId = settings.id;
      const smtpSettingsId =
        typeof rawId === "string"  ? parseInt(rawId, 10)
        : typeof rawId === "number" ? rawId
        : NaN;

      if (!Number.isFinite(smtpSettingsId) || smtpSettingsId < 1) {
        log.warn({ sessionId, rawId }, "create_campaign: SMTP pre-resolution — invalid id in settings; skipping injection");
        return {};
      }

      const fromEmail =
        typeof settings.fromEmail === "string" ? settings.fromEmail : undefined;

      return { smtpSettingsId, fromEmail };
    } catch (err) {
      log.warn({ sessionId, err }, "create_campaign: SMTP pre-resolution threw — skipping injection");
      return {};
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const toolExecutionService = new ToolExecutionService();
