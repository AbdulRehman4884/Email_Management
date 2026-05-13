import type { Request, Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { campaignTable, followUpJobsTable, recipientTable } from "../db/schema";
import { db, dbPool } from "../lib/db";
import { normalizeLocalScheduleInput } from "../lib/localDateTime";
import { parseAutoPauseAfterMinutesBody } from "../lib/campaignPauseSchedule.js";
import { parseSendWeekdaysBody } from "../lib/weekdaySendSchedule.js";
import { eligibleRecipientsWhere, type FollowUpEngagement } from "../lib/followUpFilters";

export type { FollowUpEngagement };

function parseEngagement(raw: unknown): FollowUpEngagement | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "sent" || s === "opened" || s === "delivered") return s;
  return null;
}

async function resolveCampaignIdsFromQuery(userId: number, req: Request): Promise<number[]> {
  const userRows = await db.select({ id: campaignTable.id }).from(campaignTable).where(eq(campaignTable.userId, userId));
  const allowed = new Set(userRows.map((r) => r.id));
  const raw = req.query.campaignIds;
  if (raw === undefined || raw === "") {
    return [...allowed];
  }
  const str = Array.isArray(raw) ? raw.join(",") : String(raw);
  if (!str.trim()) {
    return [...allowed];
  }
  const requested = str
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const filtered = [...new Set(requested.filter((id) => allowed.has(id)))];
  return filtered;
}

export async function createFollowUpJob(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const campaignId = Number(req.body?.campaignId);
    const templateId = String(req.body?.templateId ?? "").trim();
    const priorFollowUpCount = Number(req.body?.priorFollowUpCount ?? 0);
    const engagement = parseEngagement(req.body?.engagement);
    const scheduledRaw = String(req.body?.scheduledAt ?? "").trim();

    if (!Number.isFinite(campaignId) || campaignId < 1) {
      return res.status(400).json({ error: "campaignId is required" });
    }
    if (!templateId) return res.status(400).json({ error: "templateId is required" });
    if (!Number.isFinite(priorFollowUpCount) || priorFollowUpCount < 0) {
      return res.status(400).json({ error: "priorFollowUpCount must be a non-negative integer" });
    }
    if (!engagement) return res.status(400).json({ error: "engagement must be sent, opened, or delivered" });

    const scheduledAt = normalizeLocalScheduleInput(scheduledRaw);
    if (!scheduledAt) return res.status(400).json({ error: "scheduledAt must be YYYY-MM-DD HH:mm:ss" });

    const maxRunParsed = parseAutoPauseAfterMinutesBody(req.body?.maxRunMinutes);
    if (!maxRunParsed.ok) {
      return res.status(400).json({
        error: maxRunParsed.error.replace(/autoPauseAfterMinutes/g, "maxRunMinutes"),
      });
    }
    const sendWeekdaysParsed = parseSendWeekdaysBody(req.body?.sendWeekdays);
    if (!sendWeekdaysParsed.ok) {
      return res.status(400).json({ error: sendWeekdaysParsed.error });
    }

    const [campaign] = await db
      .select()
      .from(campaignTable)
      .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
      .limit(1);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const templates = campaign.followUpTemplates ?? [];
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return res.status(400).json({ error: "Template not found on this campaign" });

    const running = await db
      .select({ id: followUpJobsTable.id })
      .from(followUpJobsTable)
      .where(and(eq(followUpJobsTable.campaignId, campaignId), eq(followUpJobsTable.status, "running")))
      .limit(1);
    if (running[0]) {
      return res.status(409).json({ error: "A follow-up job is already running for this campaign" });
    }

    const [inserted] = await db
      .insert(followUpJobsTable)
      .values({
        userId,
        campaignId,
        scheduledAt,
        status: "pending",
        templateId,
        priorFollowUpCount,
        engagement,
        maxRunMinutes: maxRunParsed.val,
        sendWeekdays: sendWeekdaysParsed.val,
      })
      .returning();

    res.status(201).json({ job: inserted });
  } catch (e) {
    console.error("createFollowUpJob", e);
    res.status(500).json({ error: "Failed to create follow-up job" });
  }
}

