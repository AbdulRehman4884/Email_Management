/**
 * src/services/__tests__/mcpToolCaller.test.ts
 *
 * Unit tests for McpToolCallerService.
 * The MCP client layer (openMcpSession) is mocked so no real network calls occur.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { McpToolCallerService } from "../mcpToolCaller.js";
import * as mcpClientModule from "../../lib/mcpClient.js";
import { McpError, ErrorCode } from "../../lib/errors.js";
import type { AuthContext } from "../../types/common.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAuthContext(overrides?: Partial<AuthContext>): AuthContext {
  return {
    userId: "user-123" as AuthContext["userId"],
    rawToken: "test-jwt-token",
    ...overrides,
  };
}

function makeSession(overrides?: {
  callToolResult?: unknown;
  callToolError?: Error;
}) {
  return {
    callTool: vi.fn().mockImplementation(() => {
      if (overrides?.callToolError) {
        return Promise.reject(overrides.callToolError);
      }
      return Promise.resolve(
        overrides?.callToolResult ?? {
          content: [{ type: "text", text: '{"ok":true}' }],
          isError: false,
        },
      );
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("McpToolCallerService", () => {
  let service: McpToolCallerService;
  let openMcpSessionSpy: Mock;

  beforeEach(() => {
    service = new McpToolCallerService();
    openMcpSessionSpy = vi
      .spyOn(mcpClientModule, "openMcpSession")
      .mockResolvedValue(makeSession()) as Mock;
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns parsed JSON data from a text content block", async () => {
    openMcpSessionSpy.mockResolvedValue(
      makeSession({
        callToolResult: {
          content: [{ type: "text", text: '{"id":"camp-1","name":"Test"}' }],
          isError: false,
        },
      }),
    );

    const result = await service.call(
      "get_campaign_stats",
      { campaignId: "camp-1" },
      makeAuthContext(),
    );

    expect(result.data).toEqual({ id: "camp-1", name: "Test" });
    expect(result.isToolError).toBe(false);
    expect(result.rawContent).toEqual(['{"id":"camp-1","name":"Test"}']);
  });

  it("returns raw string when content is not valid JSON", async () => {
    openMcpSessionSpy.mockResolvedValue(
      makeSession({
        callToolResult: {
          content: [{ type: "text", text: "Campaign started." }],
          isError: false,
        },
      }),
    );

    const result = await service.call("start_campaign", { campaignId: "c1" }, makeAuthContext());

    expect(result.data).toBe("Campaign started.");
    expect(result.isToolError).toBe(false);
  });

  it("returns null data when content array is empty", async () => {
    openMcpSessionSpy.mockResolvedValue(
      makeSession({ callToolResult: { content: [], isError: false } }),
    );

    const result = await service.call("pause_campaign", { campaignId: "c1" }, makeAuthContext());

    expect(result.data).toBeNull();
    expect(result.rawContent).toHaveLength(0);
  });

  it("surfaces isToolError=true when MCP tool signals an error", async () => {
    openMcpSessionSpy.mockResolvedValue(
      makeSession({
        callToolResult: {
          content: [{ type: "text", text: '{"error":"Campaign not found"}' }],
          isError: true,
        },
      }),
    );

    const result = await service.call("pause_campaign", { campaignId: "bad" }, makeAuthContext());

    expect(result.isToolError).toBe(true);
    expect(result.data).toEqual({ error: "Campaign not found" });
  });

  it("closes the session after a successful call", async () => {
    const session = makeSession();
    openMcpSessionSpy.mockResolvedValue(session);

    await service.call("start_campaign", { campaignId: "c1" }, makeAuthContext());

    expect(session.close).toHaveBeenCalledOnce();
  });

  // ── Error cases ─────────────────────────────────────────────────────────────

  it("throws McpError(MCP_ERROR) and closes session when callTool throws", async () => {
    const session = makeSession({
      callToolError: new Error("Socket closed unexpectedly"),
    });
    openMcpSessionSpy.mockResolvedValue(session);

    await expect(
      service.call("list_replies", {}, makeAuthContext()),
    ).rejects.toMatchObject({
      code: ErrorCode.MCP_ERROR,
      statusCode: 502,
    });

    expect(session.close).toHaveBeenCalledOnce();
  });

  it("throws McpError(MCP_ERROR) when openMcpSession rejects", async () => {
    openMcpSessionSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      service.call("list_replies", {}, makeAuthContext()),
    ).rejects.toMatchObject({
      code: ErrorCode.MCP_ERROR,
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });

  it("re-throws McpError instances without double-wrapping", async () => {
    const original = new McpError(ErrorCode.MCP_TOOL_ERROR, "Tool-level error");
    const session = makeSession({ callToolError: original });
    openMcpSessionSpy.mockResolvedValue(session);

    await expect(
      service.call("create_campaign", {}, makeAuthContext()),
    ).rejects.toBe(original);
  });

  it("throws McpError(MCP_TIMEOUT) when the call exceeds timeoutMs", async () => {
    const session = {
      callTool: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    openMcpSessionSpy.mockResolvedValue(session);

    await expect(
      service.call("list_replies", {}, makeAuthContext(), { timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: ErrorCode.MCP_TIMEOUT,
    });
  }, 2000);

  it("ignores non-text content blocks", async () => {
    openMcpSessionSpy.mockResolvedValue(
      makeSession({
        callToolResult: {
          content: [
            { type: "image", data: "base64...", mimeType: "image/png" },
            { type: "text", text: '{"status":"ok"}' },
          ],
          isError: false,
        },
      }),
    );

    const result = await service.call("get_campaign_stats", { campaignId: "c1" }, makeAuthContext());

    expect(result.rawContent).toEqual(['{"status":"ok"}']);
    expect(result.data).toEqual({ status: "ok" });
  });
});
