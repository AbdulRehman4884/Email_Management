/**
 * src/mcp/tools/enrichment/validateEmail.tool.ts
 *
 * Validates an email address, classifies it as business/personal/unknown,
 * checks for disposable providers, and returns the domain.
 *
 * Uses Abstract API when ABSTRACT_API_KEY is configured; falls back to
 * heuristic domain-list matching otherwise (or on timeout/error).
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { ValidateEmailSchema } from "../../../schemas/enrichment.schemas.js";
import { toolSuccess } from "../../../types/common.js";
import { validateEmail } from "../../../services/enrichment/emailValidation.service.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { EmailValidationResult } from "../../../services/enrichment/emailValidation.service.js";

export { type EmailValidationResult };

export const validateEmailTool: McpToolDefinition<
  typeof ValidateEmailSchema,
  EmailValidationResult
> = {
  name: TOOL_NAMES.VALIDATE_EMAIL,

  description:
    "Validates an email address and classifies it as business, personal, or unknown. " +
    "Detects disposable/temporary email providers. Returns the domain, validity status, " +
    "and whether the email is a business address. Uses the Abstract API when configured, " +
    "with a heuristic fallback when the API key is absent or unavailable.",

  inputSchema: ValidateEmailSchema,

  handler: async (input, context) => {
    context.log.debug({ email: input.email }, "validate_email: starting");
    const result = await validateEmail(input.email);
    context.log.debug(
      { email: input.email, source: result.source, isValid: result.isValid },
      "validate_email: complete",
    );
    return toolSuccess(result);
  },
};
