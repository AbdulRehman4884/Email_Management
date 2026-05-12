import { recipientTable, statsTable } from "../db/schema.js";
import { db } from "./db.js";
import { and, eq } from "drizzle-orm";
import { stopRecipientSequence } from "./sequenceExecutionEngine.js";

export async function recordRecipientReply(input: {
  campaignId: number;
  recipientId: number;
  repliedAt?: Date;
}): Promise<{ alreadyMarked: boolean }> {
  const repliedAt = input.repliedAt ?? new Date();
  const [recipient] = await db
    .select({ repliedAt: recipientTable.repliedAt })
    .from(recipientTable)
    .where(and(
      eq(recipientTable.campaignId, input.campaignId),
      eq(recipientTable.id, input.recipientId),
    ))
    .limit(1);

  if (!recipient) {
    throw new Error("Recipient not found");
  }
  if (recipient.repliedAt != null) {
    return { alreadyMarked: true };
  }

  await db
    .update(recipientTable)
    .set({ repliedAt })
    .where(eq(recipientTable.id, input.recipientId));

  const [stats] = await db
    .select()
    .from(statsTable)
    .where(eq(statsTable.campaignId, input.campaignId))
    .limit(1);
  if (stats) {
    await db
      .update(statsTable)
      .set({ repliedCount: Number(stats.repliedCount) + 1 })
      .where(eq(statsTable.campaignId, input.campaignId));
  }

  return { alreadyMarked: false };
}

export async function markRecipientReplied(input: {
  campaignId: number;
  recipientId: number;
  repliedAt?: Date;
}): Promise<{ alreadyMarked: boolean }> {
  const result = await recordRecipientReply(input);
  if (result.alreadyMarked) {
    return result;
  }

  await stopRecipientSequence({
    campaignId: input.campaignId,
    recipientId: input.recipientId,
    sequenceStatus: "replied",
    stopReason: "replied",
    occurredAt: input.repliedAt,
  });

  return result;
}
