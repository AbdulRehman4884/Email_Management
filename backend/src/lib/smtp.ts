import nodemailer from 'nodemailer';
import { getSmtpSettings } from './smtpSettings.js';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  fromName?: string;
  fromEmail?: string;
  /** If set, adds List-Unsubscribe header to reduce spam folder placement. */
  listUnsubscribeUrl?: string;
}

function createTransportFromConfig(config: Awaited<ReturnType<typeof getSmtpSettings>>) {
  const isGmail = config.provider === 'gmail' || config.host === 'smtp.gmail.com';
  return nodemailer.createTransport(
    isGmail && config.user
      ? {
          service: 'gmail',
          auth: { user: config.user, pass: config.pass },
        }
      : {
          host: config.host,
          port: config.port,
          secure: config.secure,
          auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
          tls: { rejectUnauthorized: false },
        }
  );
}

/**
 * Send one email via SMTP. Returns messageId on success.
 * Uses DB smtp_settings or process.env; envelope from = fromEmail; campaign from is Reply-To.
 */
export async function sendEmail(options: SendEmailOptions): Promise<string> {
  const config = await getSmtpSettings();
  const envelopeFrom = config.fromEmail || config.user;
  const fromName = options.fromName || config.fromName || 'Campaign';
  const from = fromName ? `${fromName} <${envelopeFrom}>` : envelopeFrom;
  const replyTo = options.fromEmail && options.fromEmail !== envelopeFrom ? options.fromEmail : undefined;

  const transport = createTransportFromConfig(config);
  const headers: Record<string, string> = {};
  if (options.listUnsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${options.listUnsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  try {
    const result = await transport.sendMail({
      from,
      to: options.to,
      replyTo,
      subject: options.subject,
      html: options.html,
      headers: Object.keys(headers).length ? headers : undefined,
    });
    return result.messageId ?? '';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : '';
    const response = err && typeof err === 'object' && 'response' in err ? (err as { response?: string }).response : '';
    console.error('[SMTP] Send failed:', msg, code ? `code=${code}` : '', response ? `response=${response}` : '');
    throw err;
  }
}
