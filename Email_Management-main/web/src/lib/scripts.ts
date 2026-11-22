/**
 * src/lib/scripts.ts
 *
 * Types and labels for script generation (saved company lists + scripts).
 */

export type ScriptType = 'cold_email' | 'cold_call' | 'linkedin';

export const SCRIPT_TYPE_META: Record<ScriptType, { label: string; short: string; length: string }> = {
  cold_email: { label: 'Cold email script', short: 'Email', length: 'Medium · ~90-120 words + subject' },
  cold_call: { label: 'Cold call script', short: 'Call', length: 'Long · ~130-160 words (≈1 min)' },
  linkedin: { label: 'LinkedIn script', short: 'LinkedIn', length: 'Short · ~50-70 words' },
};

/** Button order on the company page. */
export const SCRIPT_TYPES: ScriptType[] = ['cold_email', 'cold_call', 'linkedin'];

export interface ScriptFileSummary {
  id: number;
  filename: string;
  companyCount: number;
  totalRows: number;
  createdAt: string;
  /** Scripts generated so far (status ok) across all companies in the file. */
  scriptCount: number;
}

export interface ScriptCompanyRow {
  id: number;
  rowNumber: number;
  companyName: string;
  website: string;
  /** Script types already generated for this company. */
  scriptTypes: ScriptType[];
}

export interface ScriptCompaniesPage {
  file: { id: number; filename: string; companyCount: number; report: Record<string, number>; createdAt: string };
  items: ScriptCompanyRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SavedScript {
  type: ScriptType;
  status: 'ok' | 'insufficient_data';
  /** website = problem seen on their site; industry = best-guess from their industry. */
  angle?: 'website' | 'industry';
  whatTheySell: string;
  problemStatement: string;
  painPoints: string[];
  recommendedServices: string[];
  subject: string | null;
  script: string;
  wordCount: number;
  updatedAt: string;
}

export interface ScriptCompanyDetail {
  id: number;
  fileId: number;
  filename: string;
  rowNumber: number;
  companyName: string;
  website: string;
  extraFields: Record<string, string>;
  scripts: Partial<Record<ScriptType, SavedScript>>;
  /** Neighbouring companies in the same file (row order), for Previous / Next. */
  nextCompanyId?: number | null;
  previousCompanyId?: number | null;
  /** 1-based position of this company in its file, and the file's company count. */
  position?: number;
  companyCount?: number;
}

/** Who the scripts speak as ("Hi, this is {name} from {company}"). Asked once, remembered per user. */
export interface ScriptSender {
  name: string;
  company: string;
}

const SENDER_KEY = (userId: number | string) => `mailflow-script-sender-v1:${userId}`;

export function loadScriptSender(userId: number | string | undefined): ScriptSender | null {
  if (userId === undefined) return null;
  try {
    const raw = window.localStorage.getItem(SENDER_KEY(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ScriptSender>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    const company = typeof v.company === 'string' ? v.company.trim() : '';
    return name && company ? { name, company } : null;
  } catch {
    return null;
  }
}

export function saveScriptSender(userId: number | string | undefined, sender: ScriptSender): void {
  if (userId === undefined) return;
  try {
    window.localStorage.setItem(SENDER_KEY(userId), JSON.stringify({ name: sender.name.trim(), company: sender.company.trim() }));
  } catch {
    // Private mode / storage blocked: the page asks again next time.
  }
}

export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
