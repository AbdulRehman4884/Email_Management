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

  // HTTP server
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * Number of trusted proxy hops in front of this service.
   * Set to 1 when behind a single reverse proxy / load balancer (e.g. AWS ALB).
   * Required for accurate IP-based rate limiting via req.ip.
   * See: https://expressjs.com/en/guide/behind-proxies.html
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  // Auth
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),

  // MCP server
  MCP_SERVER_URL: z
    .string()
    .url("MCP_SERVER_URL must be a valid URL"),
  MCP_SERVICE_SECRET: z
    .string()
    .min(32, "MCP_SERVICE_SECRET must be at least 32 characters"),

  // LLM — Anthropic (optional; not used by current provider stack)
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // Redis (optional; in-memory fallback used when absent)
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL").optional(),

  // LLM — Google Gemini (optional; kept for backwards compatibility)
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().default("gemini-1.5-flash"),

  // LLM — OpenAI (optional; required only if OpenAIService is used)
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),

  // Logging
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_PRETTY: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  // CORS
  /**
   * Comma-separated list of allowed request origins.
   *
   * Examples:
   *   "" (empty)                        → deny all cross-origin requests (production default)
   *   "*"                               → allow any origin, no credentials (dev only)
   *   "http://localhost:3001,https://app.example.com"  → specific allow-list with credentials
   *
   * In production, always set this to the explicit frontend origin(s).
   */
  CORS_ALLOWED_ORIGINS: z.string().default(""),

  // Body parsing
  /**
   * Maximum allowed size for a JSON request body.
   * Accepts byte-unit strings understood by the `bytes` library (e.g. "100kb", "1mb").
   * Default is 100kb — sufficient for any valid agent request (max message = 4 000 chars).
   */
  BODY_SIZE_LIMIT: z
    .string()
    .regex(
      /^\d+(?:b|kb|mb|gb)$/i,
      'BODY_SIZE_LIMIT must be a size string like "100kb" or "1mb"',
    )
    .default("100kb"),

  // Rate limiting — global
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // Rate limiting — per-route overrides (optional; defaults applied in app.ts)
  /**
   * Max requests per window for POST /api/agent/chat.
   * Defaults to 20 if not set. Set lower in production to protect LLM cost.
   */
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),

  /**
   * Max requests per window for POST /api/agent/confirm.
   * Defaults to 10 if not set. Prevents brute-force against pending action IDs.
   */
  CONFIRM_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
});

// ── Parse ─────────────────────────────────────────────────────────────────────

const _parsed = envSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error(
    "[agent-service] Invalid environment configuration:\n",
    _parsed.error.format(),
  );
  if (process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
  throw new Error("Invalid environment configuration");
}

// ── Export ────────────────────────────────────────────────────────────────────

export const env = _parsed.data;

export type Env = typeof env;
