import type { Request, Response } from 'express';
import { recipientTable, suppressionListTable } from '../db/schema';
import { db } from '../lib/db';
import { eq } from 'drizzle-orm';
import { verifyUnsubscribeToken } from '../lib/unsubscribeToken.js';
import { markRecipientUnsubscribed } from '../lib/sequenceExecutionEngine.js';
const UNSUBSCRIBED_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:2rem auto;padding:1rem;">
  <h1>You're unsubscribed</h1>
  <p>You have been removed from our mailing list and will not receive further campaign emails.</p>
</body>
</html>
`;

function getEmail(req: Request): string | null {
  const email = (req.query.email as string) || (req.body?.email as string);
  if (typeof email !== 'string' || !email.includes('@')) return null;
  return email.trim().toLowerCase();
}

async function addToSuppressionList(email: string): Promise<void> {
  try {
    await db.insert(suppressionListTable).values({ email, reason: 'unsubscribe' });
  } catch {
    // already in list (unique) or other error - still show success
  }
}

export async function unsubscribeHandler(req: Request, res: Response) {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    const tokenPayload = token ? verifyUnsubscribeToken(token) : null;

    if (tokenPayload) {
      await addToSuppressionList(tokenPayload.email);
      await markRecipientUnsubscribed({
        campaignId: tokenPayload.campaignId,
        recipientId: tokenPayload.recipientId,
      });
    } else {
      const email = getEmail(req);
      if (!email) {
        res.status(400).send('Missing or invalid email');
        return;
      }
      await addToSuppressionList(email);
      const recipients = await db
        .select({ id: recipientTable.id, campaignId: recipientTable.campaignId })
        .from(recipientTable)
        .where(eq(recipientTable.email, email));
      for (const recipient of recipients) {
        await markRecipientUnsubscribed({
          campaignId: recipient.campaignId,
          recipientId: recipient.id,
        });
      }
    }
  } catch {
    // Always render success to avoid leaking suppression state.
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(UNSUBSCRIBED_HTML);
}
