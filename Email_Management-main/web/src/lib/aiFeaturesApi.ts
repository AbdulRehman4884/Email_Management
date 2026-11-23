/**
 * AI reply agent (Inbox answers) and AI first lines (campaign openings): API calls.
 */
import api from './api';

export type AiReplyMode = 'off' | 'approve' | 'auto';

export interface AiReplySettings {
  mode: AiReplyMode;
  labels: string[];
  delayMinutes: number;
  maxPerThread: number;
  dailyLimit: number;
  offer: string;
  meetingLink: string;
}

export interface AiReplyDraft {
  id: number;
  replyId: number;
  threadRootId: number;
  campaignId: number;
  recipientId: number;
  label: string | null;
  objection: string | null;
  body: string;
  status: 'pending' | 'scheduled' | 'sent' | 'discarded' | 'used' | 'skipped' | 'failed';
  sendAfter: string | null;
  sentAt: string | null;
  note: string | null;
  createdAt: string;
}

export const aiReplyApi = {
  getSettings: async (): Promise<{ settings: AiReplySettings; aiConfigured: boolean }> =>
    (await api.get('/ai-reply/settings')).data,
  saveSettings: async (settings: Partial<AiReplySettings>): Promise<{ settings: AiReplySettings; aiConfigured: boolean }> =>
    (await api.put('/ai-reply/settings', settings)).data,
  threadDraft: async (threadRootId: number): Promise<AiReplyDraft | null> =>
    (await api.get<{ draft: AiReplyDraft | null }>(`/ai-reply/threads/${threadRootId}/draft`)).data.draft,
  writeDraft: async (threadRootId: number, regenerate = false): Promise<AiReplyDraft> =>
    (await api.post<{ draft: AiReplyDraft }>(`/ai-reply/threads/${threadRootId}/draft`, { regenerate })).data.draft,
  discard: async (draftId: number): Promise<AiReplyDraft> =>
    (await api.post<{ draft: AiReplyDraft }>(`/ai-reply/drafts/${draftId}/discard`)).data.draft,
  markUsed: async (draftId: number): Promise<AiReplyDraft> =>
    (await api.post<{ draft: AiReplyDraft }>(`/ai-reply/drafts/${draftId}/use`)).data.draft,
};

export interface FirstLineRun {
  status: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  fromWebsite: number;
  fallback: number;
  empty: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface FirstLineLead {
  recipientId: number;
  email: string;
  name: string | null;
  status: string;
  firstLine: string;
  source: string | null;
}

export const firstLinesApi = {
  get: async (campaignId: number): Promise<{ leads: FirstLineLead[]; usesPlaceholder: boolean; run: FirstLineRun | null }> =>
    (await api.get(`/campaigns/${campaignId}/first-lines`)).data,
  start: async (campaignId: number, overwrite = false): Promise<FirstLineRun> =>
    (await api.post<{ run: FirstLineRun }>(`/campaigns/${campaignId}/first-lines`, { overwrite })).data.run,
  save: async (campaignId: number, recipientId: number, firstLine: string): Promise<FirstLineLead> =>
    (await api.put<{ lead: FirstLineLead }>(`/campaigns/${campaignId}/first-lines/${recipientId}`, { firstLine })).data.lead,
};

/** The server's error text, or a fallback. */
export function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof msg === 'string' && msg.trim() ? msg : fallback;
}

/** The AI ends with "Best regards,\nName": drop it when the user's own signature is added at send. */
export function withoutSignOff(body: string): string {
  return body.replace(/\n+\s*(best regards|kind regards|regards|best|thanks|thank you|cheers),?\s*(\n[^\n]{0,80})?\s*$/i, '').trimEnd();
}
