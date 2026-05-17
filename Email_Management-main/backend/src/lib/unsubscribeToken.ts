import crypto from "node:crypto";

interface UnsubscribePayload {
  campaignId: number;
  recipientId: number;
  email: string;
}

function getSecret(): string {
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || "mailflow-unsubscribe-secret";
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function decodeBase64url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function generateUnsubscribeToken(payload: UnsubscribePayload): string {
  const body = JSON.stringify({
    campaignId: payload.campaignId,
    recipientId: payload.recipientId,
    email: payload.email.toLowerCase().trim(),
  });
  const encoded = base64url(body);
  const signature = crypto.createHmac("sha256", getSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac("sha256", getSecret()).update(encoded).digest("base64url");
  if (expected !== signature) return null;
  try {
    const parsed = JSON.parse(decodeBase64url(encoded)) as Record<string, unknown>;
    const campaignId = Number(parsed.campaignId);
    const recipientId = Number(parsed.recipientId);
    const email = String(parsed.email ?? "").trim().toLowerCase();
    if (!Number.isInteger(campaignId) || campaignId <= 0) return null;
    if (!Number.isInteger(recipientId) || recipientId <= 0) return null;
    if (!email.includes("@")) return null;
    return { campaignId, recipientId, email };
  } catch {
    return null;
  }
}
