/**
 * src/config/constants.ts
 *
 * Static, non-environment-dependent constants for agent-service.
 */

export const SERVICE_NAME = "agent-service";
export const SERVICE_VERSION = "1.0.0";

// Header names
export const REQUEST_ID_HEADER = "x-request-id";

// Approval workflow
/** Pending actions expire after this duration (ms) */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Redis TTLs
/** Session keys expire after 24 hours (seconds). */
export const SESSION_TTL_SECS = 24 * 60 * 60; // 86 400 s

// LLM
export const DEFAULT_LLM_MODEL = "claude-sonnet-4-6";
export const DEFAULT_LLM_MAX_TOKENS = 4096;
export const DEFAULT_LLM_TEMPERATURE = 0;

// MCP
/** Default timeout for a single MCP tool call (ms) */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 30_000;

// HTTP server
/**
 * How long to wait for in-flight requests to drain before forcing exit.
 * Used by the graceful shutdown handler in src/index.ts.
 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Keep-alive connection idle timeout (ms).
 * Set slightly above AWS ALB / common proxy idle timeout (60 s) to prevent
 * the load balancer from reusing a connection that Node has already decided
 * to close — which would cause 502 errors.
 */
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Maximum time allowed for the client to send all request headers after
 * opening a connection (ms).
 * Must be strictly greater than SERVER_KEEP_ALIVE_TIMEOUT_MS to avoid a
 * race condition on keep-alive connections.
 */
export const SERVER_HEADERS_TIMEOUT_MS = 66_000;
