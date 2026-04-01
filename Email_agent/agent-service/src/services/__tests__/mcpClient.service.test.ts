/**
 * src/services/__tests__/mcpClient.service.test.ts
 *
 * Unit tests for McpClientService.
 *
 * McpClientService is a typed dispatch layer over McpToolCallerService.
 * Its contracts are:
 *   1. Each named method calls mcpToolCaller.call() with the exact tool name
 *      that matches the method (no typos, no swapped names).
 *   2. dispatch() routes to mcpToolCaller.call() with the provided tool name.
 *   3. All call paths forward the auth context unchanged.
 *   4. dispatch() with a known tool name does NOT throw.
 *
 * We do NOT test network behaviour here — that is covered by mcpToolCaller.test.ts.
 * The mcpToolCaller singleton is spied on so no real connections are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { McpClientService } from "../mcpClient.service.js";
import { mcpToolCaller } from "../mcpToolCaller.js";
import type { AuthContext } from "../../types/common.js";
import type { McpToolResult } from "../../types/mcp.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAuth(overrides?: Partial<AuthContext>): AuthContext {
  return {
    userId:   "user-1" as AuthContext["userId"],
    rawToken: "tok-xyz",
    ...overrides,
  };
}

const MOCK_RESULT: McpToolResult = {
  data:       { ok: true },
  isToolError: false,
  rawContent: ['{"ok":true}'],
};

// ── Setup ─────────────────────────────────────────────────────────────────────

describe("McpClientService", () => {
  let svc: McpClientService;
  let callSpy: Mock;

  beforeEach(() => {
    svc = new McpClientService();
    callSpy = vi
      .spyOn(mcpToolCaller, "call")
      .mockResolvedValue(MOCK_RESULT) as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Named methods — tool name wiring ──────────────────────────────────────
  // Each method must pass exactly the correct tool name to mcpToolCaller.call.

  it("createCampaign calls mcpToolCaller with 'create_campaign'", async () => {
    await svc.createCampaign({ name: "n", subject: "s" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith(
      "create_campaign",
      expect.any(Object),
      expect.any(Object),
      undefined,
    );
  });

  it("updateCampaign calls mcpToolCaller with 'update_campaign'", async () => {
    await svc.updateCampaign({ campaignId: "c1" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("update_campaign", expect.any(Object), expect.any(Object), undefined);
  });

  it("startCampaign calls mcpToolCaller with 'start_campaign'", async () => {
    await svc.startCampaign({ campaignId: "c1" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("start_campaign", expect.any(Object), expect.any(Object), undefined);
  });

  it("pauseCampaign calls mcpToolCaller with 'pause_campaign'", async () => {
    await svc.pauseCampaign({ campaignId: "c1" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("pause_campaign", expect.any(Object), expect.any(Object), undefined);
  });

  it("resumeCampaign calls mcpToolCaller with 'resume_campaign'", async () => {
    await svc.resumeCampaign({ campaignId: "c1" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("resume_campaign", expect.any(Object), expect.any(Object), undefined);
  });

  it("getCampaignStats calls mcpToolCaller with 'get_campaign_stats'", async () => {
    await svc.getCampaignStats({ campaignId: "c1" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("get_campaign_stats", expect.any(Object), expect.any(Object), undefined);
  });

  it("listReplies calls mcpToolCaller with 'list_replies'", async () => {
    await svc.listReplies({}, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("list_replies", expect.any(Object), expect.any(Object), undefined);
  });

  it("summarizeReplies calls mcpToolCaller with 'summarize_replies'", async () => {
    await svc.summarizeReplies({}, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("summarize_replies", expect.any(Object), expect.any(Object), undefined);
  });

  it("getSmtpSettings calls mcpToolCaller with 'get_smtp_settings'", async () => {
    await svc.getSmtpSettings({}, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("get_smtp_settings", expect.any(Object), expect.any(Object), undefined);
  });

  it("updateSmtpSettings calls mcpToolCaller with 'update_smtp_settings'", async () => {
    await svc.updateSmtpSettings({ host: "mail.example.com" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith("update_smtp_settings", expect.any(Object), expect.any(Object), undefined);
  });

  // ── Auth passthrough ──────────────────────────────────────────────────────

  it("forwards authContext unchanged to mcpToolCaller", async () => {
    const auth = makeAuth({ userId: "user-special" as AuthContext["userId"] });
    await svc.getCampaignStats({ campaignId: "c1" }, auth);
    expect(callSpy).toHaveBeenCalledWith(
      "get_campaign_stats",
      expect.any(Object),
      expect.objectContaining({ userId: "user-special", rawToken: "tok-xyz" }),
      undefined,
    );
  });

  // ── Args passthrough ──────────────────────────────────────────────────────

  it("forwards tool args unchanged to mcpToolCaller", async () => {
    await svc.pauseCampaign({ campaignId: "camp-99" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith(
      "pause_campaign",
      { campaignId: "camp-99" },
      expect.any(Object),
      undefined,
    );
  });

  it("forwards options to mcpToolCaller when provided", async () => {
    await svc.startCampaign({ campaignId: "c1" }, makeAuth(), { timeoutMs: 5000 });
    expect(callSpy).toHaveBeenCalledWith(
      "start_campaign",
      expect.any(Object),
      expect.any(Object),
      { timeoutMs: 5000 },
    );
  });

  // ── Return value ──────────────────────────────────────────────────────────

  it("returns the McpToolResult from mcpToolCaller", async () => {
    const result = await svc.getCampaignStats({ campaignId: "c1" }, makeAuth());
    expect(result).toBe(MOCK_RESULT);
  });

  // ── dispatch() ───────────────────────────────────────────────────────────

  it("dispatch() routes to mcpToolCaller with the given tool name", async () => {
    await svc.dispatch("pause_campaign", { campaignId: "c1" }, makeAuth());
    expect(callSpy).toHaveBeenCalledWith(
      "pause_campaign",
      { campaignId: "c1" },
      expect.any(Object),
      undefined,
    );
  });

  it("dispatch() forwards auth context", async () => {
    const auth = makeAuth({ rawToken: "dispatch-tok" });
    await svc.dispatch("list_replies", {}, auth);
    expect(callSpy).toHaveBeenCalledWith(
      "list_replies",
      {},
      expect.objectContaining({ rawToken: "dispatch-tok" }),
      undefined,
    );
  });

  it("dispatch() returns the McpToolResult from mcpToolCaller", async () => {
    const result = await svc.dispatch("get_campaign_stats", { campaignId: "c1" }, makeAuth());
    expect(result).toBe(MOCK_RESULT);
  });

  it("dispatch() calls mcpToolCaller exactly once per invocation", async () => {
    await svc.dispatch("create_campaign", { name: "n", subject: "s" }, makeAuth());
    expect(callSpy).toHaveBeenCalledOnce();
  });

  // ── All named methods call mcpToolCaller exactly once ─────────────────────

  it.each([
    ["createCampaign",    () => svc.createCampaign({ name: "n", subject: "s" }, makeAuth())] as const,
    ["updateCampaign",    () => svc.updateCampaign({ campaignId: "c1" }, makeAuth())] as const,
    ["startCampaign",     () => svc.startCampaign({ campaignId: "c1" }, makeAuth())] as const,
    ["pauseCampaign",     () => svc.pauseCampaign({ campaignId: "c1" }, makeAuth())] as const,
    ["resumeCampaign",    () => svc.resumeCampaign({ campaignId: "c1" }, makeAuth())] as const,
    ["getCampaignStats",  () => svc.getCampaignStats({ campaignId: "c1" }, makeAuth())] as const,
    ["listReplies",       () => svc.listReplies({}, makeAuth())] as const,
    ["summarizeReplies",  () => svc.summarizeReplies({}, makeAuth())] as const,
    ["getSmtpSettings",   () => svc.getSmtpSettings({}, makeAuth())] as const,
    ["updateSmtpSettings",() => svc.updateSmtpSettings({ host: "h" }, makeAuth())] as const,
  ])(
    "%s calls mcpToolCaller.call exactly once",
    async (_name, invoke) => {
      callSpy.mockClear();
      await invoke();
      expect(callSpy).toHaveBeenCalledOnce();
    },
  );
});
