import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../constants/fieldLimits';

/**
 * "Unlimited SMTP profiles". plans.smtp_limit is an integer NOT NULL column, so unlimited is stored as this
 * value (the same sentinel the legacy fallback plan and SMTP_PROFILES_MAX already used). Every numeric check
 * (`count >= smtpLimit`) keeps working; screens show "Unlimited" via isUnlimitedSmtpProfiles().
 */
export const SMTP_PROFILES_UNLIMITED = 999999;

export function isUnlimitedSmtpProfiles(smtpLimit: number | null | undefined): boolean {
  return smtpLimit == null || smtpLimit >= SMTP_PROFILES_UNLIMITED;
}

/** Plan rows written by the startup seed. Every plan: at most 20 emails/day per SMTP account (hard maximum). */
export const PLANS_SEED = [
  {
    code: 'basic',
    name: 'Basic',
    smtpLimit: 5,
    dailyEmailLimit: SMTP_DAILY_EMAIL_LIMIT_MAX,
    inboxEnabled: false,
    followUpEnabled: false,
    // F-04: was the $0.10 test price.
    priceUsd: '9.99',
  },
  {
    code: 'standard',
    name: 'Standard',
    smtpLimit: 100,
    dailyEmailLimit: SMTP_DAILY_EMAIL_LIMIT_MAX,
    inboxEnabled: true,
    followUpEnabled: true,
    priceUsd: '24.99',
  },
  {
    code: 'premium',
    name: 'Premium',
    smtpLimit: SMTP_PROFILES_UNLIMITED,
    dailyEmailLimit: SMTP_DAILY_EMAIL_LIMIT_MAX,
    inboxEnabled: true,
    followUpEnabled: true,
    priceUsd: '49.99',
  },
] as const;
