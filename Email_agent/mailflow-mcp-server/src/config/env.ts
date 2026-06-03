/**
 * src/config/env.ts
 *
 * Validates and exports all environment configuration using Zod.
 * The process exits immediately if any required variable is missing or invalid.
 * This must be the first module imported in src/index.ts.
 */

import "dotenv/config";
import { z } from "zod";

// ── Schema ────────────────────────────────────────────────────────────────────

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // MCP transport
  MCP_TRANSPORT: z.enum(["sse", "stdio"]).default("sse"),
  MCP_SSE_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MCP_SSE_ENDPOINT: z.string().startsWith("/").default("/sse"),

  // MailFlow API
  MAILFLOW_API_BASE_URL: z
    .string()
    .url("MAILFLOW_API_BASE_URL must be a valid URL"),
  MAILFLOW_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Auth
  MCP_SERVICE_SECRET: z
    .string()
    .min(32, "MCP_SERVICE_SECRET must be at least 32 characters"),
  MAILFLOW_SERVICE_ACCOUNT_TOKEN: z.string().optional(),

  // Public enrichment APIs (all optional)
  ABSTRACT_API_KEY:  z.string().optional(),
  JINA_API_KEY:      z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),

  // OpenAI — optional; Phase 3 AI analysis tools gracefully degrade when absent
  OPENAI_API_KEY:  z.string().optional(),
  OPENAI_MODEL:    z.string().default("gpt-4o-mini"),

  // Logging
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_PRETTY: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  // Mock mode — bypasses JWT validation; only permitted in development
  MOCK_MAILFLOW: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
}).refine(
  (data) => !(data.MOCK_MAILFLOW && data.NODE_ENV !== "development"),
  { message: "MOCK_MAILFLOW=true is only permitted when NODE_ENV=development" },
);

// ── Parse ─────────────────────────────────────────────────────────────────────

const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error(
    "[mailflow-mcp-server] Invalid environment configuration:\n",
    _parsed.error.format(),
  );
  process.exit(1);
}

// ── Export ────────────────────────────────────────────────────────────────────

export const env = _parsed.data;

export type Env = typeof env;
