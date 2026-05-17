/**
 * src/services/__tests__/approvalPolicy.test.ts
 *
 * Unit tests for ApprovalPolicyService.
 *
 * The approval policy is the security boundary that determines which actions
 * require explicit user confirmation. These tests are the authoritative record
 * of which intents are considered "risky" and which are safe to execute directly.
 * Any change to APPROVAL_POLICY that removes an intent from the risky set must
 * be accompanied by a deliberate update to the assertions here.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ApprovalPolicyService } from "../approvalPolicy.service.js";
import type { Intent } from "../../config/intents.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** All 11 intents defined in the system. */
const ALL_INTENTS: Intent[] = [
  "create_campaign",
  "update_campaign",
  "start_campaign",
  "pause_campaign",
  "resume_campaign",
  "get_campaign_stats",
  "list_replies",
  "summarize_replies",
  "check_smtp",
  "update_smtp",
  "general_help",
];

/** The three intents that must always require approval. */
const RISKY_INTENTS: Intent[] = [
  "start_campaign",
  "resume_campaign",
  "update_smtp",
];

/** Every intent that must NEVER require approval. */
const SAFE_INTENTS = ALL_INTENTS.filter((i) => !RISKY_INTENTS.includes(i));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ApprovalPolicyService", () => {
  let svc: ApprovalPolicyService;

  beforeEach(() => {
    svc = new ApprovalPolicyService();
  });

  // ── requiresApproval — risky intents ───────────────────────────────────────

  it("requires approval for start_campaign", () => {
    expect(svc.requiresApproval("start_campaign")).toBe(true);
  });

  it("requires approval for resume_campaign", () => {
    expect(svc.requiresApproval("resume_campaign")).toBe(true);
  });

  it("requires approval for update_smtp", () => {
    expect(svc.requiresApproval("update_smtp")).toBe(true);
  });

  // ── requiresApproval — safe intents ───────────────────────────────────────

  it.each(SAFE_INTENTS)(
    "does NOT require approval for %s",
    (intent) => {
      expect(svc.requiresApproval(intent)).toBe(false);
    },
  );

  // ── Exhaustive coverage: every intent is classified ───────────────────────

  it("classifies every known intent as either risky or safe (no unclassified gaps)", () => {
    for (const intent of ALL_INTENTS) {
      // requiresApproval must return a boolean, not undefined / null
      expect(typeof svc.requiresApproval(intent)).toBe("boolean");
    }
  });

  it("risky intents count matches RISKY_INTENTS fixture (detects accidental additions)", () => {
    expect(svc.riskyIntents()).toHaveLength(RISKY_INTENTS.length);
  });

  // ── approvalReason ────────────────────────────────────────────────────────

  it("returns a non-empty reason string for each risky intent", () => {
    for (const intent of RISKY_INTENTS) {
      const reason = svc.approvalReason(intent);
      expect(typeof reason).toBe("string");
      expect((reason as string).length).toBeGreaterThan(0);
    }
  });

  it("returns undefined reason for safe intents", () => {
    for (const intent of SAFE_INTENTS) {
      expect(svc.approvalReason(intent)).toBeUndefined();
    }
  });

  it("reason for start_campaign mentions sending emails", () => {
    const reason = svc.approvalReason("start_campaign");
    expect(reason?.toLowerCase()).toMatch(/email|send|recipient/);
  });

  it("reason for update_smtp mentions delivery or SMTP impact", () => {
    const reason = svc.approvalReason("update_smtp");
    expect(reason?.toLowerCase()).toMatch(/smtp|deliver|settings/);
  });

  // ── riskyIntents ──────────────────────────────────────────────────────────

  it("riskyIntents() returns all three expected risky intents", () => {
    const risky = svc.riskyIntents();
    expect(risky).toContain("start_campaign");
    expect(risky).toContain("resume_campaign");
    expect(risky).toContain("update_smtp");
  });

  it("riskyIntents() contains no safe intents", () => {
    const risky = new Set(svc.riskyIntents());
    for (const intent of SAFE_INTENTS) {
      expect(risky.has(intent)).toBe(false);
    }
  });

  it("riskyIntents() returns a new array each call (no shared reference)", () => {
    const a = svc.riskyIntents();
    const b = svc.riskyIntents();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  // ── Consistency guarantee ─────────────────────────────────────────────────

  it("requiresApproval is consistent with riskyIntents() for every intent", () => {
    const riskySet = new Set(svc.riskyIntents());
    for (const intent of ALL_INTENTS) {
      expect(svc.requiresApproval(intent)).toBe(riskySet.has(intent));
    }
  });
});
