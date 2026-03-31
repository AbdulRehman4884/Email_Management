/**
 * src/lib/logger.ts
 *
 * Pino-based structured logger with sensitive field redaction.
 * All services and middleware must use this logger — never console.log.
 */

import pino from "pino";
import { env } from "../config/env.js";
import { SERVICE_NAME } from "../config/constants.js";

// ── Redacted fields ───────────────────────────────────────────────────────────

/**
 * Field paths that must never appear in logs.
 * Pino replaces these values with "[Redacted]".
 */
const SENSITIVE_LOG_FIELDS = [
  "password",
  "token",
  "rawToken",
  "authorization",
  "jwt",
  "secret",
  "apiKey",
  "api_key",
  "smtp.password",
  "req.headers.authorization",
  "req.headers[\"x-service-token\"]",
  "req.headers[\"x-forwarded-authorization\"]",
  // Tool argument secrets — prevent MCP payloads leaking into logs
  "toolArgs.password",
  "toolArgs.smtp.password",
  "data.toolArgs.password",
  "data.toolArgs.smtp.password",
];

// ── Root logger ───────────────────────────────────────────────────────────────

const transport = env.LOG_PRETTY
  ? pino.transport({ target: "pino-pretty", options: { colorize: true } })
  : undefined;

const rootLogger = pino(
  {
    name: SERVICE_NAME,
    level: env.LOG_LEVEL,
    redact: {
      paths: SENSITIVE_LOG_FIELDS,
      censor: "[Redacted]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a child logger scoped to a named component.
 * Use this in every module: `const log = createLogger("myModule")`.
 */
export function createLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}

/**
 * Dedicated child logger for the audit trail.
 * Imported by AuditLogService so all audit entries share the same root
 * configuration (redaction, timestamps, transport) and are identifiable
 * by `component: "audit"` in log aggregators.
 */
export const auditLogger: pino.Logger = rootLogger.child({ component: "audit" });

export type Logger = pino.Logger;
