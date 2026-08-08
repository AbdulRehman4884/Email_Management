/**
 * src/mcp/tools/settings/updateSmtpSettings.tool.ts
 *
 * Security notes:
 *  - password is accepted as write-only input and forwarded to MailFlow.
 *    It is NEVER logged, NEVER included in the tool response.
 *  - username is masked in the response for the same reason as getSmtpSettings.
 *  - The MailFlow API does not echo password back in the PATCH response.
 */

import { TOOL_NAMES, MASKED_VALUE } from "../../../config/constants.js";
import { UpdateSmtpSettingsSchema } from "../../../schemas/index.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { SmtpSettingsDisplay } from "../../../types/mailflow.js";

export const updateSmtpSettingsTool: McpToolDefinition<
  typeof UpdateSmtpSettingsSchema,
  SmtpSettingsDisplay
> = {
  name: TOOL_NAMES.UPDATE_SMTP_SETTINGS,

  description:
    "Updates SMTP configuration fields for the authenticated account. " +
    "Only supply fields that should change; omitted fields are left unchanged. " +
    "password is write-only and never returned. " +
    "Returns the updated settings with sensitive fields masked.",

  inputSchema: UpdateSmtpSettingsSchema,

  handler: async (input, context) => {
    // Log which fields are being updated — never log their values for sensitive fields
    const updatedFields = Object.keys(input).filter(
      (k) => input[k as keyof typeof input] !== undefined,
    );
    context.log.info({ updatedFields }, "Updating SMTP settings");

    try {
      // Forward the full input (including password if provided) to the API client.
      // The API client's maskSmtpRequest() ensures password is masked in its own logs.
      const settings = await context.mailflow.updateSmtpSettings({
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
        ...(input.encryption !== undefined ? { encryption: input.encryption } : {}),
        ...(input.fromEmail !== undefined ? { fromEmail: input.fromEmail } : {}),
        ...(input.fromName !== undefined ? { fromName: input.fromName } : {}),
      });

      // Mask username in response; password is never in the API response
      const display: SmtpSettingsDisplay = {
        ...settings,
        username: MASKED_VALUE,
      };

      context.log.info(
        { host: settings.host, port: settings.port, isVerified: settings.isVerified },
        "SMTP settings updated successfully",
      );

      return toolSuccess(display);
    } catch (err) {
      const error = serializeError(err);
      // Do NOT include input in the error log — it may contain password
      context.log.error({ error }, "Failed to update SMTP settings");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
