/**
 * src/tests/services/toolExecution.service.test.ts
 *
 * Tests ToolExecutionService: timing, serialization, error boundary.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mock logger to avoid env.ts dependency ────────────────────────────────────

vi.mock("../../lib/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
    })),
  })),
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { ToolExecutionService } from "../../services/toolExecution.service.js";
import { toolSuccess, toolFailure } from "../../types/common.js";
import { createMockToolContext } from "../helpers.js";
import type { AnyMcpToolDefinition } from "../../types/tool.js";
import { TOOL_NAMES } from "../../config/constants.js";
import { GetCampaignStatsSchema } from "../../schemas/campaign.schemas.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTool(
  handler: AnyMcpToolDefinition["handler"],
): AnyMcpToolDefinition {
  return {
    name: TOOL_NAMES.GET_CAMPAIGN_STATS,
    description: "Test tool",
    inputSchema: GetCampaignStatsSchema,
    handler,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ToolExecutionService", () => {
  let service: ToolExecutionService;
  const mockContext = createMockToolContext();

  beforeEach(() => {
    service = new ToolExecutionService();
    vi.clearAllMocks();
  });

  it("serializes a successful ToolResult to a JSON string", async () => {
    const tool = makeTool(async () => toolSuccess({ value: 42 }));

    const result = await service.execute(tool, { campaignId: "abc" }, mockContext);
    const parsed = JSON.parse(result) as unknown;

    expect(parsed).toMatchObject({ success: true, data: { value: 42 } });
  });

  it("serializes a failure ToolResult to a JSON string", async () => {
    const tool = makeTool(async () =>
      toolFailure("MAILFLOW_NOT_FOUND", "Campaign not found"),
    );

    const result = await service.execute(tool, { campaignId: "abc" }, mockContext);
    const parsed = JSON.parse(result) as unknown;

    expect(parsed).toMatchObject({
      success: false,
      error: { code: "MAILFLOW_NOT_FOUND", message: "Campaign not found" },
    });
  });

  it("catches unexpected handler throws and returns TOOL_EXECUTION_ERROR", async () => {
    const tool = makeTool(async () => {
      throw new Error("Unexpected boom");
    });

    const result = await service.execute(tool, { campaignId: "abc" }, mockContext);
    const parsed = JSON.parse(result) as { success: boolean; error: { code: string } };

    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe("TOOL_EXECUTION_ERROR");
  });

  it("returns valid JSON even when handler throws a non-Error value", async () => {
    const tool = makeTool(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string error";
    });

    const result = await service.execute(tool, { campaignId: "abc" }, mockContext);
    expect(() => JSON.parse(result)).not.toThrow();

    const parsed = JSON.parse(result) as { success: boolean };
    expect(parsed.success).toBe(false);
  });

  it("always returns a string (FastMcpToolReturn)", async () => {
    const tool = makeTool(async () => toolSuccess({ ok: true }));
    const result = await service.execute(tool, {}, mockContext);
    expect(typeof result).toBe("string");
  });
});
