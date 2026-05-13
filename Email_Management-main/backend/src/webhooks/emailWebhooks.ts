import express from 'express';
import { campaignSequenceTouchesTable, recipientTable, statsTable, suppressionListTable } from '../db/schema.js';
import { db } from '../lib/db.js';
import { normalizeMessageId } from '../lib/messageId.js';
import { eq, or } from 'drizzle-orm';
import { markRecipientBounced, markRecipientUnsubscribed } from '../lib/sequenceExecutionEngine.js';
const router = express.Router();

async function resolveRecipientByMessageId(messageId: string) {
  const [recipient] = await db.select().from(recipientTable).where(eq(recipientTable.messageId, messageId)).limit(1);
  if (recipient) {
    return {
      recipientId: recipient.id,
      campaignId: recipient.campaignId,
      email: recipient.email,
      delieveredAt: recipient.delieveredAt,
      source: 'recipient' as const,
    };
  }

  const [touch] = await db
    .select({
      recipientId: campaignSequenceTouchesTable.recipientId,
      campaignId: campaignSequenceTouchesTable.campaignId,
      email: recipientTable.email,
      delieveredAt: recipientTable.delieveredAt,
    })
    .from(campaignSequenceTouchesTable)
    .innerJoin(recipientTable, eq(recipientTable.id, campaignSequenceTouchesTable.recipientId))
    .where(eq(campaignSequenceTouchesTable.messageId, messageId))
    .limit(1);
  if (!touch) return null;
  return {
    recipientId: touch.recipientId,
    campaignId: touch.campaignId,
    email: touch.email,
    delieveredAt: touch.delieveredAt,
    source: 'touch' as const,
  };
}

// SNS sends POST requests to confirm subscription first [web:39]
router.post('/webhooks/bounce', async (req, res) => {
  const message = JSON.parse(req.body.Message || '{}');
  
  if (req.body.Type === 'SubscriptionConfirmation') {
    // Visit SubscribeURL to confirm
    console.log('Confirm SNS subscription:', req.body.SubscribeURL);
    return res.status(200).send('OK');
  }
  
  // Handle bounce notification 
  if (message.notificationType === 'Bounce') {
    const bouncedEmails = message.bounce.bouncedRecipients.map((r: any) => r.emailAddress);
    const messageId = normalizeMessageId(message.mail.messageId) ?? message.mail.messageId;
    
    for (const email of bouncedEmails) {
      const recipient = await resolveRecipientByMessageId(messageId);
      
      if (recipient) {
        await db.update(recipientTable).set({ status: 'bounced' }).where(eq(recipientTable.id, recipient.recipientId));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, recipient.campaignId)).limit(1);
        if (stat) await db.update(statsTable).set({ bouncedCount: Number(stat.bouncedCount) + 1 }).where(eq(statsTable.campaignId, recipient.campaignId));
        await markRecipientBounced({ campaignId: recipient.campaignId, recipientId: recipient.recipientId });
        try {
          await db.insert(suppressionListTable).values({ email: email.toLowerCase(), reason: 'bounce' });
        } catch {
          // already in list
        }
      }
    }
    
    console.log('Bounce processed:', bouncedEmails);
  }
  
  res.status(200).send('OK');
});

// Handle complaints (spam reports) [web:36][web:39]
router.post('/webhooks/complaint', async (req, res) => {
  const message = JSON.parse(req.body.Message || '{}');
  
  if (req.body.Type === 'SubscriptionConfirmation') {
    console.log('Confirm SNS subscription:', req.body.SubscribeURL);
    return res.status(200).send('OK');
  }
  
  if (message.notificationType === 'Complaint') {
    const complainedEmails = message.complaint.complainedRecipients.map((r: any) => r.emailAddress);
    const messageId = normalizeMessageId(message.mail.messageId) ?? message.mail.messageId;
    
    for (const email of complainedEmails) {
      const recipient = await resolveRecipientByMessageId(messageId);
      
      if (recipient) {
        await db.update(recipientTable).set({ status: 'complained' }).where(eq(recipientTable.id, recipient.recipientId));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, recipient.campaignId)).limit(1);
        if (stat) await db.update(statsTable).set({ complainedCount: Number(stat.complainedCount) + 1 }).where(eq(statsTable.campaignId, recipient.campaignId));
        await markRecipientUnsubscribed({ campaignId: recipient.campaignId, recipientId: recipient.recipientId });
        try {
          await db.insert(suppressionListTable).values({ email: email.toLowerCase(), reason: 'complaint' });
        } catch {
          // already in list
        }
      }
    }
    
    console.log('Complaint processed:', complainedEmails);
  }
  
  res.status(200).send('OK');
});

// Handle delivery confirmations (optional)
router.post('/webhooks/delivery', async (req, res) => {
  const message = JSON.parse(req.body.Message || '{}');
  
  if (req.body.Type === 'SubscriptionConfirmation') {
    return res.status(200).send('OK');
  }
  
  if (message.notificationType === 'Delivery') {
    const messageId = normalizeMessageId(message.mail.messageId) ?? message.mail.messageId;
    const recipient = await resolveRecipientByMessageId(messageId);

    if (recipient) {
      const alreadyHadDeliveryTimestamp = recipient.delieveredAt != null;

      await db
        .update(recipientTable)
        .set({
          status: 'delivered',
          delieveredAt: new Date().toISOString(),
        })
        .where(eq(recipientTable.id, recipient.recipientId));

      // SMTP worker may already set delivered_at + increment stats; avoid double-count.
      if (!alreadyHadDeliveryTimestamp) {
        const [stat] = await db
          .select()
          .from(statsTable)
          .where(eq(statsTable.campaignId, recipient.campaignId))
          .limit(1);
        if (stat) {
          await db
            .update(statsTable)
            .set({ delieveredCount: Number(stat.delieveredCount) + 1 })
            .where(eq(statsTable.campaignId, recipient.campaignId));
        }
      }
    }
  }
  
  res.status(200).send('OK');
});

export default router;
