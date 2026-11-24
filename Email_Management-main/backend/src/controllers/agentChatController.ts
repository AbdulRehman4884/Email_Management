/**
 * AI Agent chat history (bug A-17: chats lived only in one browser's localStorage).
 * Mounted at /api with authMiddleware.
 *
 *   GET    /agent-chats[?search=]     the user's chats, newest first (id, sessionId, title, messageCount, updatedAt,
 *                                      pinned, pinnedAt); `search` matches the chat name
 *   GET    /agent-chats/:sessionId    one chat with its messages
 *   PUT    /agent-chats/:sessionId    save a chat { messages, title?, activeCampaignId? } (creates or replaces it)
 *   PATCH  /agent-chats/:sessionId    rename { title } and / or pin { pinned: true | false } (at most MAX_PINNED pinned)
 *   DELETE /agent-chats/:sessionId    delete one chat
 *
 * Retention: no limit on the number of chats. A chat is deleted RETENTION_DAYS (30) days after its last message.
 * A pinned chat is never deleted; once unpinned, its 30 days start again from the unpin time (unpinned_at).
 * Expired chats are really deleted (on every save and every list) — see pruneChats().
 * A renamed chat (title_custom) keeps its name when new messages are saved.
 * Every query is limited to the logged-in user's own rows; another user's chat looks like "not found".
 * Answers 503 until drizzle/0042_agent_chats.sql and 0044_agent_chat_pins_library.sql are applied
 * (scripts/run-agent-chat-migration.ts); the web page then keeps the chat in the browser only, as before.
 */
import type { Request, Response } from 'express';
import { dbPool } from '../lib/db.js';

/** Chats with no message for this many days are deleted (pinned never; an unpinned one counts from the unpin). */
export const RETENTION_DAYS = 30;
/** At most this many pinned chats per user. */
export const MAX_PINNED = 3;
/** Safety cap for one list answer (the sidebar scrolls; search narrows it). */
const LIST_LIMIT = 500;
const TITLE_MAX = 80;
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
/** agent_chats (0042) with the pin / rename columns (0044). */
async function chatTableReady(): Promise<boolean> {
  if (tableReady) return true;
  const r = await dbPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_chats' AND column_name IN ('pinned_at', 'unpinned_at', 'title_custom')`,
  );
  tableReady = r.rows[0]?.n === 3;
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
        throw new HttpError(503, 'Chat history is not set up yet. Run the agent chat migrations first (npx tsx scripts/run-agent-chat-migration.ts).');
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
 * Deletes this user's chats whose last message is older than RETENTION_DAYS. Pinned chats are kept; an unpinned
 * chat counts from the later of its last message and its unpin time. `keepSessionId` (the chat being saved right
 * now) is never deleted. Returns how many rows were deleted.
 */
export async function pruneChats(userId: number, keepSessionId?: string): Promise<number> {
  const old = await dbPool.query(
    `DELETE FROM agent_chats
      WHERE user_id = $1
        AND pinned_at IS NULL
        AND GREATEST(updated_at, COALESCE(unpinned_at, updated_at)) < now() - ($2::int * interval '1 day')
        AND ($3::text IS NULL OR session_id <> $3)`,
    [userId, RETENTION_DAYS, keepSessionId ?? null],
  );
  return old.rowCount ?? 0;
}

/** `search` as a safe ILIKE pattern (its % and _ match themselves). Null when empty. */
export function searchPattern(search: unknown): string | null {
  if (typeof search !== 'string') return null;
  const s = search.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!s) return null;
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const SUMMARY = `id, session_id AS "sessionId", title, message_count AS "messageCount", updated_at AS "updatedAt",
  (pinned_at IS NOT NULL) AS pinned, pinned_at AS "pinnedAt"`;

export const listAgentChats = handle(async (req, res) => {
  const userId = userIdOf(req);
  // A user who has not been here for weeks still loses the expired chats.
  await pruneChats(userId);
  const pattern = searchPattern(req.query?.search);
  const r = await dbPool.query(
    `SELECT ${SUMMARY}
       FROM agent_chats
      WHERE user_id = $1 AND (message_count > 0 OR pinned_at IS NOT NULL)
        AND ($2::text IS NULL OR title ILIKE $2)
      ORDER BY updated_at DESC
      LIMIT $3`,
    [userId, pattern, LIST_LIMIT],
  );
  res.json({ chats: r.rows });
});

/** Rename and / or pin / unpin one chat. */
export const updateAgentChat = handle(async (req, res) => {
  const userId = userIdOf(req);
  const sessionId = sessionIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const hasTitle = body.title !== undefined;
  const hasPin = body.pinned !== undefined;
  if (!hasTitle && !hasPin) throw new HttpError(400, 'Send a new title or pinned: true / false');
  let title: string | null = null;
  if (hasTitle) {
    if (typeof body.title !== 'string') throw new HttpError(400, 'title must be text');
    title = body.title.replace(/\s+/g, ' ').trim();
    if (!title) throw new HttpError(400, 'The chat name cannot be empty');
    if (title.length > TITLE_MAX) throw new HttpError(400, `Keep the chat name under ${TITLE_MAX} characters`);
  }
  if (hasPin && typeof body.pinned !== 'boolean') throw new HttpError(400, 'pinned must be true or false');

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    // One pin / rename at a time per user, so two quick pins cannot pass the limit together.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent_chats_pin:${userId}`]);
    const cur = await client.query<{ pinned: boolean }>(
      `SELECT (pinned_at IS NOT NULL) AS pinned FROM agent_chats WHERE user_id = $1 AND session_id = $2`,
      [userId, sessionId],
    );
    if (!cur.rows[0]) throw new HttpError(404, 'Chat not found');
    if (body.pinned === true && !cur.rows[0].pinned) {
      const n = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_chats WHERE user_id = $1 AND pinned_at IS NOT NULL`,
        [userId],
      );
      if ((n.rows[0]?.n ?? 0) >= MAX_PINNED) throw new HttpError(409, `You can pin up to ${MAX_PINNED} chats. Unpin one first.`);
    }
    const r = await client.query(
      `UPDATE agent_chats
          SET title = COALESCE($3::varchar, title),
              title_custom = title_custom OR $3::varchar IS NOT NULL,
              pinned_at = CASE WHEN $4::boolean IS TRUE THEN COALESCE(pinned_at, now())
                               WHEN $4::boolean IS FALSE THEN NULL
                               ELSE pinned_at END,
              unpinned_at = CASE WHEN $4::boolean IS TRUE THEN NULL
                                 WHEN $4::boolean IS FALSE AND pinned_at IS NOT NULL THEN now()
                                 ELSE unpinned_at END
        WHERE user_id = $1 AND session_id = $2
        RETURNING ${SUMMARY}`,
      [userId, sessionId, title, hasPin ? body.pinned : null],
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
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
       SET title = CASE WHEN agent_chats.title_custom THEN agent_chats.title ELSE EXCLUDED.title END,
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
     RETURNING ${SUMMARY}`,
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
