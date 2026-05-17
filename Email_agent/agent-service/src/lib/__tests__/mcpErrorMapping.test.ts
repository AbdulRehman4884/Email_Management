import { describe, it, expect } from "vitest";
import { ErrorCode, McpError } from "../errors.js";
import {
  isTransientMcpOrNetworkError,
  toUserSafeMcpMessage,
  isWorkflowDeadlineExpired,
  computeWorkflowDeadlineIso,
} from "../mcpErrorMapping.js";

describe("mcpErrorMapping", () => {
  it("classifies transient errors", () => {
    expect(isTransientMcpOrNetworkError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientMcpOrNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isTransientMcpOrNetworkError(new McpError(ErrorCode.MCP_TIMEOUT, "slow"))).toBe(true);
  });

  it("treats MCP_ERROR with transient internalMessage as retryable (sanitized outer message)", () => {
    const e = new McpError(ErrorCode.MCP_ERROR, "Campaign service is temporarily unavailable.", {
      internalMessage: "connect ECONNREFUSED 127.0.0.1:4000",
    });
    expect(isTransientMcpOrNetworkError(e)).toBe(true);
  });

  it("does not classify validation-like messages as transient", () => {
    expect(isTransientMcpOrNetworkError(new Error("campaignId must be numeric"))).toBe(false);
  });

  it("never exposes localhost in user messages", () => {
    const msg = toUserSafeMcpMessage(new Error("ECONNREFUSED localhost:4000"));
    expect(msg.toLowerCase()).not.toContain("localhost");
    expect(msg.toLowerCase()).not.toContain("4000");
  });

  it("workflow deadline helpers", () => {
    expect(isWorkflowDeadlineExpired(undefined)).toBe(false);
    expect(isWorkflowDeadlineExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isWorkflowDeadlineExpired(computeWorkflowDeadlineIso())).toBe(false);
  });
});
