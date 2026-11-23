/**
 * AI reply agent + AI first lines against a real Postgres. THROWAWAY database only; the AI is a stub and the
 * database has no SMTP settings, so no email can ever be sent.
 * Run: AI_FEATURES_TEST_DATABASE_URL=postgres://.../agent_chat_test npx tsx --test src/lib/aiReply/__tests__/agent.db.test.ts
 * Skipped without the variable. Needs a `users` table; creates minimal campaign/reply tables + migration 0043.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DB = process.env.AI_FEATURES_TEST_DATABASE_URL;
const skip = !TEST_DB ? 'set AI_FEATURES_TEST_DATABASE_URL to a throwaway database' : false;
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  process.env.AI_LABELING_BASE_URL = 'http://ai.stub.invalid/v1';
}

const here = path.dirname(fileURLToPath(import.meta.url));
let agent: typeof import('../agent.js');
let firstLines: typeof import('../../firstLines/job.js');
let db: typeof import('../../db.js');
const q = (sql: string, params: unknown[] = []) => db.dbPool.query(sql, params);

// ── AI stub: every call is recorded; the answer is a usable email ──
const aiCalls: string[] = [];
const realFetch = globalThis.fetch;
const WITH_LINK = 'Hi Ali,\n\nThanks for coming back to me. Happy to walk you through it on a quick call: https://cal.com/sara/15\n\nBest regards,\nSara';
function stubAi(body = 'Hi Ali,\n\nThanks for coming back to me. Would a quick 15-minute call this week work? Tell me a time.\n\nBest regards,\nSara') {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    aiCalls.push(String(init?.body ?? ''));
    assert.match(String(url), /ai\.stub\.invalid/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ body }) } }] }), { status: 200 });
  }) as typeof fetch;
}

let userId = 0;
let campaignId = 0;
let recipientId = 0;

async function inbound(label: string, text: string): Promise<number> {
  const r = await q(
    `INSERT INTO email_replies (campaign_id, recipient_id, from_email, subject, body_text, direction, label)
     VALUES ($1, $2, 'ali@brightdental.co.uk', 'Re: Websites', $3, 'inbound', $4) RETURNING id`,
    [campaignId, recipientId, text, label],
  );
  const id = r.rows[0].id as number;
  await q(`UPDATE email_replies SET thread_root_id = $1 WHERE id = $1`, [id]);
  return id;
}
const drafts = async () => (await q(`SELECT reply_id, status, objection, note, body FROM ai_reply_drafts ORDER BY id`)).rows;

before(async () => {
  if (!TEST_DB) return;
  db = await import('../../db.js');
  await q(`CREATE TABLE IF NOT EXISTS campaigns (id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status varchar(50) DEFAULT 'draft' NOT NULL, subject varchar(255) NOT NULL, email_content text NOT NULL, from_name varchar(100) NOT NULL,
    from_email varchar(255) NOT NULL, smtp_settings_id integer, available_columns varchar(2000))`);
  await q(`CREATE TABLE IF NOT EXISTS recipients (id serial PRIMARY KEY, campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    email varchar(255) NOT NULL, status varchar(50) DEFAULT 'pending' NOT NULL, name varchar(100), custom_fields varchar(5000), message_id varchar(255))`);
  await q(`CREATE TABLE IF NOT EXISTS email_replies (id serial PRIMARY KEY, campaign_id integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    recipient_id integer NOT NULL REFERENCES recipients(id) ON DELETE CASCADE, from_email varchar(255) NOT NULL, subject varchar(500) NOT NULL,
    body_text varchar(10000), body_html varchar(20000), received_at timestamp DEFAULT now() NOT NULL, message_id varchar(500),
    direction varchar(20) DEFAULT 'inbound' NOT NULL, thread_root_id integer, label varchar(30))`);
  await q(`CREATE TABLE IF NOT EXISTS suppression_list (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE, reason varchar(500) NOT NULL)`);
  await q(fs.readFileSync(path.join(here, '../../../../drizzle/0043_ai_reply_agent.sql'), 'utf8'));
  agent = await import('../agent.js');
  firstLines = await import('../../firstLines/job.js');
  userId = (await q(`INSERT INTO users (email) VALUES ('owner@aifeatures.test') RETURNING id`)).rows[0].id;
  campaignId = (await q(
    `INSERT INTO campaigns (user_id, subject, email_content, from_name, from_email) VALUES ($1, 'Websites', '<p>Hi {first_name},</p><p>{first_line}</p><p>We build websites for dentists.</p>', 'Sara', 'sara@agency.test') RETURNING id`,
    [userId],
  )).rows[0].id;
  recipientId = (await q(
    `INSERT INTO recipients (campaign_id, email, name, custom_fields, status) VALUES ($1, 'ali@brightdental.co.uk', 'Ali Khan', '{"company":"BrightDental"}', 'sent') RETURNING id`,
    [campaignId],
  )).rows[0].id;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  aiCalls.length = 0;
  stubAi();
  await q(`DELETE FROM ai_reply_drafts`);
  await q(`DELETE FROM ai_reply_settings`);
  await q(`DELETE FROM email_replies`);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (!TEST_DB) return;
  await q(`DELETE FROM users WHERE email = 'owner@aifeatures.test'`);
  await db.dbPool.end();
});

test('agent OFF (default): a new reply gets no AI call and no draft', { skip }, async () => {
  const id = await inbound('interested', 'Yes, interested!');
  assert.equal(await agent.onReplyLabeled(id), null);
  assert.equal(aiCalls.length, 0);
  assert.deepEqual(await drafts(), []);
});

test('approve mode: the AI writes a draft that waits; the price objection is passed to the AI', { skip }, async () => {
  await agent.saveAiReplySettings(userId, { mode: 'approve', offer: 'Websites for dentists', meetingLink: 'https://cal.com/sara/15' });
  stubAi(WITH_LINK);
  const id = await inbound('interested', 'Looks good but it is too expensive for us right now.');
  const d = await agent.onReplyLabeled(id);
  assert.equal(d?.status, 'pending');
  assert.match(d!.body, /cal\.com\/sara\/15/);
  assert.equal(d?.objection, 'price');
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0]!, /worries about price/);
  assert.match(aiCalls[0]!, /too expensive/);
  const open = await agent.openDraftForThread(userId, id);
  assert.equal(open?.id, d?.id);
  assert.equal(typeof open?.createdAt, 'string');
});

test('out of office / meeting booked / labels not chosen: no draft', { skip }, async () => {
  await agent.saveAiReplySettings(userId, { mode: 'auto', offer: 'x' });
  for (const label of ['out_of_office', 'meeting_booked', 'bounce_unsubscribe', 'not_interested']) {
    assert.equal(await agent.onReplyLabeled(await inbound(label, 'Auto text')), null, label);
  }
  assert.equal(aiCalls.length, 0);
});

test('auto mode: scheduled; if you answer before the delay ends it is skipped, never sent', { skip }, async () => {
  await agent.saveAiReplySettings(userId, { mode: 'auto', offer: 'x', delayMinutes: 0 });
  const id = await inbound('question', 'How long does a website take?');
  const d = await agent.onReplyLabeled(id);
  assert.equal(d?.status, 'scheduled');
  // You answered by hand in the Inbox meanwhile.
  await q(`INSERT INTO email_replies (campaign_id, recipient_id, from_email, subject, body_text, direction, thread_root_id) VALUES ($1, $2, 'sara@agency.test', 'Re: Websites', 'About 3 weeks.', 'outbound', $3)`, [campaignId, recipientId, id]);
  const r = await agent.processDueAiReplies(async () => true);
  assert.deepEqual(r, { sent: 0, skipped: 1, failed: 0 });
  const [row] = await drafts();
  assert.equal(row.status, 'skipped');
  assert.match(row.note, /already answered/);
});

test('auto turned off before the send: the draft waits for approval instead', { skip }, async () => {
  await agent.saveAiReplySettings(userId, { mode: 'auto', offer: 'x', delayMinutes: 0 });
  const id = await inbound('interested', 'Sounds good');
  await agent.onReplyLabeled(id);
  await agent.saveAiReplySettings(userId, { mode: 'approve' });
  await agent.processDueAiReplies(async () => true);
  assert.equal((await drafts())[0].status, 'pending');
});

test('Write with AI by hand works while the agent is off; discard closes it', { skip }, async () => {
  const id = await inbound('neutral', 'Ok, what is this about?');
  const res = await agent.draftForThread(userId, id);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.draft.status, 'pending');
  const again = await agent.draftForThread(userId, id);
  assert.equal(again.ok && again.draft.id, res.draft.id, 'the open draft is returned, no second AI call');
  assert.equal(aiCalls.length, 1);
  assert.equal((await agent.setDraftStatus(userId, res.draft.id, 'discarded'))?.status, 'discarded');
  assert.equal(await agent.openDraftForThread(userId, id), null);
  // Another user cannot touch it.
  assert.equal((await agent.draftForThread(userId + 999, id)).ok, false);
});

test('a bad AI answer (foreign link) is retried once, then refused', { skip }, async () => {
  stubAi('Hi Ali, see https://evil.example/prices for everything you need.');
  const id = await inbound('question', 'Prices?');
  const res = await agent.draftForThread(userId, id);
  assert.equal(res.ok, false);
  assert.equal(aiCalls.length, 2);
  assert.deepEqual(await drafts(), []);
});

test('first lines: leads without a website get a plain line from the company; {first_line} becomes a valid column', { skip }, async () => {
  const c2 = (await q(
    `INSERT INTO campaigns (user_id, subject, email_content, from_name, from_email) VALUES ($1, 'Hi', '<p>{first_line}</p>', 'Sara', 'sara@agency.test') RETURNING id`,
    [userId],
  )).rows[0].id as number;
  await q(`INSERT INTO recipients (campaign_id, email, name, custom_fields) VALUES ($1, 'a@gmail.com', 'Ali', '{"company":"Acme"}'), ($1, 'b@gmail.com', 'Bo', '{}')`, [c2]);
  await q(`INSERT INTO recipients (campaign_id, email, name, custom_fields, status) VALUES ($1, 'sent@gmail.com', 'Sent', '{}', 'sent')`, [c2]);
  const started = await firstLines.startFirstLines(userId, c2, false);
  assert.equal(started.ok, true);
  for (let i = 0; i < 50 && firstLines.runFor(c2)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const run = firstLines.runFor(c2)!;
  assert.equal(run.status, 'done');
  assert.deepEqual([run.total, run.fallback, run.empty, run.fromWebsite], [2, 1, 1, 0]);
  assert.equal(aiCalls.length, 0, 'no website → no AI call');
  const data = (await firstLines.firstLinesOf(userId, c2))!;
  assert.equal(data.usesPlaceholder, true);
  const byEmail = Object.fromEntries(data.leads.map((l) => [l.email, l]));
  assert.equal(byEmail['a@gmail.com']!.firstLine, 'I came across Acme and wanted to reach out.');
  const cols = JSON.parse((await q(`SELECT available_columns FROM campaigns WHERE id = $1`, [c2])).rows[0].available_columns);
  assert.ok(cols.includes('first_line'));
  // Edit by hand; the other fields stay; a sent lead cannot change.
  const edited = await firstLines.setFirstLine(userId, c2, byEmail['a@gmail.com']!.recipientId, 'Saw Acme {x} moved to Leeds.');
  assert.equal(edited.ok && edited.lead.firstLine, 'Saw Acme x moved to Leeds.');
  const fields = JSON.parse((await q(`SELECT custom_fields FROM recipients WHERE id = $1`, [byEmail['a@gmail.com']!.recipientId])).rows[0].custom_fields);
  assert.equal(fields.company, 'Acme');
  assert.equal(fields.first_line_source, 'manual');
  assert.equal((await firstLines.setFirstLine(userId, c2, byEmail['sent@gmail.com']!.recipientId, 'x')).ok, false);
  // Without "write again" leads that have a line are not redone.
  const again = await firstLines.startFirstLines(userId, c2, false);
  assert.equal(again.ok, true, 'b@gmail.com still has an empty line, so it is tried again');
  for (let i = 0; i < 50 && firstLines.runFor(c2)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(firstLines.runFor(c2)!.total, 1);
  await q(`DELETE FROM campaigns WHERE id = $1`, [c2]);
});
