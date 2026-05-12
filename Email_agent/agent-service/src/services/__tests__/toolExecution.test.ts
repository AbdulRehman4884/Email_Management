/**
 * src/services/__tests__/toolExecution.test.ts
 *
 * Unit tests for ToolExecutionService.
 * McpClientService is mocked — no real MCP connections.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ToolExecutionService } from "../toolExecution.service.js";
import * as mcpClientModule from "../mcpClient.service.js";
import { McpError, ErrorCode } from "../../lib/errors.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentGraphStateType> = {}): AgentGraphStateType {
  return {
    messages: [],
    userMessage: "test",
    sessionId: "sess-1" as AgentGraphStateType["sessionId"],
    userId: "user-1" as AgentGraphStateType["userId"],
    rawToken: "valid-token",
    intent: "get_campaign_stats",
    confidence: 0.9,
    agentDomain: "analytics",
    toolName: "get_campaign_stats",
    toolArgs: { campaignId: "camp-1" },
    toolResult: undefined,
    requiresApproval: false,
    pendingActionId: undefined,
    finalResponse: undefined,
    error: undefined,
    activeCampaignId: undefined,
    llmExtractedArgs: undefined,
    plan: undefined,
    planIndex: 0,
    planResults: [],
    ...overrides,
  };
}

const MOCK_RESULT = {
  data: { opens: 120, clicks: 45 },
  isToolError: false,
  rawContent: ['{"opens":120,"clicks":45}'],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ToolExecutionService", () => {
  let service: ToolExecutionService;
  let dispatchSpy: Mock;

  beforeEach(() => {
    service = new ToolExecutionService();
    dispatchSpy = vi
      .spyOn(mcpClientModule.mcpClientService, "dispatch")
      .mockResolvedValue(MOCK_RESULT) as Mock;
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("returns { toolResult } on successful tool execution", async () => {
    const patch = await service.executeFromState(makeState());
    expect(patch.toolResult).toEqual(MOCK_RESULT);
    expect(patch.error).toBeUndefined();
  });

  it("passes toolName and toolArgs to the dispatcher", async () => {
    await service.executeFromState(
      makeState({ toolName: "pause_campaign", toolArgs: { campaignId: "c99" } }),
    );
    expect(dispatchSpy).toHaveBeenCalledWith(
      "pause_campaign",
      { campaignId: "c99" },
      expect.objectContaining({ rawToken: "valid-token" }),
    );
  });

  it("constructs AuthContext with userId from state", async () => {
    await service.executeFromState(makeState({ userId: "user-abc" as AgentGraphStateType["userId"] }));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ userId: "user-abc" }),
    );
  });

  it("falls back to 'unknown' userId when state.userId is undefined", async () => {
    await service.executeFromState(makeState({ userId: undefined }));
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ userId: "unknown" }),
    );
  });

  // ── Guard conditions ────────────────────────────────────────────────────────

  it("returns { error } when toolName is undefined", async () => {
    const patch = await service.executeFromState(makeState({ toolName: undefined }));
    expect(patch.error).toBeDefined();
    expect(patch.toolResult).toBeUndefined();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("returns { error } when rawToken is undefined", async () => {
    const patch = await service.executeFromState(makeState({ rawToken: undefined }));
    expect(patch.error).toBeDefined();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("returns { error } when toolName is not in KNOWN_TOOL_NAMES", async () => {
    const patch = await service.executeFromState(makeState({ toolName: "fly_to_moon" }));
    expect(patch.error).toBeDefined();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it("returns { error } with timeout message on MCP_TIMEOUT", async () => {
    dispatchSpy.mockRejectedValue(
      new McpError(ErrorCode.MCP_TIMEOUT, "Timed out"),
    );
    const patch = await service.executeFromState(makeState());
    expect(patch.error).toMatch(/too long|timed/i);
    expect(patch.toolResult).toBeUndefined();
  });

  it("returns { error } on MCP_ERROR", async () => {
    dispatchSpy.mockRejectedValue(
      new McpError(ErrorCode.MCP_ERROR, "Connection refused"),
    );
    const patch = await service.executeFromState(makeState());
    expect(patch.error).toBeDefined();
    expect(patch.toolResult).toBeUndefined();
  });

  it("re-throws AUTH_INVALID_TOKEN without capturing into state", async () => {
    dispatchSpy.mockRejectedValue(
      new McpError(ErrorCode.AUTH_INVALID_TOKEN, "Bad token"),
    );
    await expect(service.executeFromState(makeState())).rejects.toBeInstanceOf(McpError);
  });

  it("re-throws AUTH_EXPIRED_TOKEN without capturing into state", async () => {
    dispatchSpy.mockRejectedValue(
      new McpError(ErrorCode.AUTH_EXPIRED_TOKEN, "Token expired"),
    );
    await expect(service.executeFromState(makeState())).rejects.toBeInstanceOf(McpError);
  });

  it("returns generic { error } on unexpected non-McpError", async () => {
    dispatchSpy.mockRejectedValue(new TypeError("Cannot read property of undefined"));
    const patch = await service.executeFromState(makeState());
    expect(patch.error).toContain("unexpected error");
    expect(patch.toolResult).toBeUndefined();
  });

  // ── isToolError passthrough ─────────────────────────────────────────────────

  it("passes through isToolError=true from MCP — does not remap to state.error", async () => {
    dispatchSpy.mockResolvedValue({
      data: { error: "Campaign not found" },
      isToolError: true,
      rawContent: ['{"error":"Campaign not found"}'],
    });
    const patch = await service.executeFromState(makeState());
    expect(patch.toolResult?.isToolError).toBe(true);
    expect(patch.error).toBeUndefined();
  });
});
