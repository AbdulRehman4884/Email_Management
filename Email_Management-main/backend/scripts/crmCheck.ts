/**
 * CRM health check for step 1 (database), step 2 (reply labeling), step 3 (rule engine), step 5 (tags)
 * step 6 (needs-reply reminders), step 7 (lead scoring) and step 9 (indexes, data owned by the right user,
 * no runaway rules).
 * READ ONLY: changes nothing.
 *
 *   npx tsx scripts/crmCheck.ts
 *
 * Uses DATABASE_URL from backend/.env. Prints PASS / WARN / FAIL for each check.
 */
import 'dotenv/config';
import { dbPool } from '../src/lib/db.js';
import { classifyReplyByRules } from '../src/lib/replyLabeling.js';
import { REPLY_LABELS, REPLY_LABEL_META } from '../src/constants/replyLabels.js';
import { evaluateConditions } from '../src/lib/crm/conditions.js';
import { canAutoMove } from '../src/lib/crm/movePolicy.js';
import { validateTagInput } from '../src/lib/crm/tags.js';
import { reminderDueHours, waitingText } from '../src/lib/crm/needsReply.js';
import { DEFAULT_WEIGHTS, computeScore } from '../src/lib/crm/leadScoring.js';

let fails = 0;
let warns = 0;
const pass = (msg: string) => console.log(`  PASS  ${msg}`);
const warn = (msg: string) => { warns++; console.log(`  WARN  ${msg}`); };
const fail = (msg: string) => { fails++; console.log(`  FAIL  ${msg}`); };

async function one<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await dbPool.query(sql, params);
  return (r.rows[0] ?? {}) as T;
}

