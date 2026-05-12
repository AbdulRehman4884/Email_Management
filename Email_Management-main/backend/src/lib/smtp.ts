import nodemailer from 'nodemailer';
import type Transporter from 'nodemailer/lib/mailer';
import { getSmtpSettings } from './smtpSettings.js';
import { htmlToPlainText } from './outreachQuality.js';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromEmail?: string;
  replyToEmail?: string;
  /** If set, adds List-Unsubscribe header to reduce spam folder placement. */
  listUnsubscribeUrl?: string;
  /** User ID for SMTP settings (required when using per-user SMTP). */
  userId?: number;
  /** Optional Message-ID threading headers for reply emails. */
  inReplyTo?: string;
  references?: string;
}

export interface MailPayload {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

// ── Transport pool: reuse SMTP connections per user ──

const TRANSPORT_IDLE_TTL_MS = 10 * 60 * 1000; // close after 10 min idle

interface PooledTransport {
  transport: Transporter;
  lastUsed: number;
  configHash: string;
}

const transportPool = new Map<number, PooledTransport>();

function configHash(cfg: Awaited<ReturnType<typeof getSmtpSettings>>): string {
  return `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.secure}:${cfg.provider ?? ''}`;
}

function createTransportFromConfig(config: Awaited<ReturnType<typeof getSmtpSettings>>) {
  const isGmail = config.provider === 'gmail' || config.host === 'smtp.gmail.com';
  return nodemailer.createTransport(
    isGmail && config.user
      ? {
          service: 'gmail',
          pool: true,
          maxConnections: 5,
          auth: { user: config.user, pass: config.pass },
        }
      : {
          host: config.host,
          port: config.port,
          secure: config.secure,
          pool: true,
          maxConnections: 5,
          auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
          tls: { rejectUnauthorized: false },
        }
  );
}

export async function getOrCreateTransport(userId: number) {
  const config = await getSmtpSettings(userId);
  const hash = configHash(config);
  const existing = transportPool.get(userId);

  if (existing && existing.configHash === hash) {
    existing.lastUsed = Date.now();
    return { transport: existing.transport, config };
  }

  if (existing) {
    existing.transport.close();
    transportPool.delete(userId);
  }

  const transport = createTransportFromConfig(config);
  transportPool.set(userId, { transport, lastUsed: Date.now(), configHash: hash });
  return { transport, config };
}

export function buildMailPayload(
  options: Pick<
    SendEmailOptions,
    "to" | "subject" | "html" | "text" | "fromName" | "fromEmail" | "replyToEmail" | "listUnsubscribeUrl" | "inReplyTo" | "references"
  >,
  config: Awaited<ReturnType<typeof getSmtpSettings>>,
): MailPayload {
  const envelopeFrom = config.fromEmail || config.user;
  const fromName = options.fromName || config.fromName || 'Campaign';
  const from = fromName ? `${fromName} <${envelopeFrom}>` : envelopeFrom;
  const replyTo =
    options.replyToEmail?.trim() ||
    config.replyToEmail?.trim() ||
    options.fromEmail?.trim() ||
    envelopeFrom;
  const text = options.text?.trim() || htmlToPlainText(options.html);

  const headers: Record<string, string> = {};
  if (options.listUnsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${options.listUnsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  if (options.inReplyTo) headers['In-Reply-To'] = options.inReplyTo;
  if (options.references) headers['References'] = options.references;

  return {
    from,
    to: options.to,
    replyTo,
    subject: options.subject,
    html: options.html,
    text,
    headers: Object.keys(headers).length ? headers : undefined,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of transportPool) {
    if (now - entry.lastUsed > TRANSPORT_IDLE_TTL_MS) {
      entry.transport.close();
      transportPool.delete(userId);
    }
  }
}, 60_000).unref();

/**
 * Send one email via SMTP. Returns messageId on success.
 * Uses a pooled transport per user for connection reuse.
 */
export async function sendEmail(options: SendEmailOptions): Promise<string> {
  if (options.userId == null) {
    throw new Error('sendEmail requires userId for per-user SMTP');
  }
  const { transport, config } = await getOrCreateTransport(options.userId);
  const payload = buildMailPayload(options, config);
  try {
    const result = await transport.sendMail(payload);
    return result.messageId ?? '';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : '';
    const responseCode =
      err && typeof err === 'object' && 'responseCode' in err ? (err as { responseCode?: number }).responseCode : undefined;
    const response = err && typeof err === 'object' && 'response' in err ? (err as { response?: string }).response : '';
    let smtpCtx = '';
    try {
      const { config } = await getOrCreateTransport(options.userId!);
      smtpCtx = `host=${config.host} port=${config.port} smtpUser=${config.user}`;
    } catch {
      smtpCtx = 'host=(unavailable)';
    }
    console.error(
      '[SMTP] Send failed:',
      smtpCtx,
      code ? `errCode=${code}` : '',
      responseCode != null ? `responseCode=${responseCode}` : '',
      `message=${msg}`,
      response ? `response=${String(response).slice(0, 300)}` : '',
    );
    throw err;
  }
}

export interface SendEmailViaEnvOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromEmail?: string;
}

function createTransportFromEnv() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT) || 587;
  const smtpSecure = process.env.SMTP_SECURE === 'true';
  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || '';
  if (!smtpHost) {
    throw new Error('SMTP_HOST is not set in environment');
  }

  const isGmail = smtpHost === 'smtp.gmail.com' || process.env.SMTP_PROVIDER === 'gmail';

  return nodemailer.createTransport(
    isGmail && smtpUser
      ? {
          service: 'gmail',
          auth: { user: smtpUser, pass: smtpPass },
        }
      : {
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
          tls: { rejectUnauthorized: false },
        }
  );
}

/**
 * Send one email using backend ENV SMTP settings only.
 * Used for system emails like forgot-password OTP.
 */
export async function sendEmailViaEnv(options: SendEmailViaEnvOptions): Promise<string> {
  const transport = createTransportFromEnv();
  const smtpFromEmail = options.fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER || '';
  const smtpFromName = options.fromName || '';
  const from = smtpFromName ? `${smtpFromName} <${smtpFromEmail}>` : smtpFromEmail;
  const text = options.text?.trim() || htmlToPlainText(options.html);

  try {
    const result = await transport.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text,
    });
    return result.messageId ?? '';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : '';
    const response = err && typeof err === 'object' && 'response' in err ? (err as { response?: string }).response : '';
    console.error('[SMTP/ENV] Send failed:', msg, code ? `code=${code}` : '', response ? `response=${response}` : '');
    throw err;
  }
}
