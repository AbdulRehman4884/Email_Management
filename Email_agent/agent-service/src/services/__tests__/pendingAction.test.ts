/**
 * src/services/__tests__/pendingAction.test.ts
 *
 * Unit tests for PendingActionService.
 * Uses a fresh service instance per test — no shared state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PendingActionService } from "../pendingAction.service.js";
import { AppError, ConflictError, ForbiddenError, ErrorCode } from "../../lib/errors.js";
import type { UserId, SessionId } from "../../types/common.js";

const USER_A = "user-a" as UserId;
const USER_B = "user-b" as UserId;
const SESSION = "sess-1" as SessionId;

function makeService() {
  return new PendingActionService();
}

async function createAction(
  service: PendingActionService,
  overrides?: Partial<{ userId: UserId; ttlMs: number }>,
) {
  return service.create({
    userId:    overrides?.userId ?? USER_A,
    sessionId: SESSION,
    intent:    "start_campaign",
    toolName:  "start_campaign",
    toolArgs:  { campaignId: "c1" },
    ttlMs:     overrides?.ttlMs,
  });
}

describe("PendingActionService", () => {
  let svc: PendingActionService;

  beforeEach(() => {
    svc = makeService();
  });

  // ── create ──────────────────────────────────────────────────────────────────

  it("creates an action with status=pending", async () => {
    const action = await createAction(svc);
    expect(action.status).toBe("pending");
    expect(action.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("sets expiresAt in the future", async () => {
    const action = await createAction(svc);
    expect(new Date(action.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns the action via findById", async () => {
    const action = await createAction(svc);
    const found = await svc.findById(action.id);
    expect(found?.id).toBe(action.id);
  });

  it("returns undefined for unknown id", async () => {
    const found = await svc.findById("00000000-0000-0000-0000-000000000000");
    expect(found).toBeUndefined();
  });

  // ── validate ────────────────────────────────────────────────────────────────

  it("validate returns the action when valid", async () => {
    const action = await createAction(svc);
    const validated = await svc.validate(action.id, USER_A);
    expect(validated.id).toBe(action.id);
  });

  it("validate throws APPROVAL_NOT_FOUND for unknown id", async () => {
    await expect(
      svc.validate("00000000-0000-0000-0000-000000000000", USER_A),
    ).rejects.toMatchObject({ code: ErrorCode.APPROVAL_NOT_FOUND, statusCode: 404 });
  });

  it("validate throws ForbiddenError when userId does not match", async () => {
    const action = await createAction(svc);
    await expect(svc.validate(action.id, USER_B)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("validate throws APPROVAL_EXPIRED when TTL has elapsed", async () => {
    const action = await createAction(svc, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5)); // let TTL elapse
    await expect(svc.validate(action.id, USER_A)).rejects.toMatchObject({
      code: ErrorCode.APPROVAL_EXPIRED,
      statusCode: 410,
    });
  });

  // ── confirm ─────────────────────────────────────────────────────────────────

  it("confirm transitions status to confirmed", async () => {
    const action = await createAction(svc);
    const confirmed = await svc.confirm(action.id, USER_A);
    expect(confirmed.status).toBe("confirmed");
  });

  it("confirm throws ConflictError on second call (duplicate prevention)", async () => {
    const action = await createAction(svc);
    await svc.confirm(action.id, USER_A);
    await expect(svc.confirm(action.id, USER_A)).rejects.toBeInstanceOf(ConflictError);
  });

  // ── markExecuted ─────────────────────────────────────────────────────────────

  it("markExecuted sets status=executed and executedAt", async () => {
    const action = await createAction(svc);
    await svc.confirm(action.id, USER_A);
    await svc.markExecuted(action.id);
    const found = await svc.findById(action.id);
    expect(found?.status).toBe("executed");
    expect(found?.executedAt).toBeDefined();
  });

  it("markExecuted on unknown id is a no-op", async () => {
    await expect(
      svc.markExecuted("00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
  });

  // ── cancel ──────────────────────────────────────────────────────────────────

  it("cancel transitions status to cancelled", async () => {
    const action = await createAction(svc);
    const cancelled = await svc.cancel(action.id, USER_A);
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancel throws ConflictError after confirm", async () => {
    const action = await createAction(svc);
    await svc.confirm(action.id, USER_A);
    await expect(svc.cancel(action.id, USER_A)).rejects.toBeInstanceOf(ConflictError);
  });

  it("cancel throws ForbiddenError for wrong user", async () => {
    const action = await createAction(svc);
    await expect(svc.cancel(action.id, USER_B)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
