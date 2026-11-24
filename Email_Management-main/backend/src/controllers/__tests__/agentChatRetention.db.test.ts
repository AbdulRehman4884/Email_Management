/**
 * AI Agent chats (retention, pin, rename, search) and Library (150 MB, oldest first) against a real Postgres.
 * Run: AGENT_CHAT_TEST_DATABASE_URL=postgres://.../agent_chat_test npx tsx --test src/controllers/__tests__/agentChatRetention.db.test.ts
 * THROWAWAY database only (needs a `users` table; applies drizzle/0042 + 0044). Skipped without the variable.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DB = process.env.AGENT_CHAT_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set AGENT_CHAT_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const here = path.dirname(fileURLToPath(import.meta.url));
let ctrl: typeof import('../agentChatController.js');
let lib: typeof import('../agentLibraryController.js');
let db: typeof import('../../lib/db.js');
const q = (sql: string, params: unknown[] = []) => db.dbPool.query(sql, params);
let userA = 0;
let userB = 0;

/** A chat that last had a message `daysAgo` days ago. */
async function chat(userId: number, session: string, daysAgo: number, title = `Chat ${session}`) {
  await q(
    `INSERT INTO agent_chats (user_id, session_id, title, messages, message_count, updated_at)
     VALUES ($1, $2, $3, '[{"id":"m1","role":"user","content":"hi","timestamp":"2026-11-01T10:00:00Z"}]'::jsonb, 1,
             now() - ($4::int * interval '1 day'))`,
    [userId, session, title, daysAgo],
  );
}
const sessionsOf = async (userId: number) =>
  (await q(`SELECT session_id FROM agent_chats WHERE user_id = $1 ORDER BY updated_at DESC`, [userId])).rows.map((r: { session_id: string }) => r.session_id);

function fakeRes() {
  const out: { status: number; body: unknown; headers: Record<string, string> } = { status: 200, body: undefined, headers: {} };
  const res = {
    status(n: number) { out.status = n; return res; },
    json(b: unknown) { out.body = b; return res; },
    send(b: unknown) { out.body = b; return res; },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; return res; },
  };
  return { res, out };
}
const call = async (fn: (req: never, res: never) => Promise<unknown>, req: Record<string, unknown>) => {
  const { res, out } = fakeRes();
  await fn({ params: {}, query: {}, body: {}, ...req } as never, res as never);
  return out;
};

before(async () => {
  if (!TEST_DB) return;
  db = await import('../../lib/db.js');
  for (const f of ['0042_agent_chats.sql', '0044_agent_chat_pins_library.sql']) {
    await q(fs.readFileSync(path.join(here, '../../../drizzle', f), 'utf8'));
  }
  ctrl = await import('../agentChatController.js');
  lib = await import('../agentLibraryController.js');
  userA = (await q(`INSERT INTO users (email) VALUES ('a@retention.test') RETURNING id`)).rows[0].id;
  userB = (await q(`INSERT INTO users (email) VALUES ('b@retention.test') RETURNING id`)).rows[0].id;
});
beforeEach(async () => {
  if (!TEST_DB) return;
  await q(`DELETE FROM agent_chats`);
  await q(`DELETE FROM agent_library_files`);
});
after(async () => {
  if (!TEST_DB) return;
  await q(`DELETE FROM agent_chats`);
  await q(`DELETE FROM agent_library_files`);
  await q(`DELETE FROM users WHERE email LIKE '%@retention.test'`);
  await db.dbPool.end();
});

// ── Chats ──────────────────────────────────────────────────────────────────────

test('no limit on the number of chats: 15 chats within 30 days all stay', { skip }, async () => {
  for (let i = 0; i < 15; i++) await chat(userA, `c${i}`, i);
  assert.equal(await ctrl.pruneChats(userA), 0);
  const out = await call(ctrl.listAgentChats, { user: { id: userA } });
  assert.equal((out.body as { chats: unknown[] }).chats.length, 15);
});

