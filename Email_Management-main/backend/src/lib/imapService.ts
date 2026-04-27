import Imap from 'imap';
import { simpleParser, type ParsedMail } from 'mailparser';
import { db } from './db.js';
import { smtpSettingsTable, recipientTable, statsTable } from '../db/schema.js';
import { normalizeMessageId } from './messageId.js';
import { eq } from 'drizzle-orm';
import { persistInboundEmailReply, resolveReplyTargetFromRefIds } from './replyThreading.js';

export interface ImapConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  userId: number;
}

const SENDING_ONLY_PROVIDERS = ['sendgrid', 'amazon_ses'];

export function deriveImapConfig(row: {
  userId: number;
  provider: string;
  host: string;
  user: string;
  password: string;
}): ImapConfig | null {
  const provider = row.provider?.toLowerCase() ?? '';
  const smtpHost = row.host?.toLowerCase() ?? '';

  if (SENDING_ONLY_PROVIDERS.includes(provider)) return null;
  if (smtpHost.includes('sendgrid') || smtpHost.includes('amazonaws.com')) return null;
  if (!row.user || !row.password) return null;

  let imapHost: string;

  if (provider === 'gmail' || smtpHost === 'smtp.gmail.com') {
    imapHost = 'imap.gmail.com';
  } else if (provider === 'hostinger' || smtpHost === 'smtp.hostinger.com') {
    imapHost = 'imap.hostinger.com';
  } else if (smtpHost.startsWith('smtp.')) {
    imapHost = smtpHost.replace(/^smtp\./, 'imap.');
  } else {
    return null;
  }

  return {
    host: imapHost,
    port: 993,
    tls: true,
    user: row.user,
    password: row.password,
    userId: row.userId,
  };
}

export async function getAllImapConfigs(): Promise<ImapConfig[]> {
  const rows = await db.select().from(smtpSettingsTable);
  const configs: ImapConfig[] = [];
  for (const row of rows) {
    const cfg = deriveImapConfig(row);
    if (cfg) configs.push(cfg);
  }
  return configs;
}

