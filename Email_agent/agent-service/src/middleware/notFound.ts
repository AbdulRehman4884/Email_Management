/**
 * src/middleware/notFound.ts
 *
 * Catches requests that did not match any route and returns a 404.
 * Must be registered after all routes in app.ts.
 */

import type { Request, Response } from "express";
import { sendFailure } from "../lib/apiResponse.js";
import { ErrorCode } from "../lib/errors.js";

export function notFound(req: Request, res: Response): void {
  sendFailure(
    res,
    404,
    ErrorCode.NOT_FOUND,
    `Route ${req.method} ${req.path} not found`,
  );
}