test('chats older than 30 days are deleted; 29 days stays; other users untouched', { skip }, async () => {
  await chat(userA, 'old', 31);
  await chat(userA, 'edge', 29);
  await chat(userB, 'b-old', 40);
  assert.equal(await ctrl.pruneChats(userA), 1);
  assert.deepEqual(await sessionsOf(userA), ['edge']);
  assert.deepEqual(await sessionsOf(userB), ['b-old']);
});

test('pinned chats are never deleted; unpinning starts 30 days from the unpin', { skip }, async () => {
  await chat(userA, 'old', 60);
  let out = await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'old' }, body: { pinned: true } });
  assert.equal((out.body as { pinned: boolean }).pinned, true);
  await ctrl.pruneChats(userA);
  assert.deepEqual(await sessionsOf(userA), ['old'], 'pinned: kept although 60 days old');
  out = await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'old' }, body: { pinned: false } });
  assert.equal((out.body as { pinned: boolean }).pinned, false);
  await ctrl.pruneChats(userA);
  assert.deepEqual(await sessionsOf(userA), ['old'], 'just unpinned: 30 days from now');
  await q(`UPDATE agent_chats SET unpinned_at = now() - interval '31 days' WHERE session_id = 'old'`);
  await ctrl.pruneChats(userA);
  assert.deepEqual(await sessionsOf(userA), [], '31 days after the unpin: deleted');
});

test('at most 3 pinned chats; pinning a pinned chat again is fine', { skip }, async () => {
  for (const s of ['p1', 'p2', 'p3', 'p4']) await chat(userA, s, 1);
  for (const s of ['p1', 'p2', 'p3']) {
    assert.equal((await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: s }, body: { pinned: true } })).status, 200);
  }
  assert.equal((await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'p1' }, body: { pinned: true } })).status, 200);
  const fourth = await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'p4' }, body: { pinned: true } });
  assert.equal(fourth.status, 409);
  assert.match((fourth.body as { error: string }).error, /up to 3/);
  // Another user's pins do not count, and another user's chat cannot be changed.
  await chat(userB, 'b1', 1);
  assert.equal((await call(ctrl.updateAgentChat, { user: { id: userB }, params: { sessionId: 'b1' }, body: { pinned: true } })).status, 200);
  assert.equal((await call(ctrl.updateAgentChat, { user: { id: userB }, params: { sessionId: 'p4' }, body: { pinned: true } })).status, 404);
});

test('rename keeps the name when new messages are saved; empty / long names refused', { skip }, async () => {
  await chat(userA, 'r1', 0, 'Show stats');
  const out = await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'r1' }, body: { title: '  Q4   leads  ' } });
  assert.equal((out.body as { title: string }).title, 'Q4 leads');
  await call(ctrl.saveAgentChat, {
    user: { id: userA },
    params: { sessionId: 'r1' },
    body: { messages: [{ id: 'm2', role: 'user', content: 'Something else', timestamp: new Date().toISOString() }] },
  });
  assert.equal((await q(`SELECT title FROM agent_chats WHERE session_id = 'r1'`)).rows[0].title, 'Q4 leads');
  assert.equal((await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'r1' }, body: { title: '   ' } })).status, 400);
  assert.equal((await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'r1' }, body: { title: 'x'.repeat(81) } })).status, 400);
  assert.equal((await call(ctrl.updateAgentChat, { user: { id: userA }, params: { sessionId: 'r1' }, body: {} })).status, 400);
});

test('search by chat name (case-insensitive; % and _ are plain characters)', { skip }, async () => {
  await chat(userA, 's1', 1, 'Check SMTP configuration');
  await chat(userA, 's2', 2, 'Create campaign');
  await chat(userA, 's3', 3, '100% done_list');
  await chat(userB, 'sb', 1, 'Create campaign for B');
  const names = async (search: string) =>
    ((await call(ctrl.listAgentChats, { user: { id: userA }, query: { search } })).body as { chats: Array<{ sessionId: string }> }).chats.map((c) => c.sessionId);
  assert.deepEqual(await names('smtp'), ['s1']);
  assert.deepEqual(await names('CAMPAIGN'), ['s2']);
  assert.deepEqual(await names('%'), ['s3']);
  assert.deepEqual(await names('_'), ['s3']);
  assert.deepEqual((await names('   ')).length, 3);
});

