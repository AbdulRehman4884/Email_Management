/**
 * src/services/scriptGeneration.service.ts
 *
 * Script generation — the MCP calls behind the chat upload and the script page.
 *
 *   saveScriptFile()   parsed company list → save_script_file (backend DB)
 *   generateScript()   one company + one channel, on demand:
 *                        get_script_company → (fetch_website_content, first time only)
 *                        → generate_outreach_script → save_company_script
 *
 * Everything runs with the requesting user's own token, so the backend scopes
 * every read/write to that user. Nothing is queued in the background.
 */

import { createLogger } from "../lib/logger.js";
import { mcpClientService } from "./mcpClient.service.js";
import type { AuthContext } from "../types/common.js";
import type { McpToolResult } from "../types/mcp.js";
import type { SaveScriptFileInput, ScriptType } from "../types/tools.js";

const log = createLogger("scriptGeneration");

export const SCRIPT_TYPES: readonly ScriptType[] = ["cold_email", "cold_call", "linkedin"];

export function isScriptType(v: unknown): v is ScriptType {
  return typeof v === "string" && (SCRIPT_TYPES as readonly string[]).includes(v);
}

/** Failure with an HTTP-ish status so the route can answer correctly. */
export class ScriptGenerationError extends Error {
  constructor(message: string, public readonly status: number, public override readonly cause?: unknown) {
    super(message);
    this.name = "ScriptGenerationError";
  }
}

// ── MCP envelope helpers ──────────────────────────────────────────────────────

/** Returns the tool's data, or throws a ScriptGenerationError for tool failures. */
function unwrap<T>(result: McpToolResult, what: string): T {
  const envelope = result.data as { success?: boolean; data?: unknown; error?: { code?: string; message?: string } } | undefined;
  if (result.isToolError || !envelope || typeof envelope !== "object") {
    throw new ScriptGenerationError(`Could not ${what}. Please try again.`, 502);
  }
  if (envelope.success === false) {
    const code = envelope.error?.code ?? "";
    if (code === "MAILFLOW_NOT_FOUND") throw new ScriptGenerationError("Company not found.", 404);
    throw new ScriptGenerationError(`Could not ${what}. Please try again.`, 502);
  }
  return (envelope.data ?? envelope) as T;
}

// ── Types (shapes returned by the backend via MCP) ────────────────────────────

export interface SavedScript {
  type:                ScriptType;
  status:              "ok" | "insufficient_data";
  angle:               "website" | "industry";
  whatTheySell:        string;
  problemStatement:    string;
  painPoints:          string[];
  recommendedServices: string[];
  subject:             string | null;
  script:              string;
  wordCount:           number;
  updatedAt:           string;
}

interface ScriptCompany {
  id:               number;
  companyName:      string;
  website:          string;
  extraFields:      Record<string, string>;
  userInstructions: string | null;
  websiteContent?:  string | null;
  scripts:          Partial<Record<ScriptType, SavedScript>>;
}

export interface SavedScriptFile {
  fileId:       number;
  filename:     string;
  companyCount: number;
  totalRows:    number;
}

// ── Automatic retry ───────────────────────────────────────────────────────────

/** MCP calls per step before giving up — the user should not have to click again. */
const MAX_CALL_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

/**
 * Runs one MCP call up to MAX_CALL_ATTEMPTS times. Retries thrown errors and
 * tool-level transport errors; a "not found" answer is final.
 */
async function dispatchWithRetry(
  run: () => Promise<McpToolResult>,
  what: string,
  logCtx: Record<string, unknown>,
): Promise<McpToolResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CALL_ATTEMPTS; attempt++) {
    try {
      const result = await run();
      const envelope = result.data as { success?: boolean; error?: { code?: string } } | undefined;
      const retryable = result.isToolError ||
        (envelope?.success === false && envelope.error?.code !== "MAILFLOW_NOT_FOUND" && envelope.error?.code !== "TOOL_VALIDATION_ERROR");
      if (!retryable || attempt === MAX_CALL_ATTEMPTS) return result;
      log.warn({ ...logCtx, what, attempt, code: envelope?.error?.code }, "Script step failed — retrying");
    } catch (err) {
      lastError = err;
      log.warn({ ...logCtx, what, attempt, error: err instanceof Error ? err.message : "unknown" }, "Script step threw — retrying");
      if (attempt === MAX_CALL_ATTEMPTS) break;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
  }
  throw new ScriptGenerationError(`Could not ${what}. Please try again.`, 502, lastError);
}

