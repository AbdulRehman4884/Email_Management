import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isNonHumanOpen } from './trackController.js';
import { allowHit } from '../lib/publicRateLimit.js';
import { clientIp, hashIp } from '../lib/crm/webTracking.js';
import { DEFAULT_DESIGN, afterSubmit, loadFormByKey, submitForm } from '../lib/crm/forms.js';
import { dbPool } from '../lib/db.js';
import { runCrmInBackground } from '../lib/crm/backgroundQueue.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const EMBED_SCRIPT = fs.readFileSync(path.join(PUBLIC_DIR, 'f.js'), 'utf8');
const RENDER_SCRIPT = fs.readFileSync(path.join(PUBLIC_DIR, 'form-render.js'), 'utf8');

/** The app pages that may send a live preview to /f/preview (same list as the CORS origins in index.ts). */
const PREVIEW_ORIGINS = [
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:3002',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : []),
];

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;padding:32px 16px}
body.mf-embed{background:transparent;padding:0}
#mf-root{max-width:480px;margin:0 auto}
.mf-box{background:var(--mf-bg);color:var(--mf-text);border-radius:var(--mf-radius);padding:24px}
body:not(.mf-embed) .mf-box{box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
.mf-title{font-size:20px;margin:0 0 6px}
.mf-desc{margin:0 0 16px;opacity:.8;font-size:14px;white-space:pre-wrap}
.mf-row{margin-bottom:12px}
.mf-row label{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
.mf-req{color:#dc2626}
.mf-row input,.mf-row select,.mf-row textarea{width:100%;font:inherit;font-size:14px;padding:9px 11px;border:1px solid #d1d5db;border-radius:var(--mf-radius);background:#fff;color:#111827}
.mf-row textarea{resize:vertical}
.mf-err{color:#dc2626;font-size:12px;margin-top:3px}
.mf-err:empty{display:none}
.mf-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.mf-consent{display:flex;gap:6px;align-items:flex-start;font-size:13px;margin:4px 0 8px}
.mf-btn{width:100%;margin-top:6px;padding:11px 16px;font:inherit;font-weight:600;font-size:15px;border:0;cursor:pointer;background:var(--mf-btn);color:var(--mf-btn-text);border-radius:var(--mf-radius)}
.mf-btn:disabled{opacity:.6;cursor:default}
.mf-status{font-size:13px;margin:8px 0 0;min-height:1em}
.mf-status:empty{display:none}
.mf-done,.mf-closed{font-size:15px;margin:8px 0;white-space:pre-wrap}
.cf-turnstile,.g-recaptcha{margin:8px 0}
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON that is safe inside a <script> tag. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function page(res: Response, status: number, title: string, cfg: unknown) {
  res.status(status);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style></head><body><div id="mf-root"></div>` +
      `<script>window.__MF_CFG=${scriptJson(cfg)};</script><script>${RENDER_SCRIPT}</script></body></html>`
  );
}

/** GET /f.js */
export function formScriptHandler(_req: Request, res: Response) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.type('application/javascript').send(EMBED_SCRIPT);
}

/**
 * GET /f/:formKey  (?embed=1 inside the f.js frame, with v = the t.js visitor cookie and page = the page URL)
 * The hosted form page. The embed and the popup show this same page in a frame, and the form builder
 * shows /f/preview with its unsaved settings, so all of them look the same. Each load counts as a view.
 */
export async function hostedFormHandler(req: Request, res: Response) {
  const formKey = String(req.params.formKey ?? '');
  if (formKey === 'preview') return page(res, 200, 'Form preview', { preview: true, allowedOrigins: PREVIEW_ORIGINS });
  try {
    const form = await loadFormByKey(formKey);
    if (!form) return page(res, 404, 'Form not found', { form: { title: 'Form not found', closed: true } });
    if (form.is_active && !isNonHumanOpen(req.headers['user-agent'])) {
      await dbPool.query(`UPDATE crm_forms SET view_count = view_count + 1 WHERE id = $1`, [form.id]);
    }
    page(res, 200, form.title || form.name, {
      key: form.form_key,
      submitUrl: `/api/public/forms/${form.form_key}/submit`,
      form: {
        title: form.title,
        description: form.description,
        fields: form.fields,
        design: { ...DEFAULT_DESIGN, ...(form.design ?? {}) },
        consentEnabled: form.consent_enabled,
        consentText: form.consent_text,
        captcha: form.captcha_provider && form.captcha_site_key ? { provider: form.captcha_provider, siteKey: form.captcha_site_key } : null,
        closed: !form.is_active,
      },
    });
  } catch (err) {
    console.error('[forms] page failed:', err);
    res.status(500).type('text').send('Something went wrong');
  }
}

/** Submits per minute: per visitor (IP or browser cookie), and per form. */
const MAX_PER_VISITOR_PER_MINUTE = 5;
const MAX_PER_FORM_PER_MINUTE = 30;

/**
 * POST /api/public/forms/:formKey/submit  { fields: { <fieldId>: value }, consent?, captchaToken?, _hp, v?, page? }
 * Sent by the hosted form page (/f/:formKey), which the embed and the popup show in a frame.
 */
export async function submitFormHandler(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const formKey = String(req.params.formKey ?? '');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  if (isNonHumanOpen(req.headers['user-agent'])) return res.status(400).json({ error: 'Submission rejected' });

  const ip = clientIp(req);
  const ipHash = hashIp(ip);
  const visitorKey = typeof body.v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.v) ? body.v : null;
  const visitorOk = allowHit(`form:ip:${ipHash}`, MAX_PER_VISITOR_PER_MINUTE) && (!visitorKey || allowHit(`form:v:${visitorKey}`, MAX_PER_VISITOR_PER_MINUTE));
  if (!visitorOk || !allowHit(`form:f:${formKey}`, MAX_PER_FORM_PER_MINUTE)) {
    return res.status(429).json({ error: 'Too many submissions. Please wait a minute and try again.' });
  }

  try {
    const r = await submitForm(formKey, body, { ip, ipHash, visitorKey, pageUrl: typeof body.page === 'string' ? body.page.slice(0, 2000) : null });
    switch (r.status) {
      case 'not_found':
        return res.status(404).json({ error: 'Form not found' });
      case 'closed':
        return res.status(410).json({ error: 'This form is closed' });
      case 'spam':
        return res.status(400).json({ error: 'Submission rejected' });
      case 'captcha':
        return res.status(400).json({ error: 'Please complete the spam check and try again' });
      case 'invalid':
        return res.status(400).json({ error: 'Please check the highlighted fields', errors: r.errors });
      case 'ok':
        runCrmInBackground(`form ${r.form.id} submission ${r.submissionId}`, () => afterSubmit(r));
        return res.json({ ok: true, message: r.message });
    }
  } catch (err) {
    console.error('[forms] submit failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