export async function listFollowUpJobs(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const rows = await db
      .select({
        job: followUpJobsTable,
        campaignName: campaignTable.name,
      })
      .from(followUpJobsTable)
      .innerJoin(campaignTable, eq(followUpJobsTable.campaignId, campaignTable.id))
      .where(eq(followUpJobsTable.userId, userId))
      .orderBy(desc(followUpJobsTable.createdAt));

    res.status(200).json({
      jobs: rows.map((r) => ({
        ...r.job,
        campaignName: r.campaignName,
      })),
    });
  } catch (e) {
    console.error("listFollowUpJobs", e);
    res.status(500).json({ error: "Failed to list jobs" });
  }
}

export async function cancelFollowUpJob(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: "Invalid id" });

    const updated = await db
      .update(followUpJobsTable)
      .set({ status: "cancelled", completedAt: sql`now()` })
      .where(and(eq(followUpJobsTable.id, id), eq(followUpJobsTable.userId, userId), eq(followUpJobsTable.status, "pending")))
      .returning({ id: followUpJobsTable.id });

    if (!updated[0]) {
      return res.status(400).json({ error: "Job not found or not cancellable (only pending jobs)" });
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("cancelFollowUpJob", e);
    res.status(500).json({ error: "Failed to cancel job" });
  }
}

export async function previewFollowUpJobCount(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const campaignId = Number(req.query.campaignId);
    const templateId = String(req.query.templateId ?? "").trim();
    const priorFollowUpCount = Number(req.query.priorFollowUpCount ?? 0);
    const engagement = parseEngagement(req.query.engagement);

    if (!Number.isFinite(campaignId) || campaignId < 1) {
      return res.status(400).json({ error: "campaignId is required" });
    }
    if (!templateId) return res.status(400).json({ error: "templateId is required" });
    if (!Number.isFinite(priorFollowUpCount) || priorFollowUpCount < 0) {
      return res.status(400).json({ error: "priorFollowUpCount must be non-negative" });
    }
    if (!engagement) return res.status(400).json({ error: "engagement must be sent, opened, or delivered" });

    const [campaign] = await db
      .select({ id: campaignTable.id })
      .from(campaignTable)
      .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
      .limit(1);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const [cnt] = await db
      .select({ c: sql<number>`count(*)::int`.mapWith(Number) })
      .from(recipientTable)
      .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
      .where(eligibleRecipientsWhere(userId, campaignId, priorFollowUpCount, engagement));

    res.status(200).json({ count: Number(cnt?.c ?? 0) });
  } catch (e) {
    console.error("previewFollowUpJobCount", e);
    res.status(500).json({ error: "Failed to preview count" });
  }
}