// ── Save an uploaded file ─────────────────────────────────────────────────────

export async function saveScriptFile(input: SaveScriptFileInput, auth: AuthContext): Promise<SavedScriptFile> {
  const result = await mcpClientService.dispatch("save_script_file", input, auth, { timeoutMs: 60_000 });
  return unwrap<SavedScriptFile>(result, "save the file");
}

// ── Generate one script ───────────────────────────────────────────────────────

/** Text shorter than this is not worth caching or sending to the AI. */
const MIN_CONTENT_CHARS = 200;

/**
 * Generates (or returns the saved) script of one type for one company.
 * A saved script is returned as-is unless `regenerate` is true, so a click on
 * an already-generated tab never costs anything.
 */
export async function generateScript(
  companyId: number,
  scriptType: ScriptType,
  auth: AuthContext,
  opts: { regenerate?: boolean } = {},
): Promise<{ script: SavedScript; cached: boolean }> {
  const ctx = { userId: auth.userId, companyId, scriptType };
  const company = unwrap<ScriptCompany>(
    await dispatchWithRetry(
      () => mcpClientService.dispatch("get_script_company", { companyId, includeContent: true }, auth),
      "load the company", ctx,
    ),
    "load the company",
  );

  const existing = company.scripts?.[scriptType];
  if (existing && !opts.regenerate) {
    return { script: existing, cached: true };
  }

  // Website text (home + about + services): fetched once per company and reused,
  // re-fetched on regenerate so "Try again" really looks at the site again.
  let websiteContent = opts.regenerate ? "" : company.websiteContent ?? "";
  let freshlyFetched = false;
  let scrapedPages: unknown;
  if (websiteContent.length < MIN_CONTENT_CHARS) {
    const fetched = await dispatchWithRetry(
      () => mcpClientService.dispatch("fetch_website_content", { url: company.website, includeSubpages: true }, auth, { timeoutMs: 60_000 }),
      "read the website", ctx,
    ).catch(() => undefined);
    const envelope = fetched?.data as { success?: boolean; data?: { content?: unknown; pages?: unknown } } | undefined;
    const content = fetched && !fetched.isToolError && envelope?.success !== false ? envelope?.data?.content : undefined;
    websiteContent = typeof content === "string" ? content : "";
    scrapedPages = envelope?.data?.pages;
    freshlyFetched = websiteContent.length >= MIN_CONTENT_CHARS;
  }

  // How much text the AI gets — tells at a glance whether a weak script is a scraping or an AI problem.
  log.info(
    { ...ctx, website: company.website, websiteChars: websiteContent.length, source: freshlyFetched ? "fetched" : websiteContent ? "cache" : "none", pages: scrapedPages },
    "Script generation: website text",
  );

  const generated = unwrap<Omit<SavedScript, "type" | "updatedAt" | "subject"> & { subject?: string }>(
    await dispatchWithRetry(
      () => mcpClientService.dispatch(
        "generate_outreach_script",
        {
          scriptType,
          companyName: company.companyName,
          website:     company.website,
          websiteContent,
          ...(Object.keys(company.extraFields ?? {}).length > 0 ? { extraFields: company.extraFields } : {}),
          ...(company.userInstructions ? { userInstructions: company.userInstructions } : {}),
        },
        auth,
        { timeoutMs: 90_000 },
      ),
      "generate the script", ctx,
    ),
    "generate the script",
  );

  const saved = unwrap<SavedScript>(
    await dispatchWithRetry(
      () => mcpClientService.dispatch(
        "save_company_script",
        {
          companyId,
          scriptType,
          status:              generated.status,
          angle:               generated.angle ?? "website",
          whatTheySell:        generated.whatTheySell ?? "",
          problemStatement:    generated.problemStatement ?? "",
          painPoints:          generated.painPoints ?? [],
          recommendedServices: generated.recommendedServices ?? [],
          ...(generated.subject ? { subject: generated.subject } : {}),
          script:              generated.script ?? "",
          wordCount:           generated.wordCount ?? 0,
          ...(freshlyFetched ? { websiteContent } : {}),
        },
        auth,
      ),
      "save the script", ctx,
    ),
    "save the script",
  );

  log.info(
    { ...ctx, status: saved.status, angle: saved.angle, wordCount: saved.wordCount, websiteChars: websiteContent.length, freshlyFetched },
    "Script generated",
  );
  return { script: saved, cached: false };
}
