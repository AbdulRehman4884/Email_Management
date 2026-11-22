/**
 * AI Agent chat retention: a user keeps at most 10 chats and none older than 30 days.
 * Run: AGENT_CHAT_TEST_DATABASE_URL=postgres://.../agent_chat_test npx tsx --test src/controllers/__tests__/agentChatRetention.db.test.ts
 * THROWAWAY database only (needs a `users` table and drizzle/0042_agent_chats.sql). Skipped without the variable.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.AGENT_CHAT_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set AGENT_CHAT_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

let ctrl: typeof import('../agentChatController.js');
let db: typeof import('../../lib/db.js');
const q = (sql: string, params: unknown[] = []) => db.dbPool.query(sql, params);
let userA = 0;
let userB = 0;

/** A chat that last had a message `daysAgo` days ago. */
async function chat(userId: number, session: string, daysAgo: number, hoursAgo = 0) {
  await q(
    `INSERT INTO agent_chats (user_id, session_id, title, messages, message_count, updated_at)
     VALUES ($1, $2, $3, '[{"id":"m1","role":"user","content":"hi","timestamp":"2026-11-01T10:00:00Z"}]'::jsonb, 1,
             now() - ($4::int * interval '1 day') - ($5::int * interval '1 hour'))`,
    [userId, session, `Chat ${session}`, daysAgo, hoursAgo],
  );
}
const sessionsOf = async (userId: number) =>
  (await q(`SELECT session_id FROM agent_chats WHERE user_id = $1 ORDER BY updated_at DESC`, [userId])).rows.map((r: { session_id: string }) => r.session_id);

function fakeRes() {
  const out: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(n: number) { out.status = n; return res; },
    json(b: unknown) { out.body = b; return res; },
  };
  return { res, out };
}

before(async () => {
  if (!TEST_DB) return;
  db = await import('../../lib/db.js');
  ctrl = await import('../agentChatController.js');
  userA = (await q(`INSERT INTO users (email) VALUES ('a@retention.test') RETURNING id`)).rows[0].id;
  userB = (await q(`INSERT INTO users (email) VALUES ('b@retention.test') RETURNING id`)).rows[0].id;
});
beforeEach(async () => {
  if (TEST_DB) await q(`DELETE FROM agent_chats`);
});
after(async () => {
  if (!TEST_DB) return;
  await q(`DELETE FROM agent_chats`);
  await q(`DELETE FROM users WHERE email LIKE '%@retention.test'`);
  await db.dbPool.end();
});

test('chats older than 30 days are deleted; 29 days stays', { skip }, async () => {
  await chat(userA, 'old', 31);
  await chat(userA, 'edge', 29);
  await chat(userA, 'fresh', 0);
  const n = await ctrl.pruneChats(userA);
  assert.equal(n, 1);
  assert.deepEqual((await sessionsOf(userA)).sort(), ['edge', 'fresh']);
});

test('only the newest 10 stay (11th and 12th oldest are deleted)', { skip }, async () => {
  for (let i = 0; i < 12; i++) await chat(userA, `c${i}`, i); // c0 newest … c11 oldest (all within 30 days)
  await ctrl.pruneChats(userA);
  const left = await sessionsOf(userA);
  assert.equal(left.length, 10);
  assert.deepEqual(left, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
});

test('the chat being saved is never deleted and counts as one of the 10', { skip }, async () => {
  for (let i = 0; i < 10; i++) await chat(userA, `c${i}`, i + 1);
  await chat(userA, 'mine', 25); // old but within 30 days; saved right now
  await ctrl.pruneChats(userA, 'mine');
  const left = await sessionsOf(userA);
  assert.equal(left.length, 10);
  assert.ok(left.includes('mine'));
  assert.ok(!left.includes('c9'), 'the oldest of the others goes');
});

test("another user's chats are never touched", { skip }, async () => {
  for (let i = 0; i < 12; i++) await chat(userA, `a${i}`, i);
  await chat(userB, 'b-old', 40);
  await chat(userB, 'b-new', 0);
  await ctrl.pruneChats(userA);
  assert.deepEqual((await sessionsOf(userB)).sort(), ['b-new', 'b-old']);
});

test('GET /agent-chats prunes first and returns at most 10, newest first', { skip }, async () => {
  for (let i = 0; i < 12; i++) await chat(userA, `c${i}`, i);
  await chat(userA, 'expired', 45);
  const { res, out } = fakeRes();
  await ctrl.listAgentChats({ user: { id: userA }, params: {}, query: {} } as never, res as never);
  const chats = (out.body as { chats: Array<{ sessionId: string }> }).chats;
  assert.equal(out.status, 200);
  assert.equal(chats.length, 10);
  assert.equal(chats[0]!.sessionId, 'c0');
  assert.ok(!chats.some((c) => c.sessionId === 'expired'));
  assert.equal((await sessionsOf(userA)).length, 10, 'the extra rows are really gone from the database');
});

test('PUT save of an 11th chat keeps the new one and drops the oldest', { skip }, async () => {
  for (let i = 0; i < 10; i++) await chat(userA, `c${i}`, i + 1);
  const { res, out } = fakeRes();
  await ctrl.saveAgentChat(
    { user: { id: userA }, params: { sessionId: 'brand-new' }, body: { messages: [{ role: 'user', content: 'Show stats', timestamp: new Date().toISOString() }] } } as never,
    res as never,
  );
  assert.equal(out.status, 200);
  const left = await sessionsOf(userA);
  assert.equal(left.length, 10);
  assert.equal(left[0], 'brand-new');
  assert.ok(!left.includes('c9'));
});
