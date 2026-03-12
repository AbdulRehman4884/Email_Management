import express from 'express';
import { recipientTable, statsTable, suppressionListTable } from '../db/schema.js';
import { db } from '../lib/db.js';
import { eq } from 'drizzle-orm';
const router = express.Router();

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
    const messageId = message.mail.messageId;
    
    for (const email of bouncedEmails) {
      // Find recipient first
      const [recipient] = await db.select().from(recipientTable).where(eq(recipientTable.messageId, messageId));
      
      if (recipient) {
        await db.update(recipientTable).set({ status: 'bounced' }).where(eq(recipientTable.messageId, messageId));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, recipient.campaignId)).limit(1);
        if (stat) await db.update(statsTable).set({ bouncedCount: Number(stat.bouncedCount) + 1 }).where(eq(statsTable.campaignId, recipient.campaignId));
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
    const messageId = message.mail.messageId;
    
    for (const email of complainedEmails) {
      const [recipient] = await db.select().from(recipientTable).where(eq(recipientTable.messageId, messageId));
      
      if (recipient) {
        await db.update(recipientTable).set({ status: 'complained' }).where(eq(recipientTable.messageId, messageId));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, recipient.campaignId)).limit(1);
        if (stat) await db.update(statsTable).set({ complainedCount: Number(stat.complainedCount) + 1 }).where(eq(statsTable.campaignId, recipient.campaignId));
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
    const messageId = message.mail.messageId;
    
    const [recipient] = await db.select().from(recipientTable).where(eq(recipientTable.messageId, messageId)).limit(1);
    
    if (recipient) {
      await db.update(recipientTable).set({
        status: 'delivered',
        delieveredAt: new Date(),
      }).where(eq(recipientTable.messageId, messageId));
    }
  }
  
  res.status(200).send('OK');
});

export default router;
