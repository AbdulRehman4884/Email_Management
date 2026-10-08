/**
 * src/mcp/tools/scripts/scriptFiles.tools.ts
 *
 * Script generation — persistence tools backed by the MailFlow backend.
 *
 *   save_script_file     — save a parsed company list (from a chat upload)
 *   get_script_company   — one company + its saved scripts (+ cached website text)
 *   save_company_script  — save/replace one script (and optionally cache website text)
 *
 * The user is always taken from the bearer token; no tool accepts a userId.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import {
  GetScriptCompanySchema,
  SaveCompanyScriptSchema,
  SaveScriptFileSchema,
} from "../../../schemas/enrichment.schemas.js";
import { serializeError } from "../../../lib/errors.js";
import { toolFailure, toolSuccess } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { SavedCompanyScript, SavedScriptFile, ScriptCompany } from "../../../types/scripts.js";

function failure(err: unknown) {
  const error = serializeError(err);
  return toolFailure(error.code, error.message, error.details);
}

export const saveScriptFileTool: McpToolDefinition<typeof SaveScriptFileSchema, SavedScriptFile> = {
  name: TOOL_NAMES.SAVE_SCRIPT_FILE,
  description:
    "Saves an uploaded company list (company name, website, extra columns) for script generation. " +
    "Does not generate any scripts and does not send anything.",
  inputSchema: SaveScriptFileSchema,
  handler: async (input, context) => {
    try {
      context.log.info({ filename: input.filename, companies: input.companies.length }, "save_script_file: starting");
      return toolSuccess(await context.mailflow.saveScriptFile(input));
    } catch (err) {
      return failure(err);
    }
  },
};

export const getScriptCompanyTool: McpToolDefinition<typeof GetScriptCompanySchema, ScriptCompany> = {
  name: TOOL_NAMES.GET_SCRIPT_COMPANY,
  description: "Returns one saved company from a script file, with its saved scripts.",
  inputSchema: GetScriptCompanySchema,
  handler: async (input, context) => {
    try {
      return toolSuccess(await context.mailflow.getScriptCompany(input.companyId, input.includeContent));
    } catch (err) {
      return failure(err);
    }
  },
};

export const saveCompanyScriptTool: McpToolDefinition<typeof SaveCompanyScriptSchema, SavedCompanyScript> = {
  name: TOOL_NAMES.SAVE_COMPANY_SCRIPT,
  description: "Saves (or replaces) one generated script — cold_email, cold_call or linkedin — for a saved company.",
  inputSchema: SaveCompanyScriptSchema,
  handler: async (input, context) => {
    try {
      const { companyId, scriptType, ...body } = input;
      context.log.info({ companyId, scriptType, status: body.status }, "save_company_script: starting");
      return toolSuccess(await context.mailflow.saveCompanyScript(companyId, scriptType, body));
    } catch (err) {
      return failure(err);
    }
  },
};
