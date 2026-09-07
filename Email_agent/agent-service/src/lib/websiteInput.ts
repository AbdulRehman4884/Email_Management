/**
 * Website / domain validation for enrichment Phase 3 (reject emails mistaken for URLs).
 */

const EMAIL_STRICT =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+$/;

/** True if the value looks like an email address or contains “@” outside a normal https URL path (reject as website input). */
export function isEmailLike(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  if (EMAIL_STRICT.test(t)) return true;
  // URLs with userinfo can contain @ — still reject bare strings with @ for Phase 3 website field
  if (!/^https?:\/\//i.test(t) && t.includes("@")) return true;
  return false;
}

/**
 * Returns a normalized https URL or undefined if the input is not a plausible public website/domain.
 */
export function normalizeWebsiteUrlOrUndefined(raw: string): string | undefined {
  const t = raw.trim().replace(/[)\].,;]+$/, "");
  if (!t || isEmailLike(t)) return undefined;

  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      const host = u.hostname.replace(/^www\./, "");
      if (!host.includes(".")) return undefined;
      if (EMAIL_STRICT.test(host)) return undefined;
      let out = u.toString().split("#")[0] ?? u.toString();
      if (out.endsWith("/") && u.pathname === "/") {
        out = out.slice(0, -1);
      }
      return out;
    } catch {
      return undefined;
    }
  }

  const bare = t.replace(/^www\./i, "");
  if (!/^[\w.-]+\.[a-z]{2,}$/i.test(bare)) return undefined;
  const parts = bare.split(".").filter(Boolean);
  if (parts.length < 2) return undefined;
  return `https://${bare}`;
}

/** True if the string can be used as a website hostname / URL for Phase 3 (not email, has a real domain shape). */
export function isValidWebsiteInput(value: string): boolean {
  return normalizeWebsiteUrlOrUndefined(value) !== undefined;
}
