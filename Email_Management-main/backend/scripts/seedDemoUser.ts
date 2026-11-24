/**
 * Seed the "Prodago / Delta Prime" demo account (DUMMY client demo data).
 *
 * Recreates — with AUTO-GENERATED ids, so it cannot collide with existing prod rows —
 * exactly what the localhost demo showed:
 *
 *   Dashboard ....... 3247 sent · 3247 delivered · 1200 opened · 78 replied (100% delivery)
 *                     + the per-day Nov time series (sent / opened / "clicked"=reply)
 *   CRM pipeline .... "Sales Pipeline" (default), 6 stages:
 *                     Contacted 2047 · Engaged 1122 · Replied 24 · Interested 18
 *                     · Meeting Booked 20 · Won 16   (total 3247)
 *                     KPIs: interested 18 · meetings 36 · won 16 · hot 36 · winRate 100
 *
 * The login is the SAME as the demo: email + password below (overridable via env).
 *
 *   # LOCAL (safe): point DATABASE_URL at a throwaway db first
 *   DATABASE_URL="postgres://.../seed_test" npx tsx scripts/seedDemoUser.ts
 *
 *   # PRODUCTION (run by the prod team, after review):
 *   DATABASE_URL="<prod connection string>" npx tsx scripts/seedDemoUser.ts
 *
 * Env overrides (all optional):
 *   SEED_EMAIL     login email      (default bismakhidmat48@gmail.com)
 *   SEED_PASSWORD  login password   (default AMSIB@12bisma)
 *   SEED_NAME      display name     (default Prodago)
 *   SEED_YEAR      time-series year (default: current year)
 *   SEED_MONTH     1-12, series mo. (default: current month) — data lands on days 1-22
 *
 * Idempotent: if a user with SEED_EMAIL already exists it ABORTS and changes nothing,
 * so running it twice can never duplicate the demo. Everything runs in one transaction;
 * any error rolls the whole thing back. READ the script before running on production.
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { dbPool } from '../src/lib/db.js';

const SALT_ROUNDS = 10; // matches authController.ts

const EMAIL = (process.env.SEED_EMAIL ?? 'bismakhidmat48@gmail.com').trim().toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD ?? 'AMSIB@12bisma';
const NAME = process.env.SEED_NAME ?? 'Prodago';
const now = new Date();
const YEAR = Number(process.env.SEED_YEAR ?? now.getFullYear());
const MONTH = Number(process.env.SEED_MONTH ?? now.getMonth() + 1); // 1-12

const FROM_EMAIL = 'hello@prodago.com'; // campaign sender; replies come from a different address
const CONTACT_DOMAIN = 'prodago.invalid'; // RFC 2606 reserved — never routable

// ── Exact per-day distribution captured from the localhost demo ──────────────
// [dayOfMonth, sent, opened, replied("clicked")]
const SERIES: Array<[number, number, number, number]> = [
  [1, 191, 0, 0], [2, 197, 31, 0], [3, 180, 69, 3], [4, 178, 63, 1],
  [5, 207, 72, 4], [6, 168, 73, 5], [7, 180, 53, 5], [8, 211, 68, 3],
  [9, 218, 50, 6], [10, 159, 83, 4], [11, 193, 91, 3], [12, 198, 86, 5],
  [13, 170, 68, 8], [14, 196, 60, 4], [15, 197, 68, 7], [16, 212, 76, 1],
  [17, 192, 80, 6], [18, 0, 70, 7], [19, 0, 39, 5], [22, 0, 0, 1],
];

const TOTAL_SENT = SERIES.reduce((a, [, s]) => a + s, 0);     // 3247
const TOTAL_OPENED = SERIES.reduce((a, [, , o]) => a + o, 0); // 1200
const TOTAL_REPLIED = SERIES.reduce((a, [, , , r]) => a + r, 0); // 78

// CRM stage sizes (sum = 3247). The 78 replied recipients fill the advanced stages:
//   Won 16 + Meeting Booked 20 = 36 → label meeting_booked (hot)
//   Interested 18 → label interested ; Replied 24 → label neutral   (36+18+24 = 78)
// The 1122 opened-but-not-replied → Engaged ; the 2047 never-opened → Contacted.
const STAGES = [
  { name: 'Contacted', position: 1, type: 'normal', count: 2047 },
  { name: 'Engaged', position: 2, type: 'normal', count: 1122 },
  { name: 'Replied', position: 3, type: 'normal', count: 24 },
  { name: 'Interested', position: 4, type: 'normal', count: 18 },
  { name: 'Meeting Booked', position: 5, type: 'normal', count: 20 },
  { name: 'Won', position: 6, type: 'won', count: 16 },
];

function d(day: number): string {
  return `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function ts(day: number, seq: number): string {
  // spread within the day so ordering is stable; stays inside the day for 0..86399 seq
  const sec = seq % 86400;
  const hh = String(Math.floor(sec / 3600)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${d(day)}T${hh}:${mm}:${ss}.000Z`;
}

async function main() {
  // sanity: the hard-coded distribution must match the headline totals
  if (TOTAL_SENT !== 3247 || TOTAL_OPENED !== 1200 || TOTAL_REPLIED !== 78) {
    throw new Error(`distribution drift: sent=${TOTAL_SENT} opened=${TOTAL_OPENED} replied=${TOTAL_REPLIED}`);
  }
  const stageSum = STAGES.reduce((a, s) => a + s.count, 0);
  if (stageSum !== TOTAL_SENT) throw new Error(`stage sum ${stageSum} != ${TOTAL_SENT}`);

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const exists = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [EMAIL]);
    if (exists.rows.length > 0) {
      await client.query('ROLLBACK');
      console.log(`✗ A user with email ${EMAIL} already exists (id ${exists.rows[0].id}). Nothing changed.`);
      console.log('  To re-seed, remove that user first (or set SEED_EMAIL to a new address).');
      return;
    }

    const passwordHash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);

    // ── user ──────────────────────────────────────────────────────────────
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, name, role, is_active)
       VALUES ($1, $2, $3, 'user', true) RETURNING id`,
      [EMAIL, passwordHash, NAME],
    );
    const userId: number = user.id;

    // ── campaign ──────────────────────────────────────────────────────────
    const { rows: [camp] } = await client.query(
      `INSERT INTO campaigns (user_id, name, status, subject, email_content, from_name, from_email, reciept_count)
       VALUES ($1, $2, 'completed', $3, $4, $5, $6, $7) RETURNING id`,
      [userId, 'Delta Prime Outreach', 'Quick question about {{company}}',
        '<p>Hi {{name}},</p><p>Reaching out from Prodago…</p>', NAME, FROM_EMAIL, TOTAL_SENT],
    );
    const campaignId: number = camp.id;

    // ── recipients (3247) ───────────────────────────────────────────────────
    // Build the three independent assignments, then insert in one bulk statement.
    // sent_at: every recipient, by the "sent" buckets (days 1-17).
    // opened_at: recipients 0..1199, by the "opened" buckets.
    // replied: recipients 0..77, by the "replied" buckets (become email_replies).
    const emails: string[] = [];
    const names: string[] = [];
    const statuses: string[] = [];
    const sentAt: string[] = [];
    const deliveredAt: string[] = [];
    const sentTs: (string | null)[] = [];
    const openedAt: (string | null)[] = [];
    const repliedAt: (string | null)[] = [];

    for (let i = 0; i < TOTAL_SENT; i++) {
      emails.push(`prospect-${i + 1}@${CONTACT_DOMAIN}`);
      names.push(`Prospect ${i + 1}`);
    }

    // sent_at / delivered_at / sent_ts across recipients in order
    {
      let idx = 0;
      for (const [day, sent] of SERIES) {
        for (let k = 0; k < sent; k++, idx++) {
          sentAt[idx] = d(day);
          deliveredAt[idx] = d(day);
          sentTs[idx] = ts(day, k);
        }
      }
    }
    // opened_at for recipients 0..1199
    {
      let idx = 0;
      for (const [day, , opened] of SERIES) {
        for (let k = 0; k < opened; k++, idx++) openedAt[idx] = ts(day, 40000 + k);
      }
    }
    // fill remaining
    for (let i = 0; i < TOTAL_SENT; i++) {
      if (openedAt[i] === undefined) openedAt[i] = null;
      if (repliedAt[i] === undefined) repliedAt[i] = null;
      // status: never failed/bounced/complained, so all count as delivered
      statuses[i] = i < TOTAL_OPENED ? 'opened' : 'delivered';
    }
    // replied flag timestamps for recipients 0..77 (used on recipient + reply rows)
    const replyTs: string[] = [];
    {
      let idx = 0;
      for (const [day, , , replied] of SERIES) {
        for (let k = 0; k < replied; k++, idx++) {
          replyTs[idx] = ts(day, 60000 + k);
          repliedAt[idx] = replyTs[idx];
          statuses[idx] = 'replied';
        }
      }
    }

    const recIds: number[] = [];
    // bulk insert recipients via UNNEST, RETURNING ids in insert order
    {
      const res = await client.query(
        `INSERT INTO recipients
           (campaign_id, email, status, name, sent_at, delivered_at, sent_ts, opened_at, replied_at)
         SELECT $1,
                u.email, u.status, u.name,
                u.sent_at::date, u.delivered_at::date, u.sent_ts::timestamptz,
                u.opened_at::timestamp, u.replied_at::timestamp
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[])
              WITH ORDINALITY AS u(email, status, name, sent_at, delivered_at, sent_ts, opened_at, replied_at, ord)
         ORDER BY u.ord
         RETURNING id`,
        [campaignId, emails, statuses, names, sentAt, deliveredAt, sentTs,
          openedAt.map((v) => v), repliedAt.map((v) => v)],
      );
      for (const r of res.rows) recIds.push(r.id);
    }

    // ── campaign_stats ──────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO campaign_stats
         (campaign_id, sent_count, delivered_count, opened_count, replied_count)
       VALUES ($1, $2, $2, $3, $4)`,
      [campaignId, TOTAL_SENT, TOTAL_OPENED, TOTAL_REPLIED],
    );

    // ── email_replies (78) — recipients 0..77, human (not system), from a different address ─
    {
      const rCampaign: number[] = [];
      const rRecipient: number[] = [];
      const rFrom: string[] = [];
      const rSubject: string[] = [];
      const rReceived: string[] = [];
      for (let i = 0; i < TOTAL_REPLIED; i++) {
        rCampaign.push(campaignId);
        rRecipient.push(recIds[i]);
        rFrom.push(`prospect-${i + 1}@${CONTACT_DOMAIN}`);
        rSubject.push('Re: Quick question');
        rReceived.push(replyTs[i]);
      }
      await client.query(
        `INSERT INTO email_replies (campaign_id, recipient_id, from_email, subject, received_at, direction)
         SELECT u.cid, u.rid, u.frm, u.subj, u.recv::timestamp, 'inbound'
         FROM UNNEST($1::int[], $2::int[], $3::text[], $4::text[], $5::text[])
              AS u(cid, rid, frm, subj, recv)`,
        [rCampaign, rRecipient, rFrom, rSubject, rReceived],
      );
    }

    // ── CRM pipeline + stages ────────────────────────────────────────────────
    const { rows: [pipe] } = await client.query(
      `INSERT INTO crm_pipelines (user_id, name, is_default) VALUES ($1, 'Sales Pipeline', true) RETURNING id`,
      [userId],
    );
    const pipelineId: number = pipe.id;

    const stageIdByName: Record<string, number> = {};
    for (const s of STAGES) {
      const { rows: [st] } = await client.query(
        `INSERT INTO crm_pipeline_stages (pipeline_id, user_id, name, position, type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [pipelineId, userId, s.name, s.position, s.type],
      );
      stageIdByName[s.name] = st.id;
    }

    // ── CRM contacts (3247, one per recipient) ────────────────────────────────
    // index ranges (see header): 0..15 Won, 16..35 Meeting Booked, 36..53 Interested,
    //                            54..77 Replied, 78..1199 Engaged, 1200..3246 Contacted
    const cUser: number[] = [];
    const cEmail: string[] = [];
    const cName: string[] = [];
    const cPipeline: number[] = [];
    const cStage: number[] = [];
    const cStageEntered: string[] = [];
    const cScore: number[] = [];
    const cTier: string[] = [];
    const cLabel: (string | null)[] = [];
    const cLastInbound: (string | null)[] = [];
    const cStopped: boolean[] = [];
    const cOpenCount: number[] = [];

    function stageFor(i: number): string {
      if (i < 16) return 'Won';
      if (i < 36) return 'Meeting Booked';
      if (i < 54) return 'Interested';
      if (i < 78) return 'Replied';
      if (i < TOTAL_OPENED) return 'Engaged';
      return 'Contacted';
    }

    for (let i = 0; i < TOTAL_SENT; i++) {
      const stage = stageFor(i);
      cUser.push(userId);
      cEmail.push(`prospect-${i + 1}@${CONTACT_DOMAIN}`);
      cName.push(`Prospect ${i + 1}`);
      cPipeline.push(pipelineId);
      cStage.push(stageIdByName[stage]);
      const inbound = i < TOTAL_REPLIED ? replyTs[i] : null;
      cStageEntered.push(inbound ?? (openedAt[i] as string | null) ?? (sentTs[i] as string) ?? ts(1, i));
      cLastInbound.push(inbound);
      if (i < 36) { // Won + Meeting Booked
        cLabel.push('meeting_booked'); cScore.push(85); cTier.push('hot'); cStopped.push(true);
      } else if (i < 54) { // Interested
        cLabel.push('interested'); cScore.push(60); cTier.push('warm'); cStopped.push(false);
      } else if (i < 78) { // Replied → neutral
        cLabel.push('neutral'); cScore.push(40); cTier.push('warm'); cStopped.push(false);
      } else if (i < TOTAL_OPENED) { // Engaged (opened, no reply)
        cLabel.push(null); cScore.push(20); cTier.push('cold'); cStopped.push(false);
      } else { // Contacted (never opened)
        cLabel.push(null); cScore.push(0); cTier.push('cold'); cStopped.push(false);
      }
      cOpenCount.push(openedAt[i] ? 1 : 0);
    }

    const contactIds: number[] = [];
    {
      const res = await client.query(
        `INSERT INTO crm_contacts
           (user_id, email, name, pipeline_id, stage_id, stage_entered_at,
            score, score_tier, last_reply_label, last_inbound_at, follow_ups_stopped, open_count)
         SELECT u.uid, u.email, u.name, u.pid, u.sid, u.entered::timestamptz,
                u.score, u.tier, u.label, u.inbound::timestamptz, u.stopped, u.opens
         FROM UNNEST($1::int[], $2::text[], $3::text[], $4::int[], $5::int[], $6::text[],
                     $7::int[], $8::text[], $9::text[], $10::text[], $11::bool[], $12::int[])
              WITH ORDINALITY AS u(uid, email, name, pid, sid, entered, score, tier, label,
                                   inbound, stopped, opens, ord)
         ORDER BY u.ord
         RETURNING id`,
        [cUser, cEmail, cName, cPipeline, cStage, cStageEntered, cScore, cTier,
          cLabel, cLastInbound, cStopped, cOpenCount],
      );
      for (const r of res.rows) contactIds.push(r.id);
    }

    // ── link every recipient to its contact ──────────────────────────────────
    await client.query(
      `INSERT INTO crm_contact_recipients (contact_id, recipient_id, campaign_id)
       SELECT u.cid, u.rid, $1
       FROM UNNEST($2::int[], $3::int[]) AS u(cid, rid)`,
      [campaignId, contactIds, recIds],
    );

    await client.query('COMMIT');

    // ── verify ────────────────────────────────────────────────────────────
    const v = await dbPool.query(
      `SELECT
         (SELECT count(*) FROM recipients WHERE campaign_id = $1 AND sent_at IS NOT NULL) AS sent,
         (SELECT count(*) FROM recipients WHERE campaign_id = $1 AND opened_at IS NOT NULL) AS opened,
         (SELECT count(DISTINCT recipient_id) FROM email_replies WHERE campaign_id = $1 AND direction = 'inbound') AS replied,
         (SELECT count(*) FROM crm_contacts WHERE user_id = $2) AS contacts`,
      [campaignId, userId],
    );
    const row = v.rows[0];
    console.log('✓ Demo account seeded.');
    console.log(`  login:    ${EMAIL} / ${PASSWORD}`);
    console.log(`  user id:  ${userId}   campaign id: ${campaignId}   pipeline id: ${pipelineId}`);
    console.log(`  series:   ${d(1)} … ${d(22)}`);
    console.log(`  sent=${row.sent} opened=${row.opened} replied=${row.replied} contacts=${row.contacts}`);
    console.log(`  expected: sent=${TOTAL_SENT} opened=${TOTAL_OPENED} replied=${TOTAL_REPLIED} contacts=${TOTAL_SENT}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => dbPool.end())
  .catch(async (err) => {
    console.error('✗ Seed failed:', err);
    await dbPool.end();
    process.exit(1);
  });