async function step1() {
  console.log('\nSTEP 1: database');

  const tables = [
    'crm_pipelines', 'crm_pipeline_stages', 'crm_contacts', 'crm_contact_recipients', 'crm_rules',
    'crm_stage_history', 'crm_tags', 'crm_contact_tags', 'crm_campaign_tags', 'crm_score_events', 'crm_settings',
    'crm_scheduled_follow_ups', 'crm_campaign_settings',
  ];
  const found = await dbPool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables]
  );
  const have = new Set(found.rows.map((r) => r.table_name));
  const missing = tables.filter((t) => !have.has(t));
  if (missing.length) {
    fail(`missing tables: ${missing.join(', ')}. Run: npx tsx scripts/run-crm-migration.ts`);
    console.log('        (crm_scheduled_follow_ups is new in step 3 and crm_campaign_settings in step 5: the command above adds them, it is safe to run again)');
    return false;
  }
  pass(`all ${tables.length} CRM tables exist (11 from step 1 + 1 from step 3 + 1 from step 5)`);

  // Compare every CRM table with the columns drizzle/0031_crm_module.sql creates.
  const expected: Record<string, string[]> = {
    crm_pipelines: ['id', 'user_id', 'name', 'is_default', 'created_at', 'rules_seeded_at'],
    crm_pipeline_stages: ['id', 'pipeline_id', 'user_id', 'name', 'color', 'position', 'type', 'manual_only', 'stop_follow_ups', 'created_at'],
    crm_contacts: ['id', 'user_id', 'email', 'name', 'company', 'custom_fields', 'notes', 'pipeline_id', 'stage_id', 'stage_entered_at',
      'score', 'score_tier', 'last_reply_label', 'last_inbound_at', 'last_outbound_at', 'needs_reply', 'needs_reply_since',
      'needs_reply_notified_at', 'snoozed_until', 'created_at', 'updated_at',
      'follow_ups_stopped', 'follow_ups_stopped_at', 'open_count', 'last_opened_at', 'needs_reply_cleared_at',
      'score_breakdown', 'score_updated_at'],
    crm_contact_recipients: ['id', 'contact_id', 'recipient_id', 'campaign_id'],
    crm_rules: ['id', 'user_id', 'pipeline_id', 'from_stage_id', 'name', 'priority', 'is_active', 'trigger', 'conditions', 'actions',
      'forward_only', 'created_at', 'updated_at'],
    crm_stage_history: ['id', 'contact_id', 'from_stage_id', 'to_stage_id', 'rule_id', 'changed_by_user_id', 'reason', 'created_at'],
    crm_tags: ['id', 'user_id', 'name', 'color', 'scope', 'created_at'],
    crm_contact_tags: ['contact_id', 'tag_id'],
    crm_campaign_tags: ['campaign_id', 'tag_id'],
    crm_score_events: ['id', 'contact_id', 'points', 'reason', 'source_type', 'source_id', 'created_at'],
    crm_settings: ['user_id', 'needs_reply_after_hours', 'reminder_email_digest', 'score_weights', 'hot_threshold', 'warm_threshold',
      'ai_labeling_enabled', 'updated_at', 'last_digest_sent_at'],
    crm_scheduled_follow_ups: ['id', 'user_id', 'contact_id', 'recipient_id', 'campaign_id', 'rule_id', 'template_id', 'due_at',
      'status', 'error', 'sent_at', 'created_at'],
    crm_campaign_settings: ['campaign_id', 'user_id', 'pipeline_id', 'auto_tag_ids', 'created_at', 'updated_at'],
  };
  const actualRows = await dbPool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, ordinal_position`,
    [tables]
  );
  const actual = new Map<string, string[]>();
  for (const r of actualRows.rows) actual.set(r.table_name, [...(actual.get(r.table_name) ?? []), r.column_name]);
  let schemaOk = true;
  let onlyMissing = true;
  for (const [table, cols] of Object.entries(expected)) {
    const have = actual.get(table) ?? [];
    const missingCols = cols.filter((c) => !have.includes(c));
    const extraCols = have.filter((c) => !cols.includes(c));
    if (missingCols.length === 0 && extraCols.length === 0) continue;
    schemaOk = false;
    if (extraCols.length) onlyMissing = false;
    fail(`${table}: missing [${missingCols.join(', ')}]${extraCols.length ? `, extra [${extraCols.join(', ')}]` : ''}`);
    console.log(`        ${table} has: ${have.join(', ')}`);
  }
  if (schemaOk) pass('every CRM table has the expected columns');
  else if (onlyMissing) {
    console.log('\n  Some new columns are missing. Run: npx tsx scripts/run-crm-migration.ts  (safe to run again)');
    return false;
  } else {
    console.log('\n  Your CRM tables were made by a different version of the step 1 migration.');
    console.log('  Copy everything from "CRM check (read only)" to here and send it, so the code can be matched to your database.');
    return false;
  }

  const cols = await dbPool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'email_replies' AND column_name IN ('label','label_source','label_confidence','labeled_at'))
          OR (table_name = 'plans' AND column_name = 'crm_enabled'))`
  );
  if (cols.rows.length === 5) pass('label columns on email_replies + crm_enabled on plans exist');
  else fail(`only ${cols.rows.length}/5 new columns found. Run: npx tsx scripts/run-crm-migration.ts`);

  const users = await one<{ c: number }>(`SELECT count(*)::int AS c FROM users`);
  const withPipe = await one<{ c: number }>(`SELECT count(DISTINCT user_id)::int AS c FROM crm_pipelines`);
  if (withPipe.c >= users.c) pass(`every user has a pipeline (${withPipe.c}/${users.c})`);
  else warn(`${users.c - withPipe.c} user(s) have no pipeline. Run: npx tsx scripts/crmBackfill.ts`);

  const badPipes = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_pipelines p
      WHERE (SELECT count(*) FROM crm_pipeline_stages s WHERE s.pipeline_id = p.id) = 0`
  );
  if (badPipes.c === 0) pass('every pipeline has stages');
  else fail(`${badPipes.c} pipeline(s) have no stages`);

  const stages = await dbPool.query<{ name: string; type: string }>(
    `SELECT s.name, s.type FROM crm_pipeline_stages s
       JOIN crm_pipelines p ON p.id = s.pipeline_id
      WHERE p.id = (SELECT min(id) FROM crm_pipelines)
      ORDER BY s.position`
  );
  if (stages.rows.length) console.log(`        first pipeline stages: ${stages.rows.map((s) => s.name).join(' > ')}`);

  const rec = await one<{ total: number; linked: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM crm_contact_recipients x WHERE x.recipient_id = r.id))::int AS linked
       FROM recipients r`
  );
  if (rec.total === 0) warn('no campaign recipients yet, nothing to link');
  else if (rec.linked === rec.total) pass(`all ${rec.total} recipients are linked to a contact`);
  else warn(`${rec.total - rec.linked} of ${rec.total} recipients have no contact yet (new ones are linked when they reply; run crmBackfill.ts to link all)`);

  const dupes = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM (SELECT user_id, email FROM crm_contacts GROUP BY 1, 2 HAVING count(*) > 1) d`
  );
  if (dupes.c === 0) pass('no duplicate contacts (one contact per user + email)');
  else fail(`${dupes.c} duplicate contact email(s)`);

  const upper = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts WHERE email <> lower(trim(email))`);
  if (upper.c === 0) pass('all contact emails are lower-case');
  else fail(`${upper.c} contact email(s) are not lower-case`);

  const noStage = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts WHERE stage_id IS NULL`);
  const contacts = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts`);
  if (noStage.c === 0) pass(`all ${contacts.c} contacts sit in a stage`);
  else warn(`${noStage.c} of ${contacts.c} contacts have no stage`);

  const byStage = await dbPool.query<{ name: string; c: number }>(
    `SELECT s.name, count(*)::int AS c FROM crm_contacts cc JOIN crm_pipeline_stages s ON s.id = cc.stage_id
      GROUP BY s.name, s.position ORDER BY s.position`
  );
  if (byStage.rows.length) console.log(`        contacts per stage: ${byStage.rows.map((r) => `${r.name} ${r.c}`).join(', ')}`);

  const plans = await dbPool.query<{ code: string; crm_enabled: boolean }>(`SELECT code, crm_enabled FROM plans ORDER BY code`);
  const on = plans.rows.filter((p) => p.crm_enabled).map((p) => p.code);
  if (on.length) pass(`CRM is on for plans: ${on.join(', ')}`);
  else warn(`CRM is off for every plan (only admins + legacy users can call /api/crm). See README_STEP2.md`);
  return true;
}