// ── Library ────────────────────────────────────────────────────────────────────

const upload = (userId: number, name: string, bytes: number, sessionId?: string) =>
  call(lib.uploadLibraryFile, {
    user: { id: userId },
    file: { originalname: name, size: bytes, buffer: Buffer.alloc(bytes, 97) },
    body: sessionId ? { sessionId } : {},
  });

test('library: upload, list, download, delete; only the owner sees a file', { skip }, async () => {
  const up = await upload(userA, '../leads list.csv', 1200, 'sess-1');
  assert.equal(up.status, 201);
  const file = (up.body as { file: { id: number; fileName: string; sessionId: string } }).file;
  assert.equal(file.fileName, 'leads list.csv');
  assert.equal(file.sessionId, 'sess-1');
  const list = (await call(lib.listLibraryFiles, { user: { id: userA } })).body as { files: unknown[]; usedBytes: number; limitBytes: number };
  assert.equal(list.files.length, 1);
  assert.equal(list.usedBytes, 1200);
  assert.equal(list.limitBytes, 150 * 1024 * 1024);
  const dl = await call(lib.downloadLibraryFile, { user: { id: userA }, params: { id: String(file.id) } });
  assert.equal((dl.body as Buffer).length, 1200);
  assert.match(dl.headers['content-disposition']!, /attachment; filename="leads list.csv"/);
  assert.equal((await call(lib.downloadLibraryFile, { user: { id: userB }, params: { id: String(file.id) } })).status, 404);
  assert.equal((await call(lib.deleteLibraryFile, { user: { id: userB }, params: { id: String(file.id) } })).status, 404);
  assert.equal((await call(lib.deleteLibraryFile, { user: { id: userA }, params: { id: String(file.id) } })).status, 200);
});

test('library: only CSV / Excel; filters by type and name', { skip }, async () => {
  assert.equal((await upload(userA, 'photo.png', 10)).status, 400);
  await upload(userA, 'a.csv', 10);
  await upload(userA, 'b.xlsx', 10);
  await upload(userA, 'old.xls', 10);
  const names = async (query: Record<string, string>) =>
    ((await call(lib.listLibraryFiles, { user: { id: userA }, query })).body as { files: Array<{ fileName: string }> }).files.map((f) => f.fileName).sort();
  assert.deepEqual(await names({ type: 'csv' }), ['a.csv']);
  assert.deepEqual(await names({ type: 'excel' }), ['b.xlsx', 'old.xls']);
  assert.deepEqual(await names({ search: 'OLD' }), ['old.xls']);
});

test('library: over 150 MB the oldest files are deleted until it fits; the new file stays', { skip }, async () => {
  // A small limit shows the rule without storing 150 MB.
  for (const n of ['f1.csv', 'f2.csv', 'f3.csv']) {
    await upload(userA, n, 400);
    await q(`UPDATE agent_library_files SET created_at = created_at - interval '1 minute'`); // keep the order clear
  }
  await upload(userB, 'other.csv', 400);
  assert.deepEqual(await lib.enforceLibraryLimit(userA, 1000), ['f1.csv']);
  const left = (await q(`SELECT file_name FROM agent_library_files WHERE user_id = $1 ORDER BY created_at`, [userA])).rows.map((r: { file_name: string }) => r.file_name);
  assert.deepEqual(left, ['f2.csv', 'f3.csv']);
  assert.equal((await q(`SELECT count(*)::int AS n FROM agent_library_files WHERE user_id = $1`, [userB])).rows[0].n, 1);
  // The real limit: an upload under 150 MB removes nothing.
  assert.deepEqual(((await upload(userA, 'f4.csv', 400)).body as { removed: string[] }).removed, []);
});
