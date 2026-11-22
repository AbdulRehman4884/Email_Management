/**
 * AI Agent chat history (bug A-17: chats lived only in one browser's localStorage).
 * Mounted at /api with authMiddleware.
 *
 *   GET    /agent-chats               the user's chats (at most 10), newest first (id, sessionId, title, messageCount, updatedAt)
 *   GET    /agent-chats/:sessionId    one chat with its messages
 *   PUT    /agent-chats/:sessionId    save a chat { messages, title?, activeCampaignId? } (creates or replaces it)
 *   DELETE /agent-chats/:sessionId    delete one chat
 *
 * Retention: a user keeps at most MAX_CHATS_KEPT (10) chats and none older than RETENTION_DAYS (30) days since the
 * last message. Older / extra chats are really deleted (on every save and every list) — see pruneChats().
 * Every query is limited to the logged-in user's own rows; another user's chat looks like "not found".
 * Answers 503 until drizzle/0042_agent_chats.sql is applied (scripts/run-agent-chat-migration.ts);
 * the web page then keeps the chat in the browser only, as before.
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';

/** A user keeps at most this many chats; the oldest (by last message) are deleted. */
export const MAX_CHATS_KEPT = 10;
/** Chats with no message for this many days are deleted. */
export const RETENTION_DAYS = 30;
const MAX_MESSAGES = 300;
const MAX_CONTENT_CHARS = 100_000;
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const ROLES = new Set(['user', 'assistant', 'error']);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let tableReady = false;
async function chatTableReady(): Promise<boolean> {
  if (tableReady) return true;
  const r = await dbPool.query<{ t: string | null }>(`SELECT to_regclass('public.agent_chats')::text AS t`);
  tableReady = !!r.rows[0]?.t;
  return tableReady;
}

function userIdOf(req: Request): number {
  const id = req.user?.id;
  if (!id) throw new HttpError(401, 'Unauthorized');
  return id;
}

function sessionIdOf(req: Request): string {
  const s = String(req.params.sessionId ?? '');
  if (!SESSION_ID_RE.test(s)) throw new HttpError(400, 'Invalid chat id');
  return s;
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      if (!(await chatTableReady())) {
        throw new HttpError(503, 'Chat history is not set up yet. Run the agent chat migration first (npx tsx scripts/run-agent-chat-migration.ts).');
      }
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error('[agent chats]', err);
      res.status(500).json({ error: 'Something went wrong' });
    }
  };
}

type StoredMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: string;
  structured?: unknown;
  navigatePath?: string;
};

/** Keeps only well-formed messages (the newest MAX_MESSAGES). */
export function cleanMessages(raw: unknown): StoredMessage[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'messages must be a list');
  const out: StoredMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (typeof r.role !== 'string' || !ROLES.has(r.role) || typeof r.content !== 'string') continue;
    const ts = typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp)) ? r.timestamp : new Date().toISOString();
    out.push({
      id: typeof r.id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(r.id)
        ? r.id
        : `${r.role}-${ts}-${out.length}`,
      role: r.role as StoredMessage['role'],
      content: r.content.slice(0, MAX_CONTENT_CHARS),
      timestamp: ts,
      ...(r.structured && typeof r.structured === 'object' ? { structured: r.structured } : {}),
      ...(typeof r.navigatePath === 'string' && r.navigatePath.startsWith('/') ? { navigatePath: r.navigatePath.slice(0, 200) } : {}),
    });
  }
  return out.slice(-MAX_MESSAGES);
}