async function step2() {
  console.log('\nSTEP 2: reply labeling');

  const samples: Array<[string, string, string?]> = [
    ['Sounds good, tell me more', 'interested'],
    ['No thanks, not interested', 'not_interested'],
    ["I'm out of the office until Monday", 'out_of_office'],
    ['How much does it cost?', 'question'],
    ['Book a call here: calendly.com/me', 'meeting_booked'],
    ['Please remove me from your list', 'bounce_unsubscribe'],
    ['Thanks', 'neutral'],
    ['Ji haan bilkul, details bhejein', 'interested'],
  ];
  let ok = 0;
  for (const [text, expected] of samples) {
    const got = classifyReplyByRules({ fromEmail: 'a@b.com', subject: 'Re: hi', bodyText: text, bodyHtml: null }).result.label;
    if (got === expected) ok++;
    else fail(`"${text}" got ${got}, expected ${expected}`);
  }
  if (ok === samples.length) pass(`label rules work on ${samples.length} sample replies`);

  const inbound = await one<{ total: number; labeled: number; manual: number; last_hour: number; last_hour_labeled: number }>(
    `SELECT count(*)::int AS total,
            count(label)::int AS labeled,
            count(*) FILTER (WHERE label_source = 'manual')::int AS manual,
            count(*) FILTER (WHERE received_at > now() - interval '1 hour')::int AS last_hour,
            count(label) FILTER (WHERE received_at > now() - interval '1 hour')::int AS last_hour_labeled
       FROM email_replies WHERE direction = 'inbound'`
  );
  if (inbound.total === 0) {
    warn('no inbound replies yet. Reply to one of your campaign emails, wait a minute, run this again');
  } else {
    console.log(`        inbound replies: ${inbound.total}, labeled: ${inbound.labeled}, changed by hand: ${inbound.manual}`);
    if (inbound.labeled === inbound.total) pass('every inbound reply has a label');
    else warn(`${inbound.total - inbound.labeled} reply(ies) have no label. Old replies: call POST /api/crm/relabel. New ones: is the API running with the new code?`);
    if (inbound.last_hour > 0) {
      if (inbound.last_hour_labeled === inbound.last_hour) pass(`all ${inbound.last_hour} replies from the last hour were labeled automatically`);
      else fail(`${inbound.last_hour - inbound.last_hour_labeled} reply(ies) from the last hour have no label: restart the API / IMAP worker with the new code`);
    }
  }

  const dist = await dbPool.query<{ label: string; c: number }>(
    `SELECT label, count(*)::int AS c FROM email_replies WHERE direction = 'inbound' AND label IS NOT NULL GROUP BY label ORDER BY c DESC`
  );
  if (dist.rows.length) {
    console.log(`        labels: ${dist.rows.map((r) => `${REPLY_LABEL_META[r.label as (typeof REPLY_LABELS)[number]]?.name ?? r.label} ${r.c}`).join(', ')}`);
  }
  const badLabel = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM email_replies WHERE label IS NOT NULL AND label <> ALL($1::text[])`,
    [REPLY_LABELS as unknown as string[]]
  );
  if (badLabel.c === 0) pass('all saved labels are valid');
  else fail(`${badLabel.c} reply(ies) have an unknown label`);

  const contactLabel = await one<{ c: number; missing: number }>(
    `SELECT count(*)::int AS c,
            count(*) FILTER (WHERE cc.last_reply_label IS NULL)::int AS missing
       FROM crm_contacts cc
      WHERE EXISTS (SELECT 1 FROM crm_contact_recipients x JOIN email_replies er ON er.recipient_id = x.recipient_id
                     WHERE x.contact_id = cc.id AND er.direction = 'inbound' AND er.label IS NOT NULL)`
  );
  if (contactLabel.c === 0) warn('no contact has a labeled reply yet');
  else if (contactLabel.missing === 0) pass(`all ${contactLabel.c} contacts with labeled replies show their last label`);
  else warn(`${contactLabel.missing} contact(s) have labeled replies but no last_reply_label (replies labeled before step 2 code; run POST /api/crm/relabel)`);

  const recent = await dbPool.query<{ id: number; from_email: string; label: string | null; label_source: string | null; snippet: string }>(
    `SELECT id, from_email, label, label_source, left(regexp_replace(coalesce(body_text, ''), '\\s+', ' ', 'g'), 50) AS snippet
       FROM email_replies WHERE direction = 'inbound' ORDER BY received_at DESC LIMIT 5`
  );
  if (recent.rows.length) {
    console.log('        newest replies:');
    for (const r of recent.rows) {
      console.log(`          #${r.id} ${r.from_email} -> ${r.label ?? '(no label)'}${r.label_source ? ` [${r.label_source}]` : ''}  "${r.snippet}"`);
    }
  }
}

