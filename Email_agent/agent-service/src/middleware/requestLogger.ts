/**
 * src/middleware/requestLogger.ts
 *
 * Assigns a unique requestId to every incoming request and logs
 * arrival + completion with duration. No sensitive headers are logged.
 *
 * requestId resolution order:
 *   1. X-Request-ID header (REQUEST_ID_HEADER constant)
 *   2. X-Correlation-ID header (external gateway / tracing systems)
 *   3. freshly generated UUID
 *
 * The resolved id is echoed back via the X-Request-ID response header so
 * clients can correlate logs with responses.
 *
 * Completion log includes userId (from authContext populated by requireAuth)
 * and sessionId (from the parsed request body) so every request can be
 * traced back to a user and session without needing to join separate logs.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.js";
import { asRequestId } from "../types/common.js";
import { REQUEST_ID_HEADER } from "../config/constants.js";

const CORRELATION_ID_HEADER = "x-correlation-id";

const log = createLogger("requestLogger");

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id =
    (req.headers[REQUEST_ID_HEADER] as string | undefined) ??
    (req.headers[CORRELATION_ID_HEADER] as string | undefined) ??
    randomUUID();

  req.requestId = asRequestId(id);
  res.setHeader(REQUEST_ID_HEADER, id);

  const start = Date.now();

  log.info(
    { requestId: id, method: req.method, path: req.path },
    "Request received",
  );

  res.on("finish", () => {
    const ms = Date.now() - start;

    // authContext is populated by requireAuth which runs after this middleware,
    // but it is available by the time "finish" fires.
    const userId    = req.authContext?.userId;
    // sessionId may appear in body (chat/confirm/cancel) or be undefined
    const sessionId = (req.body as Record<string, unknown> | undefined)?.sessionId;

    log.info(
      {
        requestId: id,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: ms,
        ...(userId    ? { userId }    : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      "Request completed",
    );
  });

  next();
}
