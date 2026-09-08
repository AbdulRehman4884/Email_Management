/**
 * src/services/enrichment/emailValidation.service.ts
 *
 * Validates an email address using the Abstract API (when ABSTRACT_API_KEY is
 * configured) or falls back to heuristic domain-list matching.
 *
 * Timeouts: 8 s for the Abstract API call.
 * Fallback: heuristic validation is always attempted when the API is absent,
 * unavailable, or times out — the service never throws.
 */

import { z } from "zod";
import { env } from "../../config/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("service:emailValidation");

// ── Known personal email domains ──────────────────────────────────────────────

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.fr", "ymail.com",
  "hotmail.com", "hotmail.co.uk", "hotmail.fr",
  "outlook.com", "outlook.co.uk",
  "live.com", "live.co.uk",
  "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "aim.com",
  "protonmail.com", "proton.me", "pm.me",
  "fastmail.com", "fastmail.fm",
  "tutanota.com", "tuta.io",
  "gmx.com", "gmx.net", "gmx.de",
  "mail.com", "inbox.com",
  "yandex.com", "yandex.ru",
  "rocketmail.com",
]);

// ── Known disposable / temporary email domains ────────────────────────────────

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "tempmail.com", "throwaway.email",
  "yopmail.com", "sharklasers.com", "guerrillamail.info", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.net", "guerrillamail.org", "spam4.me",
  "trashmail.com", "trashmail.me", "trashmail.net", "trashmail.at",
  "trashmail.io", "dispostable.com", "maildrop.cc", "mailnesia.com",
  "fakeinbox.com", "filzmail.com", "getonemail.com", "tempr.email",
  "discard.email", "spamgourmet.com", "mintemail.com", "safetymail.info",
  "mailnull.com", "spamfree24.org", "spamherelots.com", "throwam.com",
  "yepmail.net", "mailiscool.com",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Result type ───────────────────────────────────────────────────────────────

export interface EmailValidationResult {
  email: string;
  isValid: boolean;
  domain: string | null;
  businessEmail: boolean;
  disposable: boolean;
  source: "api" | "heuristic";
  reason?: string;
}

// ── Abstract API response schema ──────────────────────────────────────────────

const AbstractApiResponseSchema = z.object({
  email:               z.string().optional(),
  deliverability:      z.string().optional(),
  quality_score:       z.string().optional(),
  is_valid_format:     z.object({ value: z.boolean(), text: z.string() }).optional(),
  is_free_email:       z.object({ value: z.boolean(), text: z.string() }).optional(),
  is_disposable_email: z.object({ value: z.boolean(), text: z.string() }).optional(),
  is_role_email:       z.object({ value: z.boolean(), text: z.string() }).optional(),
  is_catchall_email:   z.object({ value: z.boolean(), text: z.string() }).optional(),
  is_mx_found:         z.object({ value: z.boolean(), text: z.string() }).optional(),
  is_smtp_valid:       z.object({ value: z.boolean(), text: z.string() }).optional(),
});

type AbstractApiResponse = z.infer<typeof AbstractApiResponseSchema>;

// ── Heuristic fallback ────────────────────────────────────────────────────────

function heuristicValidate(email: string): EmailValidationResult {
  if (!EMAIL_RE.test(email)) {
    return {
      email,
      isValid:       false,
      domain:        null,
      businessEmail: false,
      disposable:    false,
      source:        "heuristic",
      reason:        "Invalid email format",
    };
  }
  const domain       = email.slice(email.indexOf("@") + 1).toLowerCase();
  const isPersonal   = PERSONAL_DOMAINS.has(domain);
  const isDisposable = DISPOSABLE_DOMAINS.has(domain);
  return {
    email:         email.toLowerCase(),
    isValid:       true,
    domain,
    businessEmail: !isPersonal && !isDisposable,
    disposable:    isDisposable,
    source:        "heuristic",
    reason:        isDisposable
      ? "Disposable email provider"
      : isPersonal
      ? "Free/consumer email provider"
      : "Business domain",
  };
}

// ── Abstract API call ─────────────────────────────────────────────────────────

async function callAbstractApi(email: string, apiKey: string): Promise<AbstractApiResponse> {
  const url =
    `https://emailvalidation.abstractapi.com/v1/` +
    `?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
  const response = await fetch(url, {
    signal:  AbortSignal.timeout(8_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Abstract API returned ${response.status}`);
  }
  return AbstractApiResponseSchema.parse(await response.json());
}

// ── Public service function ───────────────────────────────────────────────────

export async function validateEmail(email: string): Promise<EmailValidationResult> {
  const apiKey = env.ABSTRACT_API_KEY;

  if (!apiKey) {
    log.debug({ email }, "emailValidation: no ABSTRACT_API_KEY — using heuristic");
    return heuristicValidate(email);
  }

  // Format check before burning an API call
  if (!EMAIL_RE.test(email)) {
    return {
      email,
      isValid:       false,
      domain:        null,
      businessEmail: false,
      disposable:    false,
      source:        "heuristic",
      reason:        "Invalid email format",
    };
  }

  try {
    const data   = await callAbstractApi(email, apiKey);
    const domain = email.slice(email.indexOf("@") + 1).toLowerCase();

    const isValid      = data.is_valid_format?.value === true;
    const isDisposable = data.is_disposable_email?.value === true;
    const isFreeEmail  = data.is_free_email?.value === true;
    const deliverable  = data.deliverability?.toLowerCase() === "deliverable";

    log.debug(
      { email, deliverability: data.deliverability, isFreeEmail, isDisposable },
      "emailValidation: API response",
    );

    return {
      email:         email.toLowerCase(),
      isValid:       isValid && deliverable,
      domain,
      businessEmail: isValid && !isFreeEmail && !isDisposable,
      disposable:    isDisposable,
      source:        "api",
      reason:        !isValid
        ? "Invalid format per API"
        : isDisposable
        ? "Disposable email provider"
        : isFreeEmail
        ? "Free/consumer email provider"
        : "Business domain",
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.message.toLowerCase().includes("timeout") ||
        err.message.toLowerCase().includes("abort"));
    if (isTimeout) {
      log.warn({ email }, "emailValidation: Abstract API timed out — using heuristic fallback");
    } else {
      log.warn(
        { email, err: err instanceof Error ? err.message : err },
        "emailValidation: Abstract API failed — using heuristic fallback",
      );
    }
    return heuristicValidate(email);
  }
}