async function step3() {
  console.log('\nSTEP 3: rule engine');

  // Pure logic self-test (same code the engine runs).
  const f = {
    reply_label: 'interested', reply_count: 0, open_count: 2, follow_up_count: 3, days_since_last_outbound: 6,
    days_since_last_reply: null, days_in_stage: 1, reply_text: '', tags: [], score: 0, campaign_ids: [1],
    current_stage_id: 2, current_stage_name: 'contacted', custom_fields: {},
  };
  const ruleOk =
    evaluateConditions({ op: 'AND', items: [{ field: 'open_count', operator: 'gte', value: 2 }] }, f) &&
    evaluateConditions({ op: 'AND', items: [{ field: 'follow_up_count', operator: 'gte', value: 3 }, { field: 'reply_count', operator: 'equals', value: 0 }, { field: 'days_since_last_outbound', operator: 'gte', value: 5 }] }, f) &&
    !evaluateConditions({ op: 'AND', items: [{ field: 'reply_label', operator: 'equals', value: 'out_of_office' }] }, f);
  const s = (id: number, position: number, type = 'normal') => ({ id, name: '', position, type, manualOnly: false, stopFollowUps: false });
  const moveOk =
    canAutoMove(s(2, 1), s(4, 3), true).ok && !canAutoMove(s(5, 4), s(4, 3), true).ok && canAutoMove(s(5, 4), s(8, 7, 'lost'), true).ok;
  if (ruleOk && moveOk) pass('rule conditions and forward-only move policy work');
  else fail('rule engine self-test failed (conditions or move policy)');

  const pipes = await one<{ total: number; seeded: number }>(
    `SELECT count(*)::int AS total, count(rules_seeded_at)::int AS seeded FROM crm_pipelines`
  );
  if (pipes.total > 0 && pipes.seeded === pipes.total) pass(`default rules added to all ${pipes.total} pipeline(s)`);
  else warn(`${pipes.total - pipes.seeded} pipeline(s) have no default rules yet. They are added automatically when the CRM worker starts (npm run dev) or on the first email/reply`);

  const rules = await dbPool.query<{ trigger: string; c: number }>(
    `SELECT trigger, count(*)::int AS c FROM crm_rules WHERE is_active GROUP BY trigger ORDER BY trigger`
  );
  if (rules.rows.length) console.log(`        active rules by trigger: ${rules.rows.map((r) => `${r.trigger} ${r.c}`).join(', ')}`);

  const badRules = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_rules r, jsonb_array_elements(r.actions) a
      WHERE a->>'type' = 'move_to_stage'
        AND NOT EXISTS (SELECT 1 FROM crm_pipeline_stages s WHERE s.id = (a->>'stageId')::int AND s.pipeline_id = r.pipeline_id)`
  );
  if (badRules.c === 0) pass('every "move to stage" rule points to a stage in its own pipeline');
  else fail(`${badRules.c} rule action(s) point to a stage that does not exist in their pipeline`);

  const moves = await dbPool.query<{ f: string | null; t: string; c: number }>(
    `SELECT fs.name AS f, ts.name AS t, count(*)::int AS c
       FROM crm_stage_history h
       LEFT JOIN crm_pipeline_stages fs ON fs.id = h.from_stage_id
       JOIN crm_pipeline_stages ts ON ts.id = h.to_stage_id
      WHERE h.reason = 'rule' AND h.created_at > now() - interval '7 days'
      GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 8`
  );
  if (moves.rows.length === 0) {
    warn('no lead was moved by a rule in the last 7 days yet. Send a campaign email (-> Contacted) or get a reply, then run this again');
  } else {
    pass(`rules moved leads in the last 7 days`);
    console.log(`        moves: ${moves.rows.map((m) => `${m.f ?? 'new'} -> ${m.t} (${m.c})`).join(', ')}`);
  }

  const stopped = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts WHERE follow_ups_stopped`);
  const stopStage = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_contacts cc JOIN crm_pipeline_stages s ON s.id = cc.stage_id WHERE s.stop_follow_ups`
  );
  console.log(`        follow-ups blocked: ${stopped.c} lead(s) stopped by a rule/bounce/unsubscribe, ${stopStage.c} lead(s) in a "stop follow-ups" stage`);

  const sched = await dbPool.query<{ status: string; c: number }>(
    `SELECT status, count(*)::int AS c FROM crm_scheduled_follow_ups GROUP BY status ORDER BY status`
  );
  if (sched.rows.length) console.log(`        scheduled follow-ups: ${sched.rows.map((r) => `${r.status} ${r.c}`).join(', ')}`);
  const overdue = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_scheduled_follow_ups WHERE status = 'pending' AND due_at < now() - interval '10 minutes'`
  );
  if (overdue.c === 0) pass('no scheduled follow-up is stuck');
  else warn(`${overdue.c} scheduled follow-up(s) are overdue: is the CRM worker running? (npm run dev starts it)`);

  const failedFu = await dbPool.query<{ error: string; c: number }>(
    `SELECT coalesce(error, '') AS error, count(*)::int AS c FROM crm_scheduled_follow_ups WHERE status = 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`
  );
  for (const r of failedFu.rows) warn(`${r.c} scheduled follow-up(s) failed: ${r.error}`);

  const notes = await one<{ c: number }>(`SELECT count(*)::int AS c FROM user_notifications WHERE type = 'crm_rule'`);
  console.log(`        CRM notifications created: ${notes.c}`);
}

