import type { Request, Response } from 'express';
import { suppressionListTable } from '../db/schema';
import { db } from '../lib/db';
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

export async function unsubscribeHandler(req: Request, res: Response) {
  const email = getEmail(req);
  if (!email) {
    res.status(400).send('Missing or invalid email');
    return;
  }
  try {
    await db.insert(suppressionListTable).values({ email, reason: 'unsubscribe' });
  } catch {
    // already in list (unique) or other error - still show success
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(UNSUBSCRIBED_HTML);
}
