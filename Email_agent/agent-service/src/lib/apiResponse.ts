/**
 * src/lib/apiResponse.ts
 *
 * Typed response envelope helpers.
 * All route handlers must use these to ensure consistent shape across the API.
 */

import type { Response } from "express";

// ── Response shapes ───────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
): void {
  const body: ApiSuccess<T> = {
    success: true,
    data,
    requestId: res.req.requestId,
  };
  res.status(statusCode).json(body);
}

export function sendFailure(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: ApiFailure = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
    requestId: res.req.requestId,
  };
  res.status(statusCode).json(body);
}
