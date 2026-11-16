/**
 * N-07 / N-17: cookie reading, same-origin check and CSRF double submit (no DB, no server).
 * The full flow (login, refresh rotation, reuse detection, logout, legacy upgrade) was tested live against a local
 * API; see docs/auth_cookie_plan.md section 5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { readCookie } from '../authCookies';
import { csrfProblem, isSameAppOrigin, setCsrfAllowedOrigins } from '../../middleware/csrf';
import { sha256Hex, newOpaqueToken } from '../refreshTokens';

const req = (o: { method?: string; headers?: Record<string, string | undefined> }) =>
  ({ method: o.method ?? 'POST', headers: { host: 'api.example.com', ...(o.headers ?? {}) } }) as unknown as Request;

setCsrfAllowedOrigins(['https://app.example.com', 'http://localhost:3001/']);

test('readCookie finds a cookie among others, decodes it, returns null when missing', () => {
  const r = req({ headers: { cookie: 'a=1; mf_csrf=abc%2Fdef; mf_at=tok' } });
  assert.equal(readCookie(r, 'mf_csrf'), 'abc/def');
  assert.equal(readCookie(r, 'mf_at'), 'tok');
  assert.equal(readCookie(r, 'mf_rt'), null);
  assert.equal(readCookie(req({}), 'mf_at'), null);
});

test('same-origin check: allowed origins, own host, Referer fallback', () => {
  assert.equal(isSameAppOrigin(req({ headers: { origin: 'https://app.example.com' } })), true);
  assert.equal(isSameAppOrigin(req({ headers: { origin: 'http://localhost:3001' } })), true, 'trailing slash in config ignored');
  assert.equal(isSameAppOrigin(req({ headers: { origin: 'https://api.example.com' } })), true, 'own host');
  assert.equal(isSameAppOrigin(req({ headers: { referer: 'https://app.example.com/campaigns/1' } })), true);
  assert.equal(isSameAppOrigin(req({ headers: { origin: 'https://evil.example' } })), false);
  assert.equal(isSameAppOrigin(req({ headers: { origin: 'null' } })), false);
  assert.equal(isSameAppOrigin(req({})), false, 'no Origin and no Referer');
});

test('CSRF: reads pass, writes need allowed origin + matching header and cookie', () => {
  const ok = { origin: 'https://app.example.com', cookie: 'mf_csrf=s3cret', 'x-csrf-token': 's3cret' };
  assert.equal(csrfProblem(req({ method: 'GET', headers: {} })), null, 'GET without Origin (same-origin read)');
  assert.equal(csrfProblem(req({ headers: ok })), null);
  assert.equal(csrfProblem(req({ method: 'DELETE', headers: ok })), null);
  assert.notEqual(csrfProblem(req({ headers: { ...ok, origin: 'https://evil.example' } })), null, 'foreign origin');
  assert.notEqual(csrfProblem(req({ headers: { ...ok, 'x-csrf-token': undefined } })), null, 'no header');
  assert.notEqual(csrfProblem(req({ headers: { ...ok, 'x-csrf-token': 'other' } })), null, 'wrong header');
  assert.notEqual(csrfProblem(req({ headers: { ...ok, cookie: '' } })), null, 'no cookie');
  assert.notEqual(csrfProblem(req({ headers: { ...ok, 'x-csrf-token': 's3cre' } })), null, 'different length');
});

test('refresh tokens: random, URL-safe, only hashes are compared', () => {
  const a = newOpaqueToken();
  const b = newOpaqueToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sha256Hex(a).length, 64);
  assert.equal(sha256Hex(a), sha256Hex(a));
});