async function step5() {
  console.log('\nSTEP 5: tags');

  const v = validateTagInput({ name: ' VIP ', color: '#22C55E' });
  if (v.ok && v.value.name === 'VIP' && v.value.color === '#22c55e' && !validateTagInput({ name: '' }).ok) pass('tag input check works');
  else fail('tag input self-test failed');

  const idx = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('crm_contact_tags_tag_idx', 'crm_campaign_tags_tag_idx', 'crm_contact_recipients_campaign_idx')`
  );
  if (idx.c === 3) pass('tag filter indexes exist');
  else fail(`only ${idx.c}/3 step 5 indexes found. Run: npx tsx scripts/run-crm-migration.ts`);

  const t = await one<{ tags: number; lead_links: number; campaign_links: number; settings: number }>(
    `SELECT (SELECT count(*)::int FROM crm_tags) AS tags,
            (SELECT count(*)::int FROM crm_contact_tags) AS lead_links,
            (SELECT count(*)::int FROM crm_campaign_tags) AS campaign_links,
            (SELECT count(*)::int FROM crm_campaign_settings) AS settings`
  );
  console.log(`        tags: ${t.tags}, on leads: ${t.lead_links}, on campaigns: ${t.campaign_links}, campaigns with CRM settings: ${t.settings}`);
  if (t.tags === 0) warn('no tags yet. Create one on the CRM Leads page (Manage tags) or on a campaign page');

  const wrongOwner = await one<{ c: number }>(
    `SELECT (SELECT count(*) FROM crm_contact_tags ct JOIN crm_contacts c ON c.id = ct.contact_id JOIN crm_tags t ON t.id = ct.tag_id
              WHERE c.user_id <> t.user_id)
          + (SELECT count(*) FROM crm_campaign_tags ca JOIN campaigns c ON c.id = ca.campaign_id JOIN crm_tags t ON t.id = ca.tag_id
              WHERE c.user_id <> t.user_id)::int AS c`
  );
  if (Number(wrongOwner.c) === 0) pass('every tag is only used by its own user');
  else fail(`${wrongOwner.c} tag link(s) mix two users`);

  const badActions = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_rules r, jsonb_array_elements(r.actions) a
      WHERE r.is_active AND a->>'type' IN ('add_tag', 'remove_tag')
        AND NOT EXISTS (SELECT 1 FROM crm_tags t WHERE t.id = (a->>'tagId')::int AND t.user_id = r.user_id)`
  );
  if (badActions.c === 0) pass('every active "add/remove tag" rule points to an existing tag');
  else warn(`${badActions.c} active rule action(s) use a tag that does not exist. Open CRM Pipelines and fix those rules`);

  const badSettings = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_campaign_settings s
      WHERE s.pipeline_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_pipelines p WHERE p.id = s.pipeline_id AND p.user_id = s.user_id)`
  );
  if (badSettings.c === 0) pass('campaign "assign to pipeline" settings point to the right user\'s pipelines');
  else fail(`${badSettings.c} campaign setting(s) point to a pipeline of another user`);
}

async function step6() {
  console.log('\nSTEP 6: needs-reply reminders');

  if (reminderDueHours(24, true) === 12 && waitingText(49) === 'waiting 2 days') pass('reminder timing self-test works');
  else fail('reminder timing self-test failed');

  const idx = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ('crm_contacts_waiting_idx', 'user_notifications_user_created_idx')`
  );
  if (idx.c === 2) pass('needs-reply indexes exist');
  else fail(`only ${idx.c}/2 step 6 indexes found. Run: npx tsx scripts/run-crm-migration.ts`);

  const w = await one<{ waiting: number; snoozed: number; reminded: number }>(
    `SELECT count(*) FILTER (WHERE needs_reply)::int AS waiting,
            count(*) FILTER (WHERE needs_reply AND snoozed_until > now())::int AS snoozed,
            count(*) FILTER (WHERE needs_reply AND needs_reply_notified_at >= needs_reply_since)::int AS reminded
       FROM crm_contacts`
  );
  console.log(`        leads waiting for your reply: ${w.waiting} (snoozed ${w.snoozed}, already reminded ${w.reminded})`);

  const broken = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_contacts WHERE needs_reply AND needs_reply_since IS NULL`);
  if (broken.c === 0) pass('every waiting lead has a "waiting since" time');
  else fail(`${broken.c} waiting lead(s) have no needs_reply_since. Run: npx tsx scripts/run-crm-migration.ts (it recomputes them)`);

  const notes = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM user_notifications WHERE type = 'needs_reply' AND created_at > now() - interval '7 days'`
  );
  console.log(`        reminders created in the last 7 days: ${notes.c}`);

  const overdue = await one<{ c: number }>(
    `SELECT count(*)::int AS c FROM crm_contacts cc LEFT JOIN crm_settings s ON s.user_id = cc.user_id
      WHERE cc.needs_reply AND (cc.snoozed_until IS NULL OR cc.snoozed_until <= now())
        AND (cc.needs_reply_notified_at IS NULL OR cc.needs_reply_notified_at < cc.needs_reply_since)
        AND cc.needs_reply_since < now() - make_interval(hours => COALESCE(s.needs_reply_after_hours, 24)) - interval '1 hour'`
  );
  if (overdue.c === 0) pass('no reminder is late');
  else warn(`${overdue.c} lead(s) should have been reminded already: is the CRM worker running? (npm run dev starts it)`);

  const digest = await one<{ c: number; failed: number }>(
    `SELECT (SELECT count(*)::int FROM crm_settings WHERE reminder_email_digest) AS c,
            (SELECT count(*)::int FROM user_notifications WHERE type = 'crm_digest_failed' AND created_at > now() - interval '7 days') AS failed`
  );
  console.log(`        users with the daily digest on: ${digest.c}`);
  if (digest.failed > 0) warn(`${digest.failed} digest email(s) failed in the last 7 days. Check the SMTP settings of those users`);
}

