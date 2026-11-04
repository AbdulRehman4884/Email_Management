/**
 * N-07 / N-17: session cookies.
 *   mf_at   access token (JWT, short-lived)   HttpOnly, Secure, SameSite=Lax,    Path=/api
 *   mf_rt   refresh token (random, rotated)   HttpOnly, Secure, SameSite=Strict, Path=/api/auth
 *   mf_csrf CSRF double-submit value           HttpOnly, Secure, SameSite=Strict, Path=/api
 * The page never reads these cookies: the access token and CSRF value it needs come in the JSON body of
 * login / refresh and are kept in memory only.
 * COOKIE_SECURE=false drops the Secure flag (only for local http testing in a browser that needs it).
 */
import type { CookieOptions, Request, Response } from 'express';

export const ACCESS_COOKIE = 'mf_at';
export const REFRESH_COOKIE = 'mf_rt';
export const CSRF_COOKIE = 'mf_csrf';

const secure = process.env.COOKIE_SECURE !== 'false';

const accessOpts: CookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/api' };
const refreshOpts: CookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/api/auth' };
const csrfOpts: CookieOptions = { httpOnly: true, secure, sameSite: 'strict', path: '/api' };

/** Reads one cookie from the request's Cookie header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function setSessionCookies(
  res: Response,
  v: { accessToken: string; accessMaxAgeMs: number; refreshToken: string; refreshMaxAgeMs: number; csrfToken: string }
): void {
  res.cookie(ACCESS_COOKIE, v.accessToken, { ...accessOpts, maxAge: v.accessMaxAgeMs });
  res.cookie(REFRESH_COOKIE, v.refreshToken, { ...refreshOpts, maxAge: v.refreshMaxAgeMs });
  res.cookie(CSRF_COOKIE, v.csrfToken, { ...csrfOpts, maxAge: v.refreshMaxAgeMs });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, accessOpts);
  res.clearCookie(REFRESH_COOKIE, refreshOpts);
  res.clearCookie(CSRF_COOKIE, csrfOpts);
}
