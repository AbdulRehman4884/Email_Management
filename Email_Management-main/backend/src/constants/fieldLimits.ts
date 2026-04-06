/** Must match varchar lengths in src/db/schema.ts */

export const CAMPAIGN_LIMITS = {
  name: 255,
  subject: 255,
  emailContent: 5000,
  fromName: 100,
  fromEmail: 255,
} as const;

export const SMTP_LIMITS = {
  provider: 50,
  host: 255,
  user: 255,
  password: 500,
  fromName: 100,
  fromEmail: 255,
  trackingBaseUrl: 500,
} as const;

export function maxLenMessage(field: string, max: number): string {
  return `${field} must be at most ${max} characters`;
}

export function firstLengthViolation(
  checks: Array<{ label: string; value: string; max: number }>
): string | undefined {
  for (const { label, value, max } of checks) {
    if (value.length > max) return maxLenMessage(label, max);
  }
  return undefined;
}
