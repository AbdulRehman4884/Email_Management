/**
 * src/agents/ScriptFileAgent.ts
 *
 * Script generation — chat side. When the user shares a CSV/XLSX and asks for
 * scripts, this agent parses the file and saves every valid company to the
 * database. No scripts are generated here (that happens on demand on the
 * company's script page), so nothing costs money and no approval is needed.
 *
 * Reply: a structured success result the web app renders as a card with a
 * link to the file's company list.
 */

import { BaseAgent } from "./BaseAgent.js";
import type { AgentGraphStateType } from "../graph/state/agentGraph.state.js";
import { formatParseReport, parseCompanyFile } from "../lib/parseCompanyFile.js";
import { saveScriptFile, ScriptGenerationError } from "../services/scriptGeneration.service.js";
import { asUserId } from "../types/common.js";

const MAX_USER_INSTRUCTIONS_CHARS = 500;

/** Shape the web app recognises (isScriptFileData) to render the saved-file card. */
export interface ScriptFileData {
  kind:         "script_file";
  fileId:       number;
  filename:     string;
  companyCount: number;
  totalRows:    number;
  reportLine:   string;
}

export class ScriptFileAgent extends BaseAgent {
  readonly domain = "scripts" as const;

  constructor() {
    super("ScriptFileAgent");
  }

  async handle(state: AgentGraphStateType): Promise<Partial<AgentGraphStateType>> {
    const file = state.pendingCsvFile;
    if (!file) {
      return { formattedResponse: "Please attach an Excel or CSV file with **Company Name** and **Website** columns." };
    }
    if (!state.rawToken || !state.userId) {
      return { pendingCsvFile: undefined, formattedResponse: "Authentication credentials are not available. Please log in again." };
    }

    const parsed = parseCompanyFile(file.fileContent);
    if (!parsed.ok) {
      return { pendingCsvFile: undefined, formattedResponse: parsed.error };
    }

    const reportLine = formatParseReport(parsed.report);
    if (parsed.rows.length === 0) {
      return {
        pendingCsvFile:    undefined,
        formattedResponse: `${reportLine}\n\nThere are no valid rows to save. Every row needs a company name and a working website.`,
      };
    }

    try {
      const saved = await saveScriptFile(
        {
          filename: file.filename,
          ...(state.userMessage.trim()
            ? { userInstructions: state.userMessage.trim().slice(0, MAX_USER_INSTRUCTIONS_CHARS) }
            : {}),
          report:    { ...parsed.report },
          companies: parsed.rows.map((r) => ({
            rowNumber:   r.rowNumber,
            companyName: r.companyName,
            website:     r.website,
            extraFields: r.extraFields,
          })),
        },
        { userId: asUserId(String(state.userId)), rawToken: state.rawToken },
      );

      this.log.info(
        { sessionId: state.sessionId, userId: state.userId, fileId: saved.fileId, companies: saved.companyCount },
        "Script file saved",
      );

      const data: ScriptFileData = {
        kind:         "script_file",
        fileId:       saved.fileId,
        filename:     saved.filename,
        companyCount: saved.companyCount,
        totalRows:    saved.totalRows,
        reportLine,
      };
      return {
        pendingCsvFile:    undefined,
        formattedResponse: JSON.stringify({
          status:  "success",
          intent:  "script_file_intake",
          message: `Saved **${saved.filename}** — ${reportLine} Open the file to pick a company and generate its scripts.`,
          data,
        }),
      };
    } catch (err) {
      this.log.warn(
        { sessionId: state.sessionId, error: err instanceof Error ? err.message : "unknown" },
        "Script file save failed",
      );
      return {
        pendingCsvFile:    undefined,
        formattedResponse: err instanceof ScriptGenerationError
          ? err.message
          : "I couldn't save the file right now. Please try again.",
      };
    }
  }
}

export const scriptFileAgent = new ScriptFileAgent();
