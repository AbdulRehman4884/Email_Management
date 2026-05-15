/** Keep numeric values in sync with backend/src/constants/fieldLimits.ts */

export const CAMPAIGN_LIMITS = {
  name: 255,
  subject: 255,
  emailContent: 5000,
  fromName: 100,
  fromEmail: 255,
} as const;

export function maxLenMessage(field: string, max: number): string {
  return `${field} must be at most ${max} characters`;
}

export function emailHtmlTooLongMessage(length: number, max: number): string {
  return `Generated email is too long (${length} characters). Maximum is ${max} characters. Shorten your template content.`;
}
