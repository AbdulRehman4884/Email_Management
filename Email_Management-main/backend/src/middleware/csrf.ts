/**
 * N-07: CSRF protection for cookie-authenticated requests.
 * A request authenticated by the Authorization header (AI agent, MCP server, scripts) is not affected: a browser
 * never adds that header on its own. Checks for cookie requests:
 *   1. same-origin: Origin (or Referer) must be the API's own host or an allowed CORS origin;
 *   2. double submit: for state-changing methods, X-CSRF-Token must equal the mf_csrf cookie.
 * SameSite on the cookies is the first line of defence; these checks are the second.
 */
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { CSRF_COOKIE, readCookie } from '../lib/authCookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let allowedOrigins: string[] = [];
/** Same list as the CORS origins (set once in index.ts). */
export function setCsrfAllowedOrigins(origins: string[]): void {
  allowedOrigins = origins.map((o) => o.replace(/\/+$/, ''));
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return origin.replace(/\/+$/, '');
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/** True when the request comes from a page of this app (its own host, or an allowed origin). */
export function isSameAppOrigin(req: Request): boolean {
  const origin = requestOrigin(req);
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** null = OK; otherwise the reason the cookie request is refused (403). */
export function csrfProblem(req: Request): string | null {
  // Reads: browsers send no Origin on same-origin GETs, and other sites cannot read the response (CORS).
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  if (!isSameAppOrigin(req)) return 'Request origin not allowed';
  const header = req.headers['x-csrf-token'];
  const sent = Array.isArray(header) ? header[0] : header;
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!sent || !cookie || !safeEqual(sent, cookie)) return 'Missing or invalid CSRF token';
  return null;
}