function connectImap(config: ImapConfig): Promise<Imap> {
  return new Promise((resolve, reject) => {
    const conn = new Imap({
      user: config.user,
      password: config.password,
      host: config.host,
      port: config.port,
      tls: config.tls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    conn.once('ready', () => resolve(conn));
    conn.once('error', (err: Error) => reject(err));
    conn.connect();
  });
}

function openInbox(conn: Imap): Promise<Imap.Box> {
  return new Promise((resolve, reject) => {
    conn.openBox('INBOX', false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function searchUnseen(conn: Imap): Promise<number[]> {
  return new Promise((resolve, reject) => {
    conn.search(['UNSEEN'], (err, uids) => {
      if (err) reject(err);
      else resolve(uids || []);
    });
  });
}

function parseMessage(stream: NodeJS.ReadableStream): Promise<ParsedMail> {
  return simpleParser(stream) as Promise<ParsedMail>;
}

function addFlags(conn: Imap, uid: number, flags: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.addFlags(uid, flags, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function toSingleString(val: string | string[] | undefined): string | undefined {
  if (val == null) return undefined;
  const s = Array.isArray(val) ? val[0] : val;
  return typeof s === 'string' ? s : undefined;
}

function extractMessageIds(parsed: ParsedMail): string[] {
  const ids: string[] = [];

  const inReplyTo = parsed.inReplyTo;
  if (inReplyTo) {
    const arr = Array.isArray(inReplyTo) ? inReplyTo : [inReplyTo];
    for (const s of arr) {
      const normalized = typeof s === 'string' ? normalizeMessageId(s) : null;
      if (normalized && !ids.includes(normalized)) ids.push(normalized);
    }
  }

  const references = parsed.references;
  if (references) {
    const refs = Array.isArray(references) ? references : [references];
    for (const ref of refs) {
      const s = typeof ref === 'string' ? ref : undefined;
      const normalized = s ? normalizeMessageId(s) : null;
      if (normalized && !ids.includes(normalized)) ids.push(normalized);
    }
  }

  return ids;
}

async function saveReply(
  target: NonNullable<Awaited<ReturnType<typeof resolveReplyTargetFromRefIds>>>,
  parsed: ParsedMail
): Promise<void> {
  const fromAddress =
    parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? 'unknown';

  const bodyText = parsed.text ?? null;
  const bodyHtml = parsed.html || null;
  const msgId = normalizeMessageId(parsed.messageId ?? null);
  const inReplyToRaw = toSingleString(parsed.inReplyTo as string | string[] | undefined);
  const inReplyTo = normalizeMessageId(inReplyToRaw ?? null);

  await persistInboundEmailReply({
    campaignId: target.campaignId,
    recipientId: target.recipientId,
    fromEmail: fromAddress,
    subject: parsed.subject || '(no subject)',
    bodyText: bodyText ? bodyText.slice(0, 10000) : null,
    bodyHtml: bodyHtml ? bodyHtml.slice(0, 20000) : null,
    messageId: msgId,
    inReplyTo,
    parentEmailReply: target.parentEmailReply,
  });

  const [recipient] = await db
    .select({ repliedAt: recipientTable.repliedAt })
    .from(recipientTable)
    .where(eq(recipientTable.id, target.recipientId))
    .limit(1);

  if (recipient && recipient.repliedAt == null) {
    await db
      .update(recipientTable)
      .set({ repliedAt: new Date() })
      .where(eq(recipientTable.id, target.recipientId));

    const [stat] = await db
      .select()
      .from(statsTable)
      .where(eq(statsTable.campaignId, target.campaignId))
      .limit(1);

    if (stat) {
      await db
        .update(statsTable)
        .set({ repliedCount: Number(stat.repliedCount) + 1 })
        .where(eq(statsTable.campaignId, target.campaignId));
    }
  }
}

export async function pollImapForUser(config: ImapConfig): Promise<number> {
  let conn: Imap | null = null;
  let processed = 0;

  try {
    conn = await connectImap(config);
    await openInbox(conn);
    const uids = await searchUnseen(conn);

    if (uids.length === 0) {
      conn.end();
      return 0;
    }

    const fetcher = conn.fetch(uids, { bodies: '', struct: true });

    const messagePromises: Promise<void>[] = [];

    await new Promise<void>((resolve, reject) => {
      fetcher.on('message', (msg, seqno) => {
        const promise = new Promise<void>((msgResolve) => {
          msg.on('body', (stream) => {
            parseMessage(stream)
              .then(async (parsed) => {
                const refIds = extractMessageIds(parsed);
                if (refIds.length === 0) {
                  console.log('[IMAP] No In-Reply-To/References in message; skipping.');
                  msgResolve();
                  return;
                }

                const target = await resolveReplyTargetFromRefIds(refIds);
                if (!target) {
                  console.log('[IMAP] No recipient match for refIds:', refIds.slice(0, 3));
                  msgResolve();
                  return;
                }

                await saveReply(target, parsed);
                processed++;
                console.log('[IMAP] Reply saved for campaign', target.campaignId, 'from', parsed.from?.value?.[0]?.address ?? parsed.from?.text);
                msgResolve();
              })
              .catch((err) => {
                console.error('[IMAP] Parse error:', err);
                msgResolve();
              });
          });
        });

        msg.once('attributes', (attrs) => {
          if (attrs.uid) {
            promise.then(() => {
              if (conn) {
                return addFlags(conn, attrs.uid, ['\\Seen']).catch((err) => {
                  console.error('[IMAP] Flag error:', err);
                });
              }
            });
          }
        });

        messagePromises.push(promise);
      });

      fetcher.once('error', (err) => reject(err));
      fetcher.once('end', () => resolve());
    });

    await Promise.all(messagePromises);
    conn.end();
  } catch (err) {
    console.error(`[IMAP] Error polling for user ${config.user}:`, err);
    if (conn) {
      try { conn.end(); } catch {}
    }
  }

  return processed;
}
