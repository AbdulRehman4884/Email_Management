/**
 * src/app.ts
 *
 * Configures and exports the Express application.
 * Does NOT start the HTTP server — that is done in src/index.ts.
 *
 * Middleware stack (in order):
 *  1. trust proxy     — accurate client IP when behind a load balancer
 *  2. helmet          — hardened security headers for a JSON API
 *  3. cors            — env-driven origin allow-list
 *  4. body parsers    — JSON + URL-encoded with configurable size limit
 *  5. requestLogger   — assigns requestId, logs arrival/completion
 *  6. global limiter  — per-IP throttle on all routes (health excluded)
 *  7. chat limiter    — stricter per-IP throttle on /api/agent/chat
 *  8. confirm limiter — strictest per-IP throttle on /api/agent/confirm
 *  9. routes          — all application routes
 * 10. notFound        — 404 catch-all
 * 11. errorHandler    — global error handler
 */

import express from "express";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import { rateLimit, type Options as RateLimitOptions } from "express-rate-limit";
import { env } from "./config/env.js";
import { REQUEST_ID_HEADER } from "./config/constants.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { notFound } from "./middleware/notFound.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { appRouter } from "./routes/index.js";
import type { Env } from "./config/env.js";

const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
// Must be set before any middleware that uses req.ip (rate limiter, logger).
if (env.TRUST_PROXY > 0) {
  app.set("trust proxy", env.TRUST_PROXY);
}

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    // This service returns JSON only — CSP is irrelevant and adds noise
    contentSecurityPolicy: false,

    // COEP is only meaningful for document contexts (iframes, workers)
    crossOriginEmbedderPolicy: false,

    // Allow cross-origin fetches consistent with the CORS policy below
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // No referrer information should leak from API responses
    referrerPolicy: { policy: "no-referrer" },

    // HSTS: enforce HTTPS in production only
    hsts: env.NODE_ENV === "production"
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors(buildCorsOptions(env)));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: env.BODY_SIZE_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: env.BODY_SIZE_LIMIT }));

// ── Request logging ───────────────────────────────────────────────────────────
app.use(requestLogger);

// ── Rate limiting — shared response shape ─────────────────────────────────────
const RATE_LIMIT_RESPONSE = {
  success: false,
  error: {
    code: "RATE_LIMITED",
    message: "Too many requests — please slow down and try again.",
  },
} as const;

const SHARED_RATE_LIMIT_OPTIONS: Partial<RateLimitOptions> = {
  standardHeaders: "draft-7", // RateLimit-* headers per IETF draft
  legacyHeaders: false,
  message: RATE_LIMIT_RESPONSE,
  // Skip unauthenticated preflight OPTIONS requests so CORS works unthrottled
  skip: (req) => req.method === "OPTIONS",
};

// ── Rate limiting — global ────────────────────────────────────────────────────
app.use(
  rateLimit({
    ...SHARED_RATE_LIMIT_OPTIONS,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    // Health endpoint must never be rate-limited (load balancer probes)
    skip: (req) => req.path === "/health" || req.method === "OPTIONS",
  }),
);

// ── Rate limiting — /api/agent/chat ──────────────────────────────────────────
// Stricter limit to control LLM cost and prevent prompt-flooding.
app.use(
  "/api/agent/chat",
  rateLimit({
    ...SHARED_RATE_LIMIT_OPTIONS,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.CHAT_RATE_LIMIT_MAX ?? 20,
  }),
);

// ── Rate limiting — /api/agent/confirm ───────────────────────────────────────
// Tightest limit to prevent brute-force enumeration of pending action IDs.
app.use(
  "/api/agent/confirm",
  rateLimit({
    ...SHARED_RATE_LIMIT_OPTIONS,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.CONFIRM_RATE_LIMIT_MAX ?? 10,
  }),
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use(appRouter);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use(notFound);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

export { app };

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds the cors() options from the environment configuration.
 *
 * Three modes:
 *   ""  (empty)  → deny all cross-origin requests (safe production default)
 *   "*"          → allow any origin without credentials (development only)
 *   "<list>"     → explicit allow-list with credentials and preflight caching
 */
function buildCorsOptions(envConfig: Env): CorsOptions {
  const raw = envConfig.CORS_ALLOWED_ORIGINS.trim();

  if (raw === "") {
    return { origin: false };
  }

  if (raw === "*") {
    return {
      origin: "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization"],
      exposedHeaders: [REQUEST_ID_HEADER],
    };
  }

  const allowed = raw.split(",").map((o) => o.trim()).filter(Boolean);

  return {
    origin(
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ): void {
      // Non-browser clients (no Origin header) are always permitted
      if (!requestOrigin || allowed.includes(requestOrigin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: [REQUEST_ID_HEADER],
    credentials: true,
    maxAge: 86_400, // cache preflight for 24 h
  };
}
