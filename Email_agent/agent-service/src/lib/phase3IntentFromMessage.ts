/**
 * Deterministic Phase 3 intent from user text — used when enrichment wizard
 * would otherwise mis-route LLM-classified replies (e.g. general_help).
 */

import type { Intent } from "../config/intents.js";

export function inferPhase3IntentFromUserMessage(message: string): Intent | undefined {
  const m = message.trim();
  if (!m) return undefined;
  if (/\banalyze\s+company\b/i.test(m)) return "analyze_company";
  if (/\bdetect\s+pain\s+points?\b/i.test(m)) return "detect_pain_points";
  if (/\bgenerate\s+outreach\b/i.test(m)) return "generate_outreach";
  if (/\benrich\s+company\b/i.test(m) || /\bfully\s+enrich\b/i.test(m)) return "enrich_company";
  return undefined;
}
