/**
 * src/tests/services/emailValidation.service.test.ts
 *
 * Tests the emailValidation.service in isolation.
 *
 * Covers (heuristic path — no API key):
 *   1. Valid business email      → isValid=true, businessEmail=true
 *   2. Invalid email format      → isValid=false, domain=null
 *   3. Disposable email          → disposable=true, businessEmail=false
 *   4. Malformed email           → isValid=false
 *
 * Covers (API path — ABSTRACT_API_KEY configured):
 *   5. Successful API response   → source="api", correct flags
 *   6. API timeout               → falls back to heuristic
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Env mock ──────────────────────────────────────────────────────────────────
// Must be hoisted so the mock factory can reference it before imports resolve.

const mockEnv = vi.hoisted(() => ({
  LOG_LEVEL:         "silent" as string,
  LOG_PRETTY:        false,
  NODE_ENV:          "test" as const,
  ABSTRACT_API_KEY:  undefined as string | undefined,
  JINA_API_KEY:      undefined as string | undefined,
  FIRECRAWL_API_KEY: undefined as string | undefined,
}));

vi.mock("../../config/env.js", () => ({ env: mockEnv }));

import { validateEmail } from "../../services/enrichment/emailValidation.service.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAbstractApiResponse(overrides: Record<string, unknown> = {}) {
  return {
    deliverability:      "DELIVERABLE",
    is_valid_format:     { value: true,  text: "TRUE" },
    is_free_email:       { value: false, text: "FALSE" },
    is_disposable_email: { value: false, text: "FALSE" },
    ...overrides,
  };
}

function mockFetchOk(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok:   true,
    json: async () => body,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("emailValidation.service", () => {
  beforeEach(() => {
    mockEnv.ABSTRACT_API_KEY = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Heuristic path ──────────────────────────────────────────────────────────

  describe("heuristic path (no ABSTRACT_API_KEY)", () => {
    it("1. classifies a valid business email correctly", async () => {
      const result = await validateEmail("alice@acme.com");

      expect(result.isValid).toBe(true);
      expect(result.businessEmail).toBe(true);
      expect(result.disposable).toBe(false);
      expect(result.domain).toBe("acme.com");
      expect(result.email).toBe("alice@acme.com");
      expect(result.source).toBe("heuristic");
    });

    it("2. rejects an invalid email format", async () => {
      const result = await validateEmail("not-an-email");

      expect(result.isValid).toBe(false);
      expect(result.domain).toBeNull();
      expect(result.businessEmail).toBe(false);
      expect(result.source).toBe("heuristic");
    });

    it("3. detects a disposable email provider", async () => {
      const result = await validateEmail("throwaway@mailinator.com");

      expect(result.isValid).toBe(true);
      expect(result.disposable).toBe(true);
      expect(result.businessEmail).toBe(false);
      expect(result.domain).toBe("mailinator.com");
      expect(result.source).toBe("heuristic");
    });

    it("4. rejects a completely malformed address", async () => {
      const result = await validateEmail("@@@");

      expect(result.isValid).toBe(false);
      expect(result.domain).toBeNull();
      expect(result.source).toBe("heuristic");
    });

    it("lowercases the email in the result", async () => {
      const result = await validateEmail("Alice@ACME.COM");
      expect(result.email).toBe("alice@acme.com");
      expect(result.domain).toBe("acme.com");
    });

    it("classifies a personal email as non-business", async () => {
      const result = await validateEmail("bob@gmail.com");
      expect(result.isValid).toBe(true);
      expect(result.businessEmail).toBe(false);
      expect(result.disposable).toBe(false);
    });
  });

  // ── API path ────────────────────────────────────────────────────────────────

  describe("API path (ABSTRACT_API_KEY configured)", () => {
    beforeEach(() => {
      mockEnv.ABSTRACT_API_KEY = "test-key-abc123";
    });

    it("5. returns API result for a valid business email", async () => {
      mockFetchOk(makeAbstractApiResponse());

      const result = await validateEmail("alice@acme.com");

      expect(result.isValid).toBe(true);
      expect(result.businessEmail).toBe(true);
      expect(result.disposable).toBe(false);
      expect(result.source).toBe("api");
    });

    it("marks a free email when API reports is_free_email=true", async () => {
      mockFetchOk(makeAbstractApiResponse({
        is_free_email: { value: true, text: "TRUE" },
      }));

      const result = await validateEmail("user@gmail.com");
      expect(result.businessEmail).toBe(false);
      expect(result.source).toBe("api");
    });

    it("marks disposable when API reports is_disposable_email=true", async () => {
      mockFetchOk(makeAbstractApiResponse({
        is_disposable_email: { value: true, text: "TRUE" },
      }));

      const result = await validateEmail("temp@mailinator.com");
      expect(result.disposable).toBe(true);
      expect(result.businessEmail).toBe(false);
      expect(result.source).toBe("api");
    });

    it("6. falls back to heuristic on API timeout", async () => {
      const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutErr));

      const result = await validateEmail("alice@acme.com");

      expect(result.source).toBe("heuristic");
      // heuristic still validates acme.com as business
      expect(result.isValid).toBe(true);
      expect(result.businessEmail).toBe(true);
    });

    it("falls back to heuristic when API returns non-OK status", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));

      const result = await validateEmail("alice@acme.com");
      expect(result.source).toBe("heuristic");
    });

    it("skips the API call when email format is invalid", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const result = await validateEmail("bad-email");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.isValid).toBe(false);
    });
  });
});
