/** Must match backend constants in `backend/src/constants/fieldLimits.ts`. */
export const SMTP_DAILY_EMAIL_LIMIT_MAX = 50;

export const SMTP_LIMITS = {
  provider: 50,
  host: 255,
  user: 255,
  password: 500,
  fromName: 100,
  fromEmail: 255,
  trackingBaseUrl: 500,
} as const;
