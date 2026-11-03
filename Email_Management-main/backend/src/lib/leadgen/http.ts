/**
 * Guarded HTTP fetch for the Lead Engine. Every outgoing request of the collectors goes through here.
 *
 *  - only http/https, no credentials in the URL, ports 80/443/8080/8443
 *  - SSRF guard: the hostname is resolved and EVERY address is checked at connect time
 *    (private, loopback, link-local, CGNAT, multicast, reserved, cloud metadata). Because the check
 *    runs inside the socket's DNS lookup, a DNS rebind between check and connect is not possible.
 *  - redirects followed by hand (max 5), every hop checked again
 *  - 10 s timeout for the whole request (headers + body)
 *  - 1 MB cap on the decompressed body (gzip/deflate/br), so zip bombs stop early
 *  - optional content-type check (html / json)
 *
 * robots.txt and per-host rate limits are added on top by fetchPage.ts.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { FETCH_MAX_BYTES, FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, userAgent } from './config.js';
import { FetchError } from './errors.js';

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** 'html' rejects non-HTML answers, 'json' rejects non-JSON. Default 'any'. */
  expect?: 'html' | 'json' | 'text' | 'any';
}

export interface FetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** URLs we were redirected through (in order, without the final one). */
  redirects: string[];
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

// ── Address checks ───────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expands an IPv6 address to 8 groups of 16 bits. */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase().split('%')[0]!;
  // Embedded IPv4 ("::ffff:10.0.0.1") -> two hex groups.
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    addr = addr.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isBlockedV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): check the IPv4 part.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedV4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x0064 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 (could reach IPv4 private)
  if (first === 0x2002) return true; // 6to4 (embeds an IPv4 address)
  return false;
}

/** True for any address a crawler must never connect to. Unknown formats count as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

/** Parses and checks a URL before any request is made. Throws FetchError('bad_url' | 'blocked_address'). */
export function assertFetchableUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new FetchError(`Invalid URL`, 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError(`Protocol ${u.protocol} not allowed`, 'bad_url');
  if (u.username || u.password) throw new FetchError('Credentials in URL not allowed', 'bad_url');
  if (!ALLOWED_PORTS.has(u.port)) throw new FetchError(`Port ${u.port} not allowed`, 'bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new FetchError('Local hostname not allowed', 'blocked_address');
  }
  if (net.isIP(host) && isBlockedAddress(host)) throw new FetchError('Private address not allowed', 'blocked_address');
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * DNS lookup used by the socket itself: resolves all addresses and refuses the connection
 * when any of them is blocked. Handles both callback shapes (`all: true` is used by Happy Eyeballs).
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions | number, callback: LookupCallback): void {
  const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : (options ?? {});
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err, opts.all ? [] : '', undefined);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), opts.all ? [] : '');
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) {
      const e = new FetchError(`Address of ${hostname} is private`, 'blocked_address') as unknown as NodeJS.ErrnoException;
      return callback(e, opts.all ? [] : '');
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function decoderFor(encoding: string | undefined, stream: Readable): Readable {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return stream.pipe(zlib.createGunzip());
    case 'deflate':
      return stream.pipe(zlib.createInflate());
    case 'br':
      return stream.pipe(zlib.createBrotliDecompress());
    default:
      return stream;
  }
}