export async function getFollowUpAnalytics(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const campaignIds = await resolveCampaignIdsFromQuery(userId, req);
    const emptySummary = {
      recipientTotal: 0,
      primarySent: 0,
      opened: 0,
      replied: 0,
    };
    if (campaignIds.length === 0) {
      return res.status(200).json({
        campaigns: [],
        bucketsByCampaign: {},
        campaignsWithActivity: [],
        scopeSummary: emptySummary,
      });
    }

    const idsLiteral = campaignIds.join(",");

    const summaryRows = await dbPool.query(
      `SELECT r.campaign_id AS "campaignId",
          COUNT(*)::int AS "recipientTotal",
          COUNT(*) FILTER (WHERE r.sent_at IS NOT NULL)::int AS "primarySent",
          COUNT(*) FILTER (WHERE r.opened_at IS NOT NULL)::int AS "opened",
          COUNT(*) FILTER (WHERE r.replied_at IS NOT NULL)::int AS "replied"
        FROM recipients r
        INNER JOIN campaigns cam ON cam.id = r.campaign_id AND cam.user_id = $1
        WHERE r.campaign_id = ANY(string_to_array($2, ',')::int[])
        GROUP BY r.campaign_id`,
      [userId, idsLiteral]
    );

    const summaryByCampaign = new Map<
      number,
      { recipientTotal: number; primarySent: number; opened: number; replied: number }
    >();
    let scopeSummary = { ...emptySummary };
    for (const raw of summaryRows.rows as Array<{
      campaignId: number;
      recipientTotal: number;
      primarySent: number;
      opened: number;
      replied: number;
    }>) {
      const cid = Number(raw.campaignId);
      const s = {
        recipientTotal: Number(raw.recipientTotal ?? 0),
        primarySent: Number(raw.primarySent ?? 0),
        opened: Number(raw.opened ?? 0),
        replied: Number(raw.replied ?? 0),
      };
      summaryByCampaign.set(cid, s);
      scopeSummary = {
        recipientTotal: scopeSummary.recipientTotal + s.recipientTotal,
        primarySent: scopeSummary.primarySent + s.primarySent,
        opened: scopeSummary.opened + s.opened,
        replied: scopeSummary.replied + s.replied,
      };
    }

    const bucketRows = await dbPool.query(
      `WITH fu AS (
        SELECT recipient_id, campaign_id,
          COUNT(*) FILTER (WHERE direction = 'outbound')::int AS n
        FROM email_replies
        GROUP BY recipient_id, campaign_id
      )
      SELECT r.campaign_id AS "campaignId",
        CASE WHEN COALESCE(fu.n, 0) >= 5 THEN 5 ELSE COALESCE(fu.n, 0) END AS bucket,
        COUNT(*)::int AS c
      FROM recipients r
      INNER JOIN campaigns cam ON cam.id = r.campaign_id AND cam.user_id = $1
      LEFT JOIN fu ON fu.recipient_id = r.id AND fu.campaign_id = r.campaign_id
      WHERE r.campaign_id = ANY(string_to_array($2, ',')::int[])
        AND r.sent_at IS NOT NULL
      GROUP BY r.campaign_id, CASE WHEN COALESCE(fu.n, 0) >= 5 THEN 5 ELSE COALESCE(fu.n, 0) END`,
      [userId, idsLiteral]
    );

    const activityRows = await dbPool.query(
      `SELECT c.id, c.name,
        (SELECT COUNT(*)::int FROM email_replies er
         WHERE er.campaign_id = c.id AND er.direction = 'outbound') AS "followUpOutboundTotal"
       FROM campaigns c
       WHERE c.user_id = $1
         AND c.id = ANY(string_to_array($2, ',')::int[])
         AND EXISTS (
           SELECT 1 FROM email_replies er
           WHERE er.campaign_id = c.id AND er.direction = 'outbound'
         )
       ORDER BY c.name ASC`,
      [userId, idsLiteral]
    );

    const bucketsByCampaign: Record<
      number,
      { 0: number; 1: number; 2: number; 3: number; 4: number; 5: number }
    > = {};

    for (const cid of campaignIds) {
      bucketsByCampaign[cid] = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    }

    for (const row of bucketRows.rows as Array<{ campaignId: number; bucket: number; c: number }>) {
      const bid = Number(row.campaignId);
      const b = Number(row.bucket);
      const c = Number(row.c);
      if (!bucketsByCampaign[bid]) continue;
      const key = b as 0 | 1 | 2 | 3 | 4 | 5;
      if (key >= 0 && key <= 5) bucketsByCampaign[bid][key] += c;
    }

    const meta = await db
      .select({ id: campaignTable.id, name: campaignTable.name })
      .from(campaignTable)
      .where(and(eq(campaignTable.userId, userId), inArray(campaignTable.id, campaignIds)));

    const campaigns = meta.map((m) => ({
      id: m.id,
      name: m.name,
      /** Bucket `5` aggregates recipients with 5 or more follow-ups sent. */
      buckets: bucketsByCampaign[m.id] ?? { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      summary: summaryByCampaign.get(m.id) ?? { ...emptySummary },
    }));

    const campaignsWithActivity = (
      activityRows.rows as Array<{ id: number; name: string; followUpOutboundTotal: number }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      followUpOutboundTotal: Number(r.followUpOutboundTotal ?? 0),
    }));

    res.status(200).json({
      campaigns,
      bucketsByCampaign,
      campaignsWithActivity,
      scopeSummary,
    });
  } catch (e) {
    console.error("getFollowUpAnalytics", e);
    res.status(500).json({ error: "Failed to load follow-up analytics" });
  }
}
