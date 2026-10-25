/**
 * CRM step 8: one lead's timeline for the contact drawer, newest first:
 * campaign emails sent, opens, replies (with label), your replies, follow-ups, stage moves, score changes.
 */
import type { PoolClient } from 'pg';
import { dbPool } from '../db.js';

type Db = Pick<PoolClient, 'query'>;

export type TimelineType = 'sent' | 'opened' | 'reply' | 'you_replied' | 'follow_up' | 'stage' | 'score';

export interface TimelineItem {
  type: TimelineType;
  at: string;
  title: string;
  detail: string | null;
  label: string | null;
  points: number | null;
  campaignId: number | null;
  replyId: number | null;
  threadRootId: number | null;
}

export async function contactTimeline(contactId: number, limit = 150, db: Db = dbPool): Promise<TimelineItem[]> {
  const r = await db.query<{
    type: TimelineType; at: string; title: string | null; detail: string | null; label: string | null; points: number | null;
    campaign_id: number | null; reply_id: number | null; thread_root_id: number | null;
  }>(
    `SELECT * FROM (
       SELECT 'sent'::text AS type, COALESCE(r.sent_ts, r.sent_at::timestamptz) AS at,
              ('Email sent: ' || c.name) AS title, c.subject AS detail, NULL::text AS label, NULL::int AS points,
              c.id AS campaign_id, NULL::int AS reply_id, NULL::int AS thread_root_id
         FROM crm_contact_recipients x JOIN recipients r ON r.id = x.recipient_id JOIN campaigns c ON c.id = x.campaign_id
        WHERE x.contact_id = $1 AND (r.sent_ts IS NOT NULL OR r.sent_at IS NOT NULL)
       UNION ALL
       SELECT 'opened', r.opened_at::timestamptz, ('Opened: ' || c.name), NULL, NULL, NULL, c.id, NULL, NULL
         FROM crm_contact_recipients x JOIN recipients r ON r.id = x.recipient_id JOIN campaigns c ON c.id = x.campaign_id
        WHERE x.contact_id = $1 AND r.opened_at IS NOT NULL
       UNION ALL
       SELECT CASE WHEN er.direction = 'inbound' THEN 'reply'
                   WHEN er.follow_up_template_id IS NOT NULL OR er.follow_up_job_id IS NOT NULL THEN 'follow_up'
                   ELSE 'you_replied' END,
              er.received_at::timestamptz,
              er.subject,
              NULLIF(left(regexp_replace(COALESCE(er.body_text, ''), '\\s+', ' ', 'g'), 200), ''),
              CASE WHEN er.direction = 'inbound' THEN er.label END, NULL, er.campaign_id, er.id, COALESCE(er.thread_root_id, er.id)
         FROM crm_contact_recipients x JOIN email_replies er ON er.recipient_id = x.recipient_id
        WHERE x.contact_id = $1
       UNION ALL
       SELECT 'stage', h.created_at,
              (COALESCE(fs.name || ' → ', '') || COALESCE(ts.name, 'a deleted stage')),
              CASE WHEN h.reason = 'rule' AND ru.name IS NOT NULL THEN 'Rule: ' || ru.name
                   WHEN h.reason = 'manual' THEN 'Moved by you'
                   WHEN h.reason = 'created' THEN 'Lead created'
                   ELSE h.reason END,
              NULL, NULL, NULL, NULL, NULL
         FROM crm_stage_history h
         LEFT JOIN crm_pipeline_stages fs ON fs.id = h.from_stage_id
         LEFT JOIN crm_pipeline_stages ts ON ts.id = h.to_stage_id
         LEFT JOIN crm_rules ru ON ru.id = h.rule_id
        WHERE h.contact_id = $1
       UNION ALL
       SELECT 'score', e.created_at, e.reason, NULL, NULL, e.points, NULL, NULL, NULL
         FROM crm_score_events e
        WHERE e.contact_id = $1
     ) t
     WHERE t.at IS NOT NULL
     ORDER BY t.at DESC
     LIMIT $2`,
    [contactId, limit]
  );
  return r.rows.map((x) => ({
    type: x.type,
    at: x.at,
    title: x.title ?? '',
    detail: x.detail,
    label: x.label,
    points: x.points,
    campaignId: x.campaign_id,
    replyId: x.reply_id,
    threadRootId: x.thread_root_id,
  }));
}
