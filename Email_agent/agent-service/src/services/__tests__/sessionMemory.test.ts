/**
 * src/services/__tests__/sessionMemory.test.ts
 *
 * Unit tests for SessionMemoryService backed by InMemorySessionStore.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionMemoryService } from "../sessionMemory.service.js";
import { InMemorySessionStore } from "../../memory/sessionMemory.store.js";

const UID = "user-1";
const SID = "sess-1";

function makeService() {
  return new SessionMemoryService(new InMemorySessionStore());
}

describe("SessionMemoryService", () => {
  let svc: SessionMemoryService;

  beforeEach(() => {
    svc = makeService();
  });

  // ── get ──────────────────────────────────────────────────────────────────────

  it("returns undefined for unknown session", async () => {
    expect(await svc.get(UID, SID)).toBeUndefined();
  });

  // ── update ───────────────────────────────────────────────────────────────────

  it("creates a session on first update", async () => {
    await svc.update(UID, SID, { lastIntent: "create_campaign" });
    const snap = await svc.get(UID, SID);
    expect(snap?.lastIntent).toBe("create_campaign");
    expect(snap?.messages).toHaveLength(0);
  });

  it("merges updates without erasing other fields", async () => {
    await svc.update(UID, SID, { lastIntent: "pause_campaign", activeCampaignId: "c-99" });
    await svc.update(UID, SID, { lastAgentDomain: "campaign" });
    const snap = await svc.get(UID, SID);
    expect(snap?.lastIntent).toBe("pause_campaign");
    expect(snap?.activeCampaignId).toBe("c-99");
    expect(snap?.lastAgentDomain).toBe("campaign");
  });

  // ── appendMessage ─────────────────────────────────────────────────────────────

  it("appends messages with correct role", async () => {
    await svc.appendMessage(UID, SID, "human", "Hello");
    await svc.appendMessage(UID, SID, "ai", "Hi there");
    const snap = await svc.get(UID, SID);
    expect(snap?.messages).toHaveLength(2);
    expect(snap?.messages[0]?.role).toBe("human");
    expect(snap?.messages[1]?.role).toBe("ai");
  });

  it("trims messages at MEMORY_MAX_MESSAGES (20)", async () => {
    for (let i = 0; i < 25; i++) {
      await svc.appendMessage(UID, SID, "human", `msg ${i}`);
    }
    const snap = await svc.get(UID, SID);
    expect(snap?.messages.length).toBeLessThanOrEqual(20);
    // Most recent message should be preserved
    expect(snap?.messages.at(-1)?.content).toBe("msg 24");
  });

  // ── appendToolCall ────────────────────────────────────────────────────────────

  it("appends tool call records", async () => {
    await svc.appendToolCall(UID, SID, { toolName: "get_campaign_stats", success: true });
    const snap = await svc.get(UID, SID);
    expect(snap?.recentToolCalls).toHaveLength(1);
    expect(snap?.recentToolCalls[0]?.toolName).toBe("get_campaign_stats");
    expect(snap?.recentToolCalls[0]?.success).toBe(true);
  });

  it("trims tool calls at MEMORY_MAX_TOOL_CALLS (10)", async () => {
    for (let i = 0; i < 15; i++) {
      await svc.appendToolCall(UID, SID, { toolName: "list_replies", success: true });
    }
    const snap = await svc.get(UID, SID);
    expect(snap?.recentToolCalls.length).toBeLessThanOrEqual(10);
  });

  // ── saveTurn ──────────────────────────────────────────────────────────────────

  it("saveTurn writes both messages and metadata in one call", async () => {
    await svc.saveTurn(UID, SID, {
      userMessage: "Launch the campaign",
      aiResponse:  "Confirmation required.",
      metadata: { lastIntent: "start_campaign", activeCampaignId: "c-42" },
      toolCall:  { toolName: "start_campaign", success: false },
    });

    const snap = await svc.get(UID, SID);
    expect(snap?.messages).toHaveLength(2);
    expect(snap?.lastIntent).toBe("start_campaign");
    expect(snap?.activeCampaignId).toBe("c-42");
    expect(snap?.recentToolCalls).toHaveLength(1);
  });

  it("saveTurn without toolCall does not add a tool call record", async () => {
    await svc.saveTurn(UID, SID, {
      userMessage: "Help",
      aiResponse:  "Here is what I can do...",
      metadata:    { lastIntent: "general_help" },
    });
    const snap = await svc.get(UID, SID);
    expect(snap?.recentToolCalls).toHaveLength(0);
  });

  // ── session isolation ─────────────────────────────────────────────────────────

  it("sessions with different sessionIds are isolated", async () => {
    await svc.update(UID, "sess-a", { lastIntent: "list_replies" });
    await svc.update(UID, "sess-b", { lastIntent: "summarize_replies" });
    const a = await svc.get(UID, "sess-a");
    const b = await svc.get(UID, "sess-b");
    expect(a?.lastIntent).toBe("list_replies");
    expect(b?.lastIntent).toBe("summarize_replies");
  });

  it("sessions with different userIds are isolated", async () => {
    await svc.update("user-x", SID, { activeCampaignId: "cx" });
    await svc.update("user-y", SID, { activeCampaignId: "cy" });
    expect((await svc.get("user-x", SID))?.activeCampaignId).toBe("cx");
    expect((await svc.get("user-y", SID))?.activeCampaignId).toBe("cy");
  });
});