/** The chat's title: the one sent, else the first thing the user asked. */
export function chatTitle(title: unknown, messages: StoredMessage[]): string {
  const given = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  const firstAsk = messages.find((m) => m.role === 'user')?.content.replace(/\s+/g, ' ').trim() ?? '';
  const t = given || firstAsk || 'New chat';
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

/**
 * Deletes this user's chats that are older than RETENTION_DAYS, then everything beyond the newest MAX_CHATS_KEPT.
 * `keepSessionId` (the chat being saved right now) is never deleted. Returns how many rows were deleted.
 */
export async function pruneChats(userId: number, keepSessionId?: string): Promise<number> {
  const old = await dbPool.query(
    `DELETE FROM agent_chats
      WHERE user_id = $1
        AND updated_at < now() - ($2::int * interval '1 day')
        AND ($3::text IS NULL OR session_id <> $3)`,
    [userId, RETENTION_DAYS, keepSessionId ?? null],
  );
  // The protected chat counts as one of the kept chats.
  const keepOthers = keepSessionId ? MAX_CHATS_KEPT - 1 : MAX_CHATS_KEPT;
  const extra = await dbPool.query(
    `DELETE FROM agent_chats
      WHERE user_id = $1
        AND id IN (
          SELECT id FROM agent_chats
           WHERE user_id = $1 AND ($3::text IS NULL OR session_id <> $3)
           ORDER BY updated_at DESC
          OFFSET $2
        )`,
    [userId, keepOthers, keepSessionId ?? null],
  );
  return (old.rowCount ?? 0) + (extra.rowCount ?? 0);
}

export const listAgentChats = handle(async (req, res) => {
  const userId = userIdOf(req);
  // A user who has not been here for weeks still loses the expired chats.
  await pruneChats(userId);
  const r = await dbPool.query(
    `SELECT id, session_id AS "sessionId", title, message_count AS "messageCount", updated_at AS "updatedAt"
       FROM agent_chats
      WHERE user_id = $1 AND message_count > 0
      ORDER BY updated_at DESC
      LIMIT $2`,
    [userId, MAX_CHATS_KEPT],
  );
  res.json({ chats: r.rows });
});

export const getAgentChat = handle(async (req, res) => {
  const userId = userIdOf(req);
  const sessionId = sessionIdOf(req);
  const r = await dbPool.query(
    `SELECT session_id AS "sessionId", title, messages, active_campaign_id AS "activeCampaignId", updated_at AS "updatedAt"
       FROM agent_chats WHERE user_id = $1 AND session_id = $2`,
    [userId, sessionId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Chat not found');
  res.json(r.rows[0]);
});

export const saveAgentChat = handle(async (req, res) => {
  const userId = userIdOf(req);
  const sessionId = sessionIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const messages = cleanMessages(body.messages);
  const title = chatTitle(body.title, messages);
  const campaign = typeof body.activeCampaignId === 'string' && /^[0-9]{1,20}$/.test(body.activeCampaignId) ? body.activeCampaignId : null;
  const r = await dbPool.query(
    `INSERT INTO agent_chats (user_id, session_id, title, messages, message_count, active_campaign_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (user_id, session_id) DO UPDATE
       SET title = EXCLUDED.title,
           messages = (
             SELECT COALESCE(jsonb_agg(latest.message ORDER BY latest.message->>'timestamp', latest.position), '[]'::jsonb)
               FROM (
                 SELECT * FROM (
                   SELECT DISTINCT ON (item.message->>'id') item.message, item.position
                     FROM jsonb_array_elements(agent_chats.messages || EXCLUDED.messages)
                          WITH ORDINALITY AS item(message, position)
                    ORDER BY item.message->>'id', item.position DESC
                 ) AS deduped
                 ORDER BY deduped.message->>'timestamp' DESC, deduped.position DESC
                 LIMIT 300
               ) AS latest
           ),
           message_count = jsonb_array_length((
             SELECT COALESCE(jsonb_agg(latest.message ORDER BY latest.message->>'timestamp', latest.position), '[]'::jsonb)
               FROM (
                 SELECT * FROM (
                   SELECT DISTINCT ON (item.message->>'id') item.message, item.position
                     FROM jsonb_array_elements(agent_chats.messages || EXCLUDED.messages)
                          WITH ORDINALITY AS item(message, position)
                    ORDER BY item.message->>'id', item.position DESC
                 ) AS deduped
                 ORDER BY deduped.message->>'timestamp' DESC, deduped.position DESC
                 LIMIT 300
               ) AS latest
           )),
           active_campaign_id = EXCLUDED.active_campaign_id, updated_at = now()
     RETURNING id, session_id AS "sessionId", title, message_count AS "messageCount", updated_at AS "updatedAt"`,
    [userId, sessionId, title, JSON.stringify(messages), messages.length, campaign],
  );
  await pruneChats(userId, sessionId);
  res.json(r.rows[0]);
});

export const deleteAgentChat = handle(async (req, res) => {
  const userId = userIdOf(req);
  const sessionId = sessionIdOf(req);
  const r = await dbPool.query(`DELETE FROM agent_chats WHERE user_id = $1 AND session_id = $2`, [userId, sessionId]);
  if (!r.rowCount) throw new HttpError(404, 'Chat not found');
  res.json({ deleted: true });
});