function charsetOf(contentType: string): string {
  const m = contentType.match(/charset=["']?([\w-]+)/i);
  return m ? m[1]!.toLowerCase() : 'utf-8';
}

function decodeBody(buf: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType) as ConstructorParameters<typeof TextDecoder>[0]).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function checkContentType(expect: FetchOptions['expect'], contentType: string, status: number): void {
  if (!expect || expect === 'any' || status >= 300) return;
  const ct = contentType.toLowerCase();
  const ok =
    expect === 'html' ? ct.includes('text/html') || ct.includes('application/xhtml+xml')
    : expect === 'json' ? ct.includes('json')
    : ct.startsWith('text/') || ct.includes('xml') || ct === '';
  if (!ok) throw new FetchError(`Unexpected content type ${contentType || '(none)'}`, 'wrong_content_type');
}

interface HopResult {
  status: number;
  headers: Record<string, string>;
  location: string | null;
  body: string;
}

function oneHop(url: URL, opts: FetchOptions, deadline: number, maxBytes: number): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError('Request timed out', 'timeout'));
    const lib = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {
      'user-agent': userAgent(),
      accept: opts.expect === 'json' ? 'application/json' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en;q=0.9',
      ...lowerKeys(opts.headers ?? {}),
    };
    if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new FetchError('Request timed out', 'timeout')), remaining);

    const req = lib.request(
      url,
      { method: opts.method ?? 'GET', headers, lookup: guardedLookup as unknown as net.LookupFunction },
      (res) => {
        const status = res.statusCode ?? 0;
        const resHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) resHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        const contentType = resHeaders['content-type'] ?? '';

        if (status >= 300 && status < 400 && resHeaders.location) {
          res.resume();
          settled = true;
          clearTimeout(timer);
          return resolve({ status, headers: resHeaders, location: resHeaders.location, body: '' });
        }
        try {
          checkContentType(opts.expect, contentType, status);
        } catch (e) {
          res.resume();
          return fail(e as Error);
        }
        const declared = Number(resHeaders['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes && !resHeaders['content-encoding']) {
          res.resume();
          return fail(new FetchError('Response larger than 1 MB', 'too_large'));
        }
        if (opts.method === 'HEAD') {
          res.resume();
          settled = true;
          clearTimeout(timer);
          return resolve({ status, headers: resHeaders, location: null, body: '' });
        }

        const stream = decoderFor(resHeaders['content-encoding'], res);
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            stream.destroy();
            res.destroy();
            return fail(new FetchError('Response larger than 1 MB', 'too_large'));
          }
          chunks.push(chunk);
        });
        stream.on('error', (e) => fail(e instanceof FetchError ? e : new FetchError(`Response read failed: ${e.message}`, 'network')));
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, headers: resHeaders, location: null, body: decodeBody(Buffer.concat(chunks), contentType) });
        });
      }
    );
    req.on('error', (e) => fail(e instanceof FetchError ? e : new FetchError(`Request failed: ${e.message}`, 'network')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Fetches a public URL with all guards. Non-2xx answers are returned (callers decide what 403/429 mean);
 * guard violations, timeouts and network errors throw FetchError.
 */
export async function safeFetch(input: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? FETCH_MAX_REDIRECTS;
  const redirects: string[] = [];
  let url = assertFetchableUrl(input);
  let hopOpts = opts;

  for (;;) {
    const hop = await oneHop(url, hopOpts, deadline, maxBytes);
    if (!hop.location) {
      return { url: url.toString(), status: hop.status, headers: hop.headers, body: hop.body, redirects };
    }
    if (redirects.length >= maxRedirects) throw new FetchError(`More than ${maxRedirects} redirects`, 'too_many_redirects');
    redirects.push(url.toString());
    let next: URL;
    try {
      next = new URL(hop.location, url);
    } catch {
      throw new FetchError('Invalid redirect location', 'bad_url');
    }
    const nextUrl = assertFetchableUrl(next.toString());
    // Never send API credentials to another origin.
    if (nextUrl.origin !== url.origin && hopOpts.headers) {
      const headers = lowerKeys(hopOpts.headers);
      delete headers.authorization;
      delete headers.cookie;
      hopOpts = { ...hopOpts, headers };
    }
    url = nextUrl;
    // 303 (and 301/302 after POST) continue as GET without a body, like browsers.
    if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && hopOpts.method === 'POST')) {
      const { body: _body, ...rest } = hopOpts;
      hopOpts = { ...rest, method: 'GET' };
    }
  }
}
