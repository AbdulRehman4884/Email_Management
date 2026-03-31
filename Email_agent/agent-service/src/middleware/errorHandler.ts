/**
 * src/middleware/errorHandler.ts
 *
 * Global error handler — must be the last middleware registered in app.ts.
 *
 * Handles four error categories in priority order:
 *
 *   1. SyntaxError from body-parser (malformed JSON) → 400 VALIDATION_ERROR
 *      The raw SyntaxError is never surfaced; only a safe message is returned.
 *
 *   2. Operational AppError (known, expected) → appropriate 4xx / 5xx
 *      - 4xx: message + details are safe to surface to the client
 *      - 5xx: message surfaced; details are always stripped (may contain internals)
 *
 *   3. Unknown / programming error → 500, generic message only
 *      Full detail is logged server-side but never exposed in the response.
 *
 * Stack traces are never included in any API response.
 * Sensitive information is never included in any API response.
 */

import type { Request, Response, NextFunction } from "express";
import { AppError, ErrorCode } from "../lib/errors.js";
import { sendFailure } from "../lib/apiResponse.js";
import { createLogger } from "../lib/logger.js";
import { env } from "../config/env.js";

const log = createLogger("errorHandler");

// ── Body-parser SyntaxError shape ────────────────────────────────────────────

interface BodyParserSyntaxError extends SyntaxError {
  status: number;
  body: unknown;
}

function isBodyParserError(err: unknown): err is BodyParserSyntaxError {
  return (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as BodyParserSyntaxError).status === 400
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  // ── 1. Malformed JSON body ─────────────────────────────────────────────────
  if (isBodyParserError(err)) {
    log.warn(
      { requestId: req.requestId, path: req.path },
      "Malformed JSON body",
    );
    sendFailure(res, 400, ErrorCode.VALIDATION_ERROR, "Request body contains invalid JSON");
    return;
  }

  // ── 2. Operational AppError ────────────────────────────────────────────────
  if (err instanceof AppError) {
    const is5xx = err.statusCode >= 500;

    if (is5xx) {
      log.error(
        { requestId: req.requestId, code: err.code, err },
        "Operational server error",
      );
    } else {
      log.warn(
        { requestId: req.requestId, code: err.code, message: err.message },
        "Request error",
      );
    }

    sendFailure(
      res,
      err.statusCode,
      err.code,
      err.message,
      // Strip details from 5xx — they may contain internal state
      // In development include them to aid debugging
      is5xx && env.NODE_ENV === "production" ? undefined : err.details,
    );
    return;
  }

  // ── 3. Unknown / programming error ────────────────────────────────────────
  log.error(
    { requestId: req.requestId, err },
    "Unhandled error",
  );

  sendFailure(
    res,
    500,
    ErrorCode.INTERNAL_ERROR,
    "An unexpected error occurred",
    // Never expose details for unknown errors, even in development
  );
}