async function step7() {
  console.log('\nSTEP 7: lead scoring');

  const self = computeScore(
    { openCount: 2, replyCount: 1, lastLabel: 'interested', followUpsSinceReply: 0, daysInactive: 0, tags: [], customFields: null, rulePoints: 0 },
    DEFAULT_WEIGHTS
  );
  if (self.score === 70 && self.tier === 'hot') pass('score self-test works (2 opens + Interested reply = 70, hot)');
  else fail(`score self-test failed (got ${self.score} ${self.tier})`);

  const s = await one<{ total: number; never: number; stale: number; bad: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE score_updated_at IS NULL)::int AS never,
            count(*) FILTER (WHERE score_updated_at < now() - interval '2 days')::int AS stale,
            count(*) FILTER (WHERE score < 0 OR score > 100 OR score_tier NOT IN ('hot', 'warm', 'cold'))::int AS bad
       FROM crm_contacts`
  );
  if (s.bad === 0) pass('every score is 0..100 with a hot/warm/cold tier');
  else fail(`${s.bad} lead(s) have a score outside 0..100 or an unknown tier`);
  if (s.never === 0) pass(`every lead has a calculated score (${s.total})`);
  else warn(`${s.never} lead(s) have no calculated score yet. Run: npx tsx scripts/run-crm-migration.ts (or wait for the CRM worker)`);
  if (s.stale > 0) warn(`${s.stale} score(s) are older than 2 days: is the CRM worker running? (npm run dev starts it)`);

  const tiers = await dbPool.query<{ score_tier: string; c: number }>(`SELECT score_tier, count(*)::int AS c FROM crm_contacts GROUP BY 1 ORDER BY 1`);
  console.log(`        leads by tier: ${tiers.rows.map((r) => `${r.score_tier} ${r.c}`).join(', ') || 'none'}`);
  const ev = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_score_events WHERE created_at > now() - interval '7 days'`);
  console.log(`        score changes in the last 7 days: ${ev.c}`);

  const th = await one<{ c: number }>(`SELECT count(*)::int AS c FROM crm_settings WHERE warm_threshold >= hot_threshold`);
  if (th.c === 0) pass('hot/warm thresholds are in order');
  else fail(`${th.c} user(s) have warm >= hot. Fix it in Settings → Lead scoring`);
}

