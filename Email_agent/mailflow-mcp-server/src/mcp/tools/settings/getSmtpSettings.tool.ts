/**
 * src/mcp/tools/settings/getSmtpSettings.tool.ts
 *
 * Security note:
 *  - The MailFlow API never returns the SMTP password in GET responses.
 *  - username is masked in the tool response to avoid leaking credential hints
 *    through the MCP channel (agent logs, LLM context windows, etc.).
 */

import { TOOL_NAMES, MASKED_VALUE } from "../../../config/constants.js";
import { GetSmtpSettingsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { SmtpSettingsDisplay } from "../../../types/mailflow.js";

export const getSmtpSettingsTool: McpToolDefinition<
  typeof GetSmtpSettingsSchema,
  SmtpSettingsDisplay
> = {
  name: TOOL_NAMES.GET_SMTP_SETTINGS,

  description:
    "Retrieves the SMTP configuration for the authenticated account. " +
    "Returns host, port, encryption type, fromEmail, fromName, and verification status. " +
    "Sensitive credential fields are masked in the response.",

  inputSchema: GetSmtpSettingsSchema,

  handler: async (_input, context) => {
    context.log.info("Fetching SMTP settings");

    try {
      const settings = await context.mailflow.getSmtpSettings();

      // Mask username — password is never returned by the API
      const display: SmtpSettingsDisplay = {
        ...settings,
        username: MASKED_VALUE,
      };

      context.log.info(
        { host: settings.host, port: settings.port, isVerified: settings.isVerified },
        "SMTP settings retrieved",
      );

      return toolSuccess(display);
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "Failed to fetch SMTP settings");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
