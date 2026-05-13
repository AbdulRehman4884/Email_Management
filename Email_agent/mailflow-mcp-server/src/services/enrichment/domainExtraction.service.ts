/**
 * src/services/enrichment/domainExtraction.service.ts
 *
 * Pure domain extraction from an email address or URL.
 * No external API calls — zero network latency.
 *
 * Accepts:
 *   - Full email address:  "alice@mail.acme.com" → domain "acme.com"
 *   - Raw domain:          "acme.com"            → domain "acme.com"
 *   - URL with protocol:   "https://acme.com/x"  → domain "acme.com"
 */

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Result type ───────────────────────────────────────────────────────────────

export interface DomainExtractionResult {
  domain: string;
  subdomain?: string;
  tld: string;
  isPersonal: boolean;
  website: string;
}

// ── Public service function ───────────────────────────────────────────────────

/**
 * Extracts the registered domain (SLD + TLD) from an email, URL, or raw domain.
 * Returns null when the input cannot be parsed into a valid domain.
 */
export function extractDomain(input: string): DomainExtractionResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let rawDomain: string;

  if (trimmed.includes("@")) {
    // Email address
    if (!EMAIL_RE.test(trimmed)) return null;
    rawDomain = trimmed.slice(trimmed.indexOf("@") + 1).toLowerCase();
  } else {
    // URL or raw domain — strip protocol and path
    rawDomain = trimmed
      .replace(/^https?:\/\//i, "")
      .split("/")[0]!
      .toLowerCase();
  }

  // Strip port number if present
  rawDomain = rawDomain.split(":")[0]!;

  if (!rawDomain || rawDomain.length < 3) return null;

  const parts = rawDomain.split(".");
  if (parts.length < 2) return null;

  const tld              = parts[parts.length - 1]!;
  const sld              = parts[parts.length - 2]!;
  const subdomainParts   = parts.slice(0, -2);
  const subdomain        = subdomainParts.length > 0 ? subdomainParts.join(".") : undefined;
  const registeredDomain = `${sld}.${tld}`;

  return {
    domain:     registeredDomain,
    ...(subdomain ? { subdomain } : {}),
    tld,
    isPersonal: PERSONAL_DOMAINS.has(registeredDomain),
    website:    `https://${registeredDomain}`,
  };
}
