/**
 * src/lib/errors.ts
 *
 * Typed error hierarchy for agent-service.
 * All errors extend AppError so the errorHandler middleware can distinguish
 * operational errors (known, safe to surface) from programming errors.
 */

// ── Error codes ───────────────────────────────────────────────────────────────

export enum ErrorCode {
  // Auth
  AUTH_MISSING_TOKEN = "AUTH_MISSING_TOKEN",
  AUTH_INVALID_TOKEN = "AUTH_INVALID_TOKEN",
  AUTH_EXPIRED_TOKEN = "AUTH_EXPIRED_TOKEN",
  AUTH_FORBIDDEN = "AUTH_FORBIDDEN",

  // Validation
  VALIDATION_ERROR = "VALIDATION_ERROR",

  // Resource
  NOT_FOUND = "NOT_FOUND",
  CONFLICT = "CONFLICT",

  // Approval workflow
  APPROVAL_REQUIRED = "APPROVAL_REQUIRED",
  APPROVAL_EXPIRED = "APPROVAL_EXPIRED",
  APPROVAL_NOT_FOUND = "APPROVAL_NOT_FOUND",

  // MCP / downstream
  MCP_ERROR = "MCP_ERROR",
  MCP_TIMEOUT = "MCP_TIMEOUT",
  MCP_TOOL_ERROR = "MCP_TOOL_ERROR",

  // General
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

// ── Base class ────────────────────────────────────────────────────────────────

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── Subclasses ────────────────────────────────────────────────────────────────

export class AuthError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, ErrorCode.AUTH_FORBIDDEN, message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, ErrorCode.VALIDATION_ERROR, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, ErrorCode.NOT_FOUND, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, ErrorCode.CONFLICT, message);
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(
    message: string,
    details?: { pendingActionId: string; summary: string },
  ) {
    super(202, ErrorCode.APPROVAL_REQUIRED, message, details);
  }
}

export class McpError extends AppError {
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(502, code, message, details);
  }
}
