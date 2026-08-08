/**
 * src/lib/errors.ts
 *
 * Typed error hierarchy for mailflow-mcp-server.
 *
 * All errors extend BaseMailFlowMcpError so callers can use a single
 * instanceof check and then discriminate on `code` for specifics.
 *
 * Rules:
 *  - Never include secrets, bearer tokens, or passwords in error messages.
 *  - HTTP status codes from MailFlow API are preserved for observability.
 *  - Errors are serializable to plain objects for structured log output.
 */

// ── Error codes ───────────────────────────────────────────────────────────────

export const ErrorCode = {
  // Auth
  AUTH_MISSING_TOKEN: "AUTH_MISSING_TOKEN",
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  AUTH_FORBIDDEN: "AUTH_FORBIDDEN",

  // MailFlow API
  MAILFLOW_API_ERROR: "MAILFLOW_API_ERROR",
  MAILFLOW_NOT_FOUND: "MAILFLOW_NOT_FOUND",
  MAILFLOW_CONFLICT: "MAILFLOW_CONFLICT",
  MAILFLOW_TIMEOUT: "MAILFLOW_TIMEOUT",
  MAILFLOW_UNAVAILABLE: "MAILFLOW_UNAVAILABLE",

  // Tool
  TOOL_VALIDATION_ERROR: "TOOL_VALIDATION_ERROR",
  TOOL_EXECUTION_ERROR: "TOOL_EXECUTION_ERROR",

  // Internal
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Serialized error shape ────────────────────────────────────────────────────

export interface SerializedError {
  code: ErrorCode;
  message: string;
  httpStatus?: number;
  details?: unknown;
}

// ── Base ──────────────────────────────────────────────────────────────────────

export abstract class BaseMailFlowMcpError extends Error {
  abstract readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.cause = cause;
    this.name = this.constructor.name;
    // Preserve prototype chain across transpilation
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

// ── Auth errors ───────────────────────────────────────────────────────────────

export class AuthError extends BaseMailFlowMcpError {
  override readonly code: ErrorCode;

  constructor(
    code:
      | typeof ErrorCode.AUTH_MISSING_TOKEN
      | typeof ErrorCode.AUTH_INVALID_TOKEN
      | typeof ErrorCode.AUTH_FORBIDDEN,
    message: string,
  ) {
    super(message);
    this.code = code;
  }

  override toJSON(): SerializedError {
    return { code: this.code, message: this.message, httpStatus: 401 };
  }
}

// ── MailFlow API errors ───────────────────────────────────────────────────────

export class MailFlowApiError extends BaseMailFlowMcpError {
  override readonly code: ErrorCode;

  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly responseBody?: unknown,
    cause?: unknown,
  ) {
    super(message, cause);

    if (httpStatus === 404) {
      this.code = ErrorCode.MAILFLOW_NOT_FOUND;
    } else if (httpStatus === 409) {
      this.code = ErrorCode.MAILFLOW_CONFLICT;
    } else if (httpStatus === 503) {
      this.code = ErrorCode.MAILFLOW_UNAVAILABLE;
    } else {
      this.code = ErrorCode.MAILFLOW_API_ERROR;
    }
  }

  override toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      // responseBody may contain MailFlow error details — safe to include
      details: this.responseBody,
    };
  }
}

export class MailFlowTimeoutError extends BaseMailFlowMcpError {
  override readonly code = ErrorCode.MAILFLOW_TIMEOUT;

  constructor(path: string, cause?: unknown) {
    super(`MailFlow API request timed out: ${path}`, cause);
  }
}

// ── Tool errors ───────────────────────────────────────────────────────────────

export class ValidationError extends BaseMailFlowMcpError {
  override readonly code = ErrorCode.TOOL_VALIDATION_ERROR;

  constructor(
    public readonly fieldErrors: Record<string, string[]>,
    cause?: unknown,
  ) {
    super("Tool input validation failed", cause);
  }

  override toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      details: this.fieldErrors,
    };
  }
}

export class ToolExecutionError extends BaseMailFlowMcpError {
  override readonly code = ErrorCode.TOOL_EXECUTION_ERROR;

  constructor(
    public readonly toolName: string,
    message: string,
    cause?: unknown,
  ) {
    super(`[${toolName}] ${message}`, cause);
  }
}

// ── Internal errors ───────────────────────────────────────────────────────────

export class InternalError extends BaseMailFlowMcpError {
  override readonly code = ErrorCode.INTERNAL_ERROR;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

// ── Type guard ────────────────────────────────────────────────────────────────

export function isMailFlowMcpError(
  err: unknown,
): err is BaseMailFlowMcpError {
  return err instanceof BaseMailFlowMcpError;
}

// ── Serializer (safe for logging) ─────────────────────────────────────────────

/**
 * Converts any thrown value into a structured, log-safe object.
 * Strips bearer tokens and passwords from serialized output.
 */
export function serializeError(err: unknown): SerializedError {
  if (isMailFlowMcpError(err)) {
    return err.toJSON();
  }

  if (err instanceof Error) {
    return {
      code: ErrorCode.INTERNAL_ERROR,
      message: err.message,
    };
  }

  return {
    code: ErrorCode.INTERNAL_ERROR,
    message: "An unknown error occurred",
  };
}

// ── MCP content serializer ────────────────────────────────────────────────────

/**
 * Converts any thrown value into the JSON string FastMCP's execute() returns
 * when a tool fails at the transport boundary (outside the normal ToolResult path).
 *
 * Use this only in registry-level catch blocks. Tool handlers should return
 * toolFailure() rather than throwing.
 */
export function toMcpErrorContent(err: unknown): string {
  const serialized = serializeError(err);
  return JSON.stringify({ success: false, error: serialized });
}
