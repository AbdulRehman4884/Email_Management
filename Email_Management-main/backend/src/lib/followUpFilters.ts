import { and, eq, isNotNull, not, sql } from "drizzle-orm";
import { campaignTable, recipientTable } from "../db/schema";
import { recipientFollowUpCountExpr } from "./followUpSql";
import { crmFollowUpBlockedSql } from "./crm/followUps.js";
import { automationTablesKnownReady, automationTablesReady } from "./crm/automations.js";

export type FollowUpEngagement = "sent" | "opened" | "delivered";

function engagementSql(engagement: FollowUpEngagement) {
  if (engagement === "opened") return isNotNull(recipientTable.openedAt);
  if (engagement === "delivered") return isNotNull(recipientTable.delieveredAt);
  return sql`true`;
}

/**
 * Lead automations (migration 0041): a recipient whose campaign automation is still running gets its follow-ups from
 * the automation, so a bulk follow-up job skips it (no double follow-ups). Before the migration (or until this process
 * has checked the tables) nothing is skipped.
 */
// Check the tables once when the process loads this file, so the first bulk job already skips automation leads.
void automationTablesReady().catch(() => false);

function inRunningCampaignAutomationSql() {
  if (!automationTablesKnownReady()) {
    void automationTablesReady().catch(() => false);
    return sql`false`;
  }
  return sql`EXISTS (
    SELECT 1 FROM crm_automation_runs car
     WHERE car.recipient_id = ${recipientTable.id} AND car.status IN ('active', 'running', 'waiting_call')
  )`;
}

/**
 * Shared filters for scheduled bulk follow-ups (primary email must have been sent).
 * CRM step 3: leads whose follow-ups were stopped, or who sit in a "stop follow-ups" stage, are skipped.
 */
export function eligibleRecipientsWhere(
  userId: number,
  campaignId: number,
  priorFollowUpCount: number,
  engagement: FollowUpEngagement
) {
  return and(
    eq(campaignTable.userId, userId),
    eq(recipientTable.campaignId, campaignId),
    isNotNull(recipientTable.sentAt),
    eq(recipientFollowUpCountExpr(), priorFollowUpCount),
    engagementSql(engagement),
    not(crmFollowUpBlockedSql()),
    not(inRunningCampaignAutomationSql())
  );
}
