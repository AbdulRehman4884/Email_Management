/**
 * Email and phone checks (use case UC-07).
 *   - email: syntax, junk filter (example.com, noreply, image file names like logo@2x.png), generic vs direct,
 *     MX record lookup (cached). No SMTP ping (looks like spam). No guessed addresses (first.last@) in v1.
 *   - phone: E.164 via libphonenumber-js, with the company's country as default.
 */
import dns from 'node:dns/promises';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { normalizeEmail } from './normalize.js';

const JUNK_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'domain.com', 'email.com', 'yourdomain.com', 'yoursite.com', 'website.com',
  'test.com', 'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'mysite.com', 'company.com', 'abc.com', 'xyz.com',
]);
const JUNK_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|abuse|webmaster|example|test|user|username|name|email|your-?email|yourname|someone)$/;
/** "logo@2x.png", "icon@3x.webp": image names that look like emails. */
const FILE_TLD = /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf|eot)$/;
const GENERIC_LOCAL = /^(info|contact|hello|hi|admin|office|enquir(y|ies)|inquir(y|ies)|mail|team|general|reception|appointments?|booking|bookings|help)$/;
const SALES_LOCAL = /^(sales|business|marketing|partnerships?|bd)$/;
const SUPPORT_LOCAL = /^(support|care|customercare|service|helpdesk)$/;

export type EmailLabel = 'generic' | 'direct' | 'sales' | 'support';

/** Normalized email, or null when it is junk (placeholder, no-reply, image name, hash-like). */
export function cleanEmail(input: string | null | undefined): string | null {
  const e = normalizeEmail(input);
  if (!e) return null;
  const [local, domain] = e.split('@') as [string, string];
  if (FILE_TLD.test(e) || JUNK_DOMAINS.has(domain) || JUNK_LOCAL.test(local)) return null;
  // Tracking ids and hashes ("a1b2c3d4e5f6a7b8c9@...") are not people.
  if (/^[0-9a-f]{16,}$/.test(local) || /^\d{6,}$/.test(local)) return null;
  if (domain.endsWith('.local') || domain.endsWith('.invalid') || domain.endsWith('.test')) return null;
  return e;
}

export function emailLabel(email: string): EmailLabel {
  const local = email.split('@')[0] ?? '';
  if (GENERIC_LOCAL.test(local)) return 'generic';
  if (SALES_LOCAL.test(local)) return 'sales';
  if (SUPPORT_LOCAL.test(local)) return 'support';
  return 'direct';
}

const mxCache = new Map<string, { ok: boolean; at: number }>();
const MX_CACHE_MS = 6 * 60 * 60_000;

/** True when the domain has an MX record (or an A record, the RFC 5321 fallback). Cached for 6 hours. */
export async function hasMx(domain: string, resolver: Pick<typeof dns, 'resolveMx' | 'resolve4'> = dns): Promise<boolean> {
  const key = domain.toLowerCase();
  const hit = mxCache.get(key);
  if (hit && Date.now() - hit.at < MX_CACHE_MS) return hit.ok;
  let ok = false;
  try {
    const mx = await resolver.resolveMx(key);
    ok = mx.some((r) => r.exchange && r.exchange !== '.');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENODATA') {
      try {
        ok = (await resolver.resolve4(key)).length > 0;
      } catch {
        ok = false;
      }
    } else if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
      // DNS trouble (timeout): do not cache a negative answer.
      return false;
    }
  }
  mxCache.set(key, { ok, at: Date.now() });
  return ok;
}

/** "+92 42 1234567", "042-36668548" (PK) -> "+924236668548". Null when it is not a valid number. */
export function normalizePhone(input: string | null | undefined, defaultCountry: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.replace(/^tel:/i, '').trim();
  if (raw.replace(/\D/g, '').length < 7) return null;
  const cc = (defaultCountry ?? '').toUpperCase();
  try {
    const p = parsePhoneNumberFromString(raw, /^[A-Z]{2}$/.test(cc) ? (cc as CountryCode) : undefined);
    return p && p.isValid() ? p.number : null;
  } catch {
    return null;
  }
}

/** Tests only. */
export function clearMxCache(): void {
  mxCache.clear();
}
