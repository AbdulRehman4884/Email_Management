import { and, eq, isNotNull, sql } from "drizzle-orm";
import { campaignTable, recipientTable } from "../db/schema";
import { recipientFollowUpCountExpr } from "./followUpSql";

export type FollowUpEngagement = "sent" | "opened" | "delivered";

function engagementSql(engagement: FollowUpEngagement) {
  if (engagement === "opened") return isNotNull(recipientTable.openedAt);
  if (engagement === "delivered") return isNotNull(recipientTable.delieveredAt);
  return sql`true`;
}

/** Shared filters for scheduled bulk follow-ups (primary email must have been sent). */
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
    engagementSql(engagement)
  );
}
