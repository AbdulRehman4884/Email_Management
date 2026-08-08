import { and, eq, sql } from "drizzle-orm";
import { campaignTable, emailRepliesTable, followUpJobsTable } from "../db/schema";
import { db, dbPool } from "./db";

export type FollowUpJobSummary = {
  sent: number;
  uniqueRecipients: number;
  replied: number;
};

export async function getFollowUpJobSummary(jobId: number, userId: number): Promise<FollowUpJobSummary | null> {
  const [job] = await db
    .select({ id: followUpJobsTable.id, campaignId: followUpJobsTable.campaignId })
    .from(followUpJobsTable)
    .innerJoin(campaignTable, eq(followUpJobsTable.campaignId, campaignTable.id))
    .where(and(eq(followUpJobsTable.id, jobId), eq(followUpJobsTable.userId, userId)))
    .limit(1);
  if (!job) return null;

  const sentR = await dbPool.query(
    `SELECT
      COUNT(*)::int AS sent,
      COUNT(DISTINCT recipient_id)::int AS "uniqueRecipients"
    FROM email_replies
    WHERE follow_up_job_id = $1 AND direction = 'outbound'`,
    [jobId]
  );
  const sentRow = sentR.rows[0] as { sent?: number; uniqueRecipients?: number } | undefined;

  const replyR = await dbPool.query(
    `WITH job_out AS (
      SELECT recipient_id, MIN(received_at) AS first_sent
      FROM email_replies
      WHERE follow_up_job_id = $1 AND direction = 'outbound'
      GROUP BY recipient_id
    )
    SELECT COUNT(DISTINCT er.recipient_id)::int AS replied
    FROM email_replies er
    INNER JOIN job_out jo ON jo.recipient_id = er.recipient_id
    WHERE er.campaign_id = $2
      AND er.direction = 'inbound'
      AND er.received_at > jo.first_sent
      AND NOT (
        LOWER(SPLIT_PART(er.from_email, '@', 1)) = 'mailer-daemon'
        OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon-%'
        OR POSITION('postmaster' IN LOWER(SPLIT_PART(er.from_email, '@', 1))) > 0
      )`,
    [jobId, job.campaignId]
  );
  const replyRow = replyR.rows[0] as { replied?: number } | undefined;

  return {
    sent: Number(sentRow?.sent ?? 0),
    uniqueRecipients: Number(sentRow?.uniqueRecipients ?? 0),
    replied: Number(replyRow?.replied ?? 0),
  };
}

export async function attachSentCountsToJobs<
  T extends { id: number; campaignId: number; templateId: string },
>(jobs: T[], campaignsById: Map<number, { followUpTemplates: Array<{ id: string; title: string }> }>): Promise<
  Array<
    T & {
      templateTitle: string;
      sentCount: number;
      recipientCount: number;
      campaignName?: string;
    }
  >
> {
  if (jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);
  const countsR = await dbPool.query(
    `SELECT follow_up_job_id AS "jobId",
      COUNT(*)::int AS sent,
      COUNT(DISTINCT recipient_id)::int AS recipients
    FROM email_replies
    WHERE follow_up_job_id = ANY($1::int[]) AND direction = 'outbound'
    GROUP BY follow_up_job_id`,
    [ids]
  );
  const countMap = new Map<number, { sent: number; recipients: number }>();
  for (const row of countsR.rows as Array<{ jobId: number; sent: number; recipients: number }>) {
    countMap.set(Number(row.jobId), {
      sent: Number(row.sent ?? 0),
      recipients: Number(row.recipients ?? 0),
    });
  }
  return jobs.map((j) => {
    const c = campaignsById.get(j.campaignId);
    const tpl = c?.followUpTemplates?.find((t) => t.id === j.templateId);
    const counts = countMap.get(j.id) ?? { sent: 0, recipients: 0 };
    return {
      ...j,
      templateTitle: tpl?.title || tpl?.id || j.templateId,
      sentCount: counts.sent,
      recipientCount: counts.recipients,
    };
  });
}
