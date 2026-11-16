import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isNonHumanOpen } from './trackController.js';
import { allowHit } from '../lib/publicRateLimit.js';
import { clientIp, emitPageviewEvents, hashIp, recordPageview } from '../lib/crm/webTracking.js';
import { verifyLeadLinkCode } from '../lib/crm/linkCode.js';
import { runCrmInBackground } from '../lib/crm/backgroundQueue.js';

const TRACKING_SCRIPT = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 't.js'),
  'utf8'
);

/** Page views per minute: per visitor IP, and per website. */
const MAX_PER_IP_PER_MINUTE = 60;
const MAX_PER_SITE_PER_MINUTE = 3000;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** GET /t.js */
export function trackingScriptHandler(_req: Request, res: Response) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.type('application/javascript').send(TRACKING_SCRIPT);
}

/**
 * POST /api/public/track (sent by t.js as text/plain, so browsers send it without a preflight).
 * Answers { s: 1 } when the page view was saved, and m: 1 when the ?mf= code is valid (t.js then keeps it).
 * The CORS header is only added for the website's own domain, so other sites cannot read the answer.
 */
export async function trackPageviewHandler(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const reject = () => res.status(204).end();

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!parsed || typeof parsed !== 'object') return reject();
    body = parsed as Record<string, unknown>;
  } catch {
    return reject();
  }

  if (req.headers.dnt === '1' || isNonHumanOpen(req.headers['user-agent'])) return reject();

  const siteKey = str(body.s, 40);
  const visitorKey = str(body.v, 64);
  const pageUrl = str(body.u, 2000);
  if (!/^ST_[A-Za-z0-9_-]{8,37}$/.test(siteKey) || !/^[A-Za-z0-9_-]{16,64}$/.test(visitorKey) || !pageUrl) return reject();

  const ipHash = hashIp(clientIp(req));
  if (!allowHit(`track:ip:${ipHash}`, MAX_PER_IP_PER_MINUTE) || !allowHit(`track:site:${siteKey}`, MAX_PER_SITE_PER_MINUTE)) {
    return res.status(429).end();
  }

  const origin = typeof req.headers.origin === 'string' && req.headers.origin !== 'null' ? req.headers.origin : null;
  try {
    const result = await recordPageview({
      siteKey,
      visitorKey,
      pageUrl,
      origin,
      title: str(body.t, 500) || null,
      referrer: str(body.r, 2000) || null,
      consent: body.c === 1,
      ipHash,
      leadRecipientId: verifyLeadLinkCode(body.m),
      fromLink: body.f === 1,
    });
    if (result.status === 'rejected') return reject();
    if (result.status === 'saved' && result.contactId != null) {
      runCrmInBackground(`website visit contact ${result.contactId}`, () => emitPageviewEvents(result));
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.json(result.status === 'saved' ? { s: 1, m: result.linked ? 1 : 0 } : { s: 0 });
  } catch {
    res.status(500).end();
  }
}
