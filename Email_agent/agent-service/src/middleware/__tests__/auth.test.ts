/**
 * src/middleware/__tests__/auth.test.ts
 *
 * Unit tests for the requireAuth JWT middleware.
 *
 * Strategy
 * ─────────
 * jwt.verify is mocked entirely — tests are deterministic regardless of the
 * real JWT_SECRET value.  The error classes (TokenExpiredError / JsonWebTokenError)
 * are created inside vi.hoisted() so they are available when vi.mock() factories
 * run during the import phase.
 *
 * Regression coverage
 * ───────────────────
 * This suite is the canonical regression test for:
 *
 *   AUTH_INVALID_TOKEN: JWT missing sub claim
 *
 * Before the fix the backend issued tokens containing { userId, email, role }
 * with NO `sub` claim.  The tests in section F verify that:
 *   1. The middleware's fallback chain (sub → userId → id) works correctly.
 *   2. `sub` wins when both `sub` and `userId` are present (post-fix tokens).
 *   3. A completely identity-less token is still rejected.
 *
 * Section map
 * ───────────
 *   A. Header format validation
 *   B. JWT verification errors (expired, invalid signature, unexpected)
 *   C. Identity claim resolution (sub / userId / id chain + precedence)
 *   D. Missing identity claims (all three absent)
 *   E. AuthContext attachment (userId, email, rawToken)
 *   F. Regression: sub claim bug
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { RequestId } from "../../types/common.js";

// ── Hoisted ───────────────────────────────────────────────────────────────────
// Classes and spy must be created with vi.hoisted() so they exist when the
// vi.mock() factories execute (which happens before module-level declarations).

const { mockVerify, MockTokenExpiredError, MockJsonWebTokenError } = vi.hoisted(() => {
  class MockTokenExpiredError extends Error {
    readonly expiredAt = new Date(0);
    constructor() {
      super("jwt expired");
      this.name = "TokenExpiredError";
      Object.setPrototypeOf(this, MockTokenExpiredError.prototype);
    }
  }

  class MockJsonWebTokenError extends Error {
    constructor(message = "invalid signature") {
      super(message);
      this.name = "JsonWebTokenError";
      Object.setPrototypeOf(this, MockJsonWebTokenError.prototype);
    }
  }

  return {
    mockVerify: vi.fn(),
    MockTokenExpiredError,
    MockJsonWebTokenError,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("jsonwebtoken", () => ({
  default: {
    verify: mockVerify,
    TokenExpiredError: MockTokenExpiredError,
    JsonWebTokenError: MockJsonWebTokenError,
  },
}));

vi.mock("../../config/env.js", () => ({
  env: { JWT_SECRET: "test-secret-minimum-32-characters-longXX" },
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Subject under test ────────────────────────────────────────────────────────
// Imported after mocks — Vitest resolves mocks before running the import.

import { requireAuth } from "../auth.js";
import { ErrorCode } from "../../lib/errors.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_TOKEN = "valid.jwt.token";

function makeReq(authHeader?: string): Request {
  return {
    headers:   authHeader ? { authorization: authHeader } : {},
    requestId: "req-test-id" as RequestId,
  } as unknown as Request;
}

/** Returns a chainable mock Response and a captured object for assertions. */
function makeRes() {
  const captured: { statusCode: number; body: unknown } = { statusCode: 0, body: undefined };

  const chainable = {
    json: vi.fn((body: unknown) => { captured.body = body; }),
  };

  const res = {
    req:    { requestId: "req-test-id" },
    status: vi.fn((code: number) => { captured.statusCode = code; return chainable; }),
  } as unknown as Response;

  return { res, captured };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  // Default happy-path payload: sub claim present
  mockVerify.mockReturnValue({ sub: "user-1", email: "user@example.com" });
});

// ═════════════════════════════════════════════════════════════════════════════
// A. Header format validation
// ═════════════════════════════════════════════════════════════════════════════

