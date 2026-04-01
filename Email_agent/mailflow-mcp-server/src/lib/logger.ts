/**
 * src/lib/logger.ts
 *
 * Structured logger built on Pino.
 *
 * Security rules enforced here:
 *  - Bearer tokens are never logged (redacted at the serializer level)
 *  - SMTP passwords and other sensitive fields are masked
 *  - pino-pretty is enabled only when LOG_PRETTY=true (development)
 */

import pino, { type Logger, type LoggerOptions } from "pino";
import { env } from "../config/env.js";
import { MASKED_VALUE, SENSITIVE_LOG_FIELDS } from "../config/constants.js";

// ── Sensitive-field redaction ─────────────────────────────────────────────────

/**
 * Pino redact paths — these are dot-notation paths in the log object.
 * We redact top-level sensitive keys and nested versions under common shapes.
 */
const redactPaths: string[] = [
  ...SENSITIVE_LOG_FIELDS,
  ...SENSITIVE_LOG_FIELDS.map((f) => `*.${f}`),
  ...SENSITIVE_LOG_FIELDS.map((f) => `req.headers.${f}`),
  "req.headers.authorization",
  "req.headers.x-service-token",
  "req.headers.x-forwarded-authorization",
];

// ── Logger options ────────────────────────────────────────────────────────────

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: {
    service: "mailflow-mcp-server",
    env: env.NODE_ENV,
  },
  redact: {
    paths: redactPaths,
    censor: MASKED_VALUE,
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// ── Transport (pretty-print in development) ───────────────────────────────────

const transportOptions: LoggerOptions["transport"] = env.LOG_PRETTY
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    }
  : undefined;

// ── Instance ──────────────────────────────────────────────────────────────────

export const logger: Logger = pino(
  baseOptions,
  transportOptions
    ? pino.transport(transportOptions)
    : undefined,
);

// ── Child logger factory ──────────────────────────────────────────────────────

/**
 * Creates a child logger with a fixed `context` binding.
 * Use this inside service and tool modules for scoped log output.
 *
 * @example
 * const log = createLogger("createCampaign.tool");
 * log.info({ campaignId }, "Campaign created");
 */
export function createLogger(context: string): Logger {
  return logger.child({ context });
}

// ── Safe object sanitizer ─────────────────────────────────────────────────────

/**
 * Strips known sensitive keys from a plain object before passing it to a log
 * statement. Use this when logging request/response bodies that may contain
 * passwords, tokens, or other secrets that pino's path-based redact might miss
 * (e.g., nested or dynamically keyed objects).
 *
 * Returns a shallow copy — does not mutate the original.
 *
 * @example
 * log.info({ body: sanitizeForLog(requestBody) }, "Incoming request");
 */
export function sanitizeForLog(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const sensitiveSet = new Set(SENSITIVE_LOG_FIELDS);
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = sensitiveSet.has(key.toLowerCase()) ? MASKED_VALUE : value;
  }

  return result;
}
