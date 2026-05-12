/**
 * src/services/__tests__/intentDetection.test.ts
 *
 * Deterministic tests for IntentDetectionService.
 * No mocks needed — the service is purely synchronous rule-based logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { IntentDetectionService } from "../intentDetection.service.js";
import { INTENT_CONFIDENCE_THRESHOLD, FALLBACK_CONFIDENCE } from "../../config/intents.js";

describe("IntentDetectionService", () => {
  let service: IntentDetectionService;

  beforeEach(() => {
    service = new IntentDetectionService();
  });

  // ── Campaign intents ────────────────────────────────────────────────────────

  it("detects create_campaign from phrase", () => {
    const result = service.detect("Create a new campaign called Summer Sale");
    expect(result.intent).toBe("create_campaign");
    expect(result.confidence).toBeGreaterThanOrEqual(INTENT_CONFIDENCE_THRESHOLD);
  });

  it("detects create_campaign from 'build campaign'", () => {
    const result = service.detect("I want to build a campaign for product launch");
    expect(result.intent).toBe("create_campaign");
  });

  it("detects update_campaign", () => {
    const result = service.detect("Update the subject line of my campaign");
    expect(result.intent).toBe("update_campaign");
  });

  it("detects start_campaign from 'launch'", () => {
    const result = service.detect("Launch the Summer Sale campaign now");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects start_campaign from 'send campaign'", () => {
    const result = service.detect("Send campaign to all subscribers");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects start_campaign from 'send campaign to all recipients'", () => {
    const result = service.detect("Please send campaign to all recipients");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects start_campaign from 'deliver campaign'", () => {
    const result = service.detect("Deliver campaign now");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects start_campaign from 'dispatch campaign'", () => {
    const result = service.detect("Dispatch campaign to subscribers");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects start_campaign from 'start sending'", () => {
    const result = service.detect("Start sending the campaign emails");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects start_campaign from 'send email campaign'", () => {
    const result = service.detect("Send email campaign now");
    expect(result.intent).toBe("start_campaign");
  });

  it("detects pause_campaign", () => {
    const result = service.detect("Pause the campaign immediately");
    expect(result.intent).toBe("pause_campaign");
  });

  it("detects pause_campaign from 'stop campaign'", () => {
    const result = service.detect("Stop the Black Friday campaign");
    expect(result.intent).toBe("pause_campaign");
  });

  it("detects autonomous recommendation intent", () => {
    const result = service.detect("show autonomous recommendations for campaign 12");
    expect(result.intent).toBe("show_autonomous_recommendations");
  });

  it("detects lead priority explanation intent", () => {
    const result = service.detect("why is this lead high priority?");
    expect(result.intent).toBe("explain_lead_priority");
  });

  it("detects sequence adaptation preview intent", () => {
    const result = service.detect("preview adaptation for pricing objection");
    expect(result.intent).toBe("preview_sequence_adaptation");
  });

  it("detects resume_campaign", () => {
    const result = service.detect("Resume the paused campaign");
    expect(result.intent).toBe("resume_campaign");
  });

  it("detects resume_campaign from 'unpause'", () => {
    const result = service.detect("Unpause my campaign");
    expect(result.intent).toBe("resume_campaign");
  });

  it("distinguishes resume from pause", () => {
    const pause = service.detect("Pause the campaign");
    const resume = service.detect("Resume the campaign");
    expect(pause.intent).toBe("pause_campaign");
    expect(resume.intent).toBe("resume_campaign");
  });

  // ── Analytics ───────────────────────────────────────────────────────────────

  it("detects get_campaign_stats from 'campaign stats'", () => {
    const result = service.detect("Show me the campaign stats");
    expect(result.intent).toBe("get_campaign_stats");
  });

  it("detects get_campaign_stats from 'open rate'", () => {
    const result = service.detect("What is the open rate for my last campaign?");
    expect(result.intent).toBe("get_campaign_stats");
  });

  it("detects get_campaign_stats from 'campaign performance'", () => {
    const result = service.detect("How is my campaign performing?");
    expect(result.intent).toBe("get_campaign_stats");
  });

  // ── Inbox ────────────────────────────────────────────────────────────────────

  it("detects list_replies", () => {
    const result = service.detect("Show me all the replies");
    expect(result.intent).toBe("list_replies");
  });

  it("detects list_replies from 'view responses'", () => {
    const result = service.detect("View responses to my last campaign");
    expect(result.intent).toBe("list_replies");
  });

  it("detects summarize_replies", () => {
    const result = service.detect("Summarize the replies from customers");
    expect(result.intent).toBe("summarize_replies");
  });

  it("detects summarize_replies from 'reply summary'", () => {
    const result = service.detect("Give me a reply summary");
    expect(result.intent).toBe("summarize_replies");
  });

  it("detects summarize_replies from British English 'summarise'", () => {
    const result = service.detect("Please summarise the replies");
    expect(result.intent).toBe("summarize_replies");
  });

  it("distinguishes list_replies from summarize_replies", () => {
    const list = service.detect("List all replies");
    const summarize = service.detect("Summarize the replies");
    expect(list.intent).toBe("list_replies");
    expect(summarize.intent).toBe("summarize_replies");
  });

  // ── Settings ─────────────────────────────────────────────────────────────────

  it("detects check_smtp from 'smtp settings'", () => {
    const result = service.detect("Show me the smtp settings");
    expect(result.intent).toBe("check_smtp");
  });

  it("detects check_smtp from 'view smtp'", () => {
    const result = service.detect("View smtp configuration");
    expect(result.intent).toBe("check_smtp");
  });

  it("detects update_smtp", () => {
    const result = service.detect("Update the smtp server to mail.example.com");
    expect(result.intent).toBe("update_smtp");
  });

  it("detects update_smtp from 'configure smtp'", () => {
    const result = service.detect("Configure smtp for the new mail provider");
    expect(result.intent).toBe("update_smtp");
  });

  it("distinguishes check_smtp from update_smtp", () => {
    const check = service.detect("Check smtp settings");
    const update = service.detect("Update smtp settings");
    expect(check.intent).toBe("check_smtp");
    expect(update.intent).toBe("update_smtp");
  });

  // ── List campaigns ────────────────────────────────────────────────────────────

  it("detects list_campaigns from 'list campaigns'", () => {
    const result = service.detect("list campaigns");
    expect(result.intent).toBe("list_campaigns");
  });

  it("detects list_campaigns from 'show campaigns'", () => {
    const result = service.detect("Show all my campaigns");
    expect(result.intent).toBe("list_campaigns");
  });

  it("detects list_campaigns from 'my campaigns'", () => {
    const result = service.detect("Show me my campaigns");
    expect(result.intent).toBe("list_campaigns");
  });

  // ── General help ─────────────────────────────────────────────────────────────

  it("detects general_help from 'help'", () => {
    const result = service.detect("Help");
    expect(result.intent).toBe("general_help");
  });

  it("detects general_help from 'what can you do'", () => {
    const result = service.detect("What can you do?");
    expect(result.intent).toBe("general_help");
  });

  // ── Fallback ─────────────────────────────────────────────────────────────────

  it("falls back to general_help for empty input", () => {
    const result = service.detect("");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
    expect(result.matchedPatterns).toHaveLength(0);
  });

  it("falls back to general_help for whitespace-only input", () => {
    const result = service.detect("   ");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  it("falls back to general_help for unrecognised input", () => {
    const result = service.detect("xyzzy frobnicator quux");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  // ── Out-of-domain queries ─────────────────────────────────────────────────────
  // out_of_domain has no keyword patterns (patterns: []) so it is NEVER selected
  // by deterministic detection.  Unrelated questions fall back to general_help
  // here; the LLM (OpenAI classifyIntent) reclassifies them as out_of_domain
  // when available, and finalResponse.node.ts then returns the polite refusal.

  it("deterministic fallback for geography question is general_help (LLM reclassifies to out_of_domain)", () => {
    const result = service.detect("What is the capital city of Pakistan?");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  it("deterministic fallback for joke request is general_help", () => {
    const result = service.detect("Tell me a joke");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  it("deterministic fallback for weather question is general_help", () => {
    const result = service.detect("What is the weather today?");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  it("deterministic fallback for math question is general_help", () => {
    const result = service.detect("Solve 42 times 17");
    expect(result.intent).toBe("general_help");
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  // ── Result shape ─────────────────────────────────────────────────────────────

  it("returns confidence in [0, 1]", () => {
    const messages = [
      "Create a new campaign",
      "Show stats",
      "help",
      "unknown input abc",
    ];
    for (const msg of messages) {
      const result = service.detect(msg);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("returns matched patterns as non-empty array for a confident detection", () => {
    const result = service.detect("Launch the campaign now");
    expect(result.intent).toBe("start_campaign");
    expect(result.matchedPatterns.length).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    const lower = service.detect("create campaign");
    const upper = service.detect("CREATE CAMPAIGN");
    const mixed = service.detect("Create Campaign");
    expect(lower.intent).toBe("create_campaign");
    expect(upper.intent).toBe("create_campaign");
    expect(mixed.intent).toBe("create_campaign");
  });

  it("handles extra whitespace in input", () => {
    const result = service.detect("  create   campaign   ");
    expect(result.intent).toBe("create_campaign");
  });
});