describe("A. Authorization header validation", () => {

  it("returns 401 AUTH_MISSING_TOKEN when Authorization header is absent", () => {
    const { res, captured } = makeRes();
    const next = vi.fn();

    requireAuth(makeReq(), res, next);

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_MISSING_TOKEN);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 AUTH_INVALID_TOKEN when header has no space (no scheme separator)", () => {
    const { res, captured } = makeRes();

    requireAuth(makeReq(`BearerXXXXXXXXXX`), res, vi.fn());

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it("returns 401 AUTH_INVALID_TOKEN when scheme is not bearer", () => {
    const { res, captured } = makeRes();

    requireAuth(makeReq(`Token ${TEST_TOKEN}`), res, vi.fn());

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it("returns 401 AUTH_INVALID_TOKEN when bearer token part is empty", () => {
    const { res, captured } = makeRes();

    requireAuth(makeReq("Bearer "), res, vi.fn());

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it("returns 401 AUTH_INVALID_TOKEN when header has three parts", () => {
    const { res, captured } = makeRes();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN} extra`), res, vi.fn());

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it("accepts bearer scheme in any case: BEARER, Bearer, bearer", () => {
    for (const scheme of ["BEARER", "Bearer", "bearer"]) {
      requireAuth(makeReq(`${scheme} ${TEST_TOKEN}`), makeRes().res, vi.fn());
    }
    // All three should reach jwt.verify, not fail at the header check
    expect(mockVerify).toHaveBeenCalledTimes(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. JWT verification errors
// ═════════════════════════════════════════════════════════════════════════════

describe("B. JWT verification errors", () => {

  it("returns 401 AUTH_EXPIRED_TOKEN when jwt.verify throws TokenExpiredError", () => {
    mockVerify.mockImplementation(() => { throw new MockTokenExpiredError(); });
    const { res, captured } = makeRes();
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), res, next);

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_EXPIRED_TOKEN);
    expect((captured.body as any).error.message).toMatch(/expired/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 AUTH_INVALID_TOKEN when jwt.verify throws JsonWebTokenError (bad signature)", () => {
    mockVerify.mockImplementation(() => { throw new MockJsonWebTokenError("invalid signature"); });
    const { res, captured } = makeRes();
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), res, next);

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 AUTH_INVALID_TOKEN when jwt.verify throws JsonWebTokenError (malformed)", () => {
    mockVerify.mockImplementation(() => { throw new MockJsonWebTokenError("jwt malformed"); });
    const { res, captured } = makeRes();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), res, vi.fn());

    expect(captured.statusCode).toBe(401);
    expect((captured.body as any).error.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it("forwards unexpected non-JWT errors to next(err) for the global error handler", () => {
    const boom = new TypeError("something exploded");
    mockVerify.mockImplementation(() => { throw boom; });
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it("passes the raw token string and JWT_SECRET to jwt.verify", () => {
    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, vi.fn());

    expect(mockVerify).toHaveBeenCalledWith(
      TEST_TOKEN,
      "test-secret-minimum-32-characters-longXX",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. User identity resolution — sub / userId / id fallback chain
// ═════════════════════════════════════════════════════════════════════════════

describe("C. User identity claim resolution", () => {

  it("[sub] resolves userId from payload.sub — primary claim (RFC 7519)", () => {
    mockVerify.mockReturnValue({ sub: "user-42", email: "u@example.com" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);
    const next = vi.fn();

    requireAuth(req, makeRes().res, next);

    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(req.authContext?.userId).toBe("user-42");
  });

  it("[userId fallback] resolves from payload.userId (number) when sub is absent", () => {
    mockVerify.mockReturnValue({ userId: 99, email: "u@example.com" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("99"); // coerced to string
  });

  it("[userId fallback] resolves from payload.userId (string) when sub is absent", () => {
    mockVerify.mockReturnValue({ userId: "user-str-id" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("user-str-id");
  });

  it("[id fallback] resolves from payload.id when sub and userId are absent", () => {
    mockVerify.mockReturnValue({ id: "id-claim-value", email: "u@example.com" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("id-claim-value");
  });

  it("[id fallback] resolves from payload.id (number) when other claims absent", () => {
    mockVerify.mockReturnValue({ id: 7 });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("7");
  });

  it("[sub wins] sub takes precedence over userId and id when all three are present", () => {
    mockVerify.mockReturnValue({ sub: "sub-wins", userId: 100, id: "id-val" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("sub-wins");
  });

  it("[userId wins over id] userId beats id when sub is absent", () => {
    mockVerify.mockReturnValue({ userId: 50, id: "id-ignored" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("50");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Missing identity claims
// ═════════════════════════════════════════════════════════════════════════════

describe("D. Missing identity claims", () => {

  it("calls next(AuthError AUTH_INVALID_TOKEN) when all three claims are absent", () => {
    mockVerify.mockReturnValue({ email: "ghost@example.com" });
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.AUTH_INVALID_TOKEN }),
    );
  });

  it("calls next(AuthError) when payload is completely empty", () => {
    mockVerify.mockReturnValue({});
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.AUTH_INVALID_TOKEN }),
    );
  });

  it("calls next(AuthError) when userId is null (not a valid identity)", () => {
    mockVerify.mockReturnValue({ userId: null });
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.AUTH_INVALID_TOKEN }),
    );
  });

  it("calls next(AuthError) when sub is undefined and userId/id are also undefined", () => {
    mockVerify.mockReturnValue({ sub: undefined, userId: undefined, id: undefined });
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.AUTH_INVALID_TOKEN }),
    );
  });

  it("does not call sendFailure inline for missing-claim AuthError (delegated to errorHandler)", () => {
    // AuthError is re-thrown via next(err), NOT handled inline with sendFailure.
    // This preserves the global errorHandler envelope for the client.
    mockVerify.mockReturnValue({});
    const { res, captured } = makeRes();

    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), res, vi.fn());

    // sendFailure writes to res.status(statusCode), so statusCode should remain 0
    // if next(err) was used instead of sendFailure.
    expect(captured.statusCode).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. AuthContext attachment
// ═════════════════════════════════════════════════════════════════════════════

describe("E. AuthContext attachment to req", () => {

  it("attaches authContext with userId, email, and rawToken on success", () => {
    const RAW = "eyJ.my.token";
    mockVerify.mockReturnValue({ sub: "user-42", email: "alice@test.com" });
    const req = makeReq(`Bearer ${RAW}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext).toMatchObject({
      userId:   "user-42",
      email:    "alice@test.com",
      rawToken: RAW,
    });
  });

  it("attaches authContext without email when payload has no email claim", () => {
    mockVerify.mockReturnValue({ sub: "user-10" });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.userId).toBe("user-10");
    expect(req.authContext?.email).toBeUndefined();
  });

  it("stores the raw token exactly as-received — not the decoded payload", () => {
    const RAW = "eyJhbGciOiJIUzI1NiJ9.dGVzdA.sig";
    mockVerify.mockReturnValue({ sub: "u1" });
    const req = makeReq(`Bearer ${RAW}`);

    requireAuth(req, makeRes().res, vi.fn());

    expect(req.authContext?.rawToken).toBe(RAW);
  });

  it("calls next() with zero arguments on a successful authentication", () => {
    const next = vi.fn();
    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), makeRes().res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(/* nothing */);
  });

  it("does not call res.status on the success path", () => {
    const { res, captured } = makeRes();
    requireAuth(makeReq(`Bearer ${TEST_TOKEN}`), res, vi.fn());

    expect(captured.statusCode).toBe(0); // res.status was never called
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Regression: AUTH_INVALID_TOKEN: JWT missing sub claim
// ═════════════════════════════════════════════════════════════════════════════

describe("F. Regression — JWT sub claim missing (pre/post fix)", () => {

  it("accepts pre-fix tokens { userId, email, role } without sub via userId fallback", () => {
    // Before the backend fix, tokens had { userId: 1, email, role } — no sub.
    // The middleware must accept these tokens via the userId fallback to remain
    // backwards-compatible during the token refresh window.
    mockVerify.mockReturnValue({ userId: 1, email: "user@example.com", role: "user" });
    const req = makeReq(`Bearer legacy-token`);
    const next = vi.fn();

    requireAuth(req, makeRes().res, next);

    expect(next).toHaveBeenCalledWith(); // success — no error
    expect(req.authContext?.userId).toBe("1");
  });

  it("accepts post-fix tokens { sub, userId, email, role } — sub wins", () => {
    // After the backend fix, signToken() emits { sub, userId, email, role }.
    // sub must resolve first so the primary JWT claim is used.
    mockVerify.mockReturnValue({
      sub:    "1",
      userId: 1,
      email:  "user@example.com",
      role:   "user",
    });
    const req = makeReq(`Bearer post-fix-token`);
    const next = vi.fn();

    requireAuth(req, makeRes().res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.authContext?.userId).toBe("1");
  });

  it("rejects a token with role/email but no identity claim — cannot authorize", () => {
    // A token with only non-identity claims must still be rejected.
    mockVerify.mockReturnValue({ email: "ghost@example.com", role: "admin" });
    const next = vi.fn();

    requireAuth(makeReq(`Bearer ghost-token`), makeRes().res, next);

    const err = next.mock.calls[0]?.[0];
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCode.AUTH_INVALID_TOKEN);
  });

  it("userId 0 is treated as valid (not nullish under ?? operator)", () => {
    // The ?? operator only treats null/undefined as falsy.
    // A userId of 0 (edge case) should resolve as "0".
    mockVerify.mockReturnValue({ userId: 0 });
    const req = makeReq(`Bearer ${TEST_TOKEN}`);
    const next = vi.fn();

    requireAuth(req, makeRes().res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.authContext?.userId).toBe("0");
  });
});