async function step9() {
  console.log('\nSTEP 9: indexes, ownership and rule safety');

  const want = ['email_replies_thread_idx', 'email_replies_recipient_idx', 'crm_contacts_user_recent_idx'];
  const idx = await dbPool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [want]
  );
  const missing = want.filter((n) => !idx.rows.some((r) => r.indexname === n));
  if (missing.length === 0) pass('speed indexes exist (Inbox, needs-reply, CRM table)');
  else warn(`missing index(es): ${missing.join(', ')}. Run: npx tsx scripts/run-crm-migration.ts`);

  // Every link between CRM rows must stay inside one user. Any number above 0 means data of two users is mixed.
  const own = await one<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM crm_contacts cc JOIN crm_pipelines p ON p.id = cc.pipeline_id WHERE p.user_id <> cc.user_id) AS contact_pipeline,
       (SELECT count(*)::int FROM crm_contacts cc JOIN crm_pipeline_stages s ON s.id = cc.stage_id WHERE s.pipeline_id <> cc.pipeline_id) AS contact_stage,
       (SELECT count(*)::int FROM crm_contact_tags ct JOIN crm_contacts cc ON cc.id = ct.contact_id JOIN crm_tags t ON t.id = ct.tag_id WHERE t.user_id <> cc.user_id) AS contact_tag,
       (SELECT count(*)::int FROM crm_contact_recipients x JOIN crm_contacts cc ON cc.id = x.contact_id JOIN campaigns c ON c.id = x.campaign_id WHERE c.user_id <> cc.user_id) AS contact_campaign,
       (SELECT count(*)::int FROM crm_rules r JOIN crm_pipelines p ON p.id = r.pipeline_id WHERE p.user_id <> r.user_id) AS rule_pipeline,
       (SELECT count(*)::int FROM crm_campaign_tags ct JOIN campaigns c ON c.id = ct.campaign_id JOIN crm_tags t ON t.id = ct.tag_id WHERE t.user_id <> c.user_id) AS campaign_tag`
  );
  const mixed = Object.entries(own).filter(([, n]) => Number(n) > 0);
  if (mixed.length === 0) pass('every lead, tag, rule and campaign link belongs to one user');
  else fail(`rows linked across users: ${mixed.map(([k, n]) => `${k} ${n}`).join(', ')}`);

  // A rule that fires again and again shows up as many rows for one lead in a short time.
  const runaway = await one<{ follow_ups: number; scores: number; notes: number }>(
    `SELECT
       (SELECT count(*)::int FROM (SELECT contact_id FROM crm_scheduled_follow_ups WHERE status NOT IN ('cancelled', 'failed')
                                    GROUP BY contact_id HAVING count(*) > 5) x) AS follow_ups,
       (SELECT count(*)::int FROM (SELECT contact_id FROM crm_score_events WHERE source_type = 'rule' AND created_at > now() - interval '1 day'
                                    GROUP BY contact_id HAVING count(*) > 20) x) AS scores,
       (SELECT count(*)::int FROM (SELECT payload->>'contactId' FROM user_notifications WHERE type = 'crm_rule' AND created_at > now() - interval '1 day'
                                    GROUP BY 1 HAVING count(*) > 20) x) AS notes`
  );
  if (runaway.follow_ups + runaway.scores + runaway.notes === 0) pass('no rule is firing again and again for the same lead');
  else
    warn(
      `rules may repeat: ${runaway.follow_ups} lead(s) with more than 5 rule follow-ups, ${runaway.scores} with more than 20 rule score changes today, ` +
        `${runaway.notes} with more than 20 rule notifications today. Check the rules with "time" or "follow-up sent" triggers`
    );
}

async function main() {
  console.log('CRM check (read only)');
  try {
    const ok = await step1();
    if (ok) await step2();
    if (ok) await step3();
    if (ok) await step5();
    if (ok) await step6();
    if (ok) await step7();
    if (ok) await step9();
  } finally {
    await dbPool.end();
  }
  console.log(`\nResult: ${fails} fail, ${warns} warning(s). ${fails === 0 ? 'Steps 1, 2, 3, 5, 6, 7 and 9 look good.' : 'Fix the FAIL lines first.'}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('CRM check crashed:', err);
  process.exit(1);
});
