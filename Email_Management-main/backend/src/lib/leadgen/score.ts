/**
 * Fit score 0-100 (use case UC-07). Pure: the facts come from the master data.
 * Tier: 60+ hot, 30-59 warm, else cold. The breakdown is saved so the UI can show "why this score".
 */

export interface ScoreFacts {
  /** Company category equals the saved search's category. */
  categoryMatch: boolean;
  /** Company city equals the saved search's city. */
  cityMatch: boolean;
  hasWebsite: boolean;
  hasPhone: boolean;
  /** Any email we may use (company or person). */
  hasEmail: boolean;
  /** An email whose domain has MX records. */
  hasVerifiedEmail: boolean;
  /** A direct (non info@) email. */
  hasDirectEmail: boolean;
  hasDecisionMaker: boolean;
  hasLinkedin: boolean;
  /** Careers page / open roles. */
  hiring: boolean;
  /** The site was fetched in the last 90 days and answered. */
  websiteActive: boolean;
  /** The search's focus words this company matches ("AI automation"), or null / absent. */
  focusMatch?: string | null;
}

export interface ScorePart {
  key: string;
  label: string;
  points: number;
}

export type Tier = 'hot' | 'warm' | 'cold';

const PARTS: Array<[keyof ScoreFacts, string, number]> = [
  ['categoryMatch', 'Matches the category you searched', 15],
  ['cityMatch', 'In the city you searched', 10],
  ['hasWebsite', 'Has a website', 8],
  ['hasPhone', 'Phone number found', 7],
  ['hasEmail', 'Email found', 10],
  ['hasVerifiedEmail', 'Email domain accepts mail (MX)', 10],
  ['hasDirectEmail', 'Direct (not info@) email', 10],
  ['hasDecisionMaker', 'Decision maker found', 15],
  ['hasLinkedin', 'LinkedIn page found', 5],
  ['hiring', 'Hiring (careers page / open roles)', 5],
  ['websiteActive', 'Website is live', 5],
];

export function tierFor(score: number): Tier {
  return score >= 60 ? 'hot' : score >= 30 ? 'warm' : 'cold';
}

/** Points for matching the search's focus: it is what the user asked for, so it weighs like the category. */
export const FOCUS_POINTS = 20;

export function computeFitScore(f: ScoreFacts): { score: number; tier: Tier; breakdown: ScorePart[] } {
  const breakdown = PARTS.filter(([k]) => f[k] === true).map(([key, label, points]) => ({ key, label, points }));
  if (f.focusMatch) breakdown.unshift({ key: 'focusMatch', label: `Matches your focus: ${f.focusMatch}`, points: FOCUS_POINTS });
  const score = Math.min(100, breakdown.reduce((n, p) => n + p.points, 0));
  return { score, tier: tierFor(score), breakdown };
}

/** 0-100: how complete the company record is (companies.data_quality). */
export function dataQuality(f: Pick<ScoreFacts, 'hasWebsite' | 'hasPhone' | 'hasEmail' | 'hasLinkedin' | 'hasDecisionMaker'> & { hasAddress: boolean; hasDescription: boolean }): number {
  const parts = [f.hasWebsite, f.hasPhone, f.hasEmail, f.hasLinkedin, f.hasDecisionMaker, f.hasAddress, f.hasDescription];
  return Math.round((parts.filter(Boolean).length / parts.length) * 100);
}
