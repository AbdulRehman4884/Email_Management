/** Must match backend constants in `backend/src/constants/fieldLimits.ts`. */
export const SMTP_DAILY_EMAIL_LIMIT_MAX = 20;

export const SMTP_LIMITS = {
  provider: 50,
  host: 255,
  user: 255,
  password: 500,
  fromName: 100,
  fromEmail: 255,
  trackingBaseUrl: 500,
} as const;

/** Plans store "unlimited SMTP profiles" as 999999 (backend SMTP_PROFILES_UNLIMITED in lib/planCatalog.ts). */
export const SMTP_PROFILES_UNLIMITED = 999999;

export function isUnlimitedSmtpProfiles(limit: number | null | undefined): boolean {
  return limit == null || limit >= SMTP_PROFILES_UNLIMITED;
}

/** "Unlimited SMTP profiles", "1 SMTP profile", "100 SMTP profiles". */
export function smtpProfilesLabel(limit: number | null | undefined): string {
  if (isUnlimitedSmtpProfiles(limit)) return 'Unlimited SMTP profiles';
  return `${limit} SMTP profile${limit === 1 ? '' : 's'}`;
}
