import { sql } from "drizzle-orm";
import { emailRepliesTable, recipientTable } from "../db/schema";

/** Outbound rows in `email_replies` per recipient (follow-ups only). */
export function recipientFollowUpCountExpr() {
  return sql<number>`(
        SELECT COUNT(*)::int FROM ${emailRepliesTable} fu
        WHERE fu.recipient_id = ${recipientTable.id}
          AND fu.campaign_id = ${recipientTable.campaignId}
          AND fu.direction = 'outbound'
    )`.mapWith(Number);
}
