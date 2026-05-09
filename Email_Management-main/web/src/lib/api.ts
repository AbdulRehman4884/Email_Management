import axios from 'axios';
import type {
  Campaign,
  FollowUpTemplate,
  CreateCampaignPayload,
  UpdateCampaignPayload,
  CampaignStats,
  Recipient,
  UploadResponse,
  DashboardStats,
  PlaceholderValidation,
} from '../types';
import type { AgentStructuredResult } from './agentMessage';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      } catch {}
      const path = window.location.pathname || '';
      if (!path.startsWith('/login') && !path.startsWith('/signup')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

// Campaign API
export const campaignApi = {
  // Get all campaigns
  getAll: async (): Promise<Campaign[]> => {
    const response = await api.get<Campaign[]>('/campaigns');
    return response.data;
  },

  // Get campaign by ID
  getById: async (id: number): Promise<Campaign> => {
    const response = await api.get<Campaign>(`/campaigns/${id}`);
    return response.data;
  },

  // Create new campaign
  create: async (payload: CreateCampaignPayload): Promise<Campaign> => {
    const response = await api.post<Campaign>('/campaigns', payload);
    return response.data;
  },

  // Update campaign
  update: async (id: number, payload: UpdateCampaignPayload): Promise<Campaign> => {
    const response = await api.put<Campaign>(`/campaigns/${id}`, payload);
    return response.data;
  },

  /** Follow-up templates + skip-confirm (any campaign status). */
  patchFollowUpSettings: async (
    id: number,
    payload: { followUpTemplates?: FollowUpTemplate[]; followUpSkipConfirm?: boolean }
  ): Promise<Campaign> => {
    const response = await api.patch<Campaign>(`/campaigns/${id}/follow-up-settings`, payload);
    return response.data;
  },

  // Delete campaign
  delete: async (id: number): Promise<void> => {
    await api.delete(`/campaigns/${id}`);
  },

  // Start campaign
  start: async (id: number): Promise<{ status: 'scheduled' | 'in_progress'; message: string }> => {
    const response = await api.post<{ status: 'scheduled' | 'in_progress'; message: string }>(`/campaigns/${id}/start`);
    return response.data;
  },

  // Pause campaign
  pause: async (id: number): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(`/campaigns/${id}/pause`);
    return response.data;
  },

  // Resume campaign
  resume: async (id: number): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(`/campaigns/${id}/resume`);
    return response.data;
  },

  // Get campaign stats
  getStats: async (id: number): Promise<CampaignStats> => {
    const response = await api.get<CampaignStats>(`/campaigns/${id}/stats`);
    return response.data;
  },

  // Upload recipients CSV
  uploadRecipients: async (id: number, file: File): Promise<UploadResponse> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post<UploadResponse>(`/campaigns/${id}/recipients/upload`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  // Get recipients for a campaign with optional filter
  getRecipients: async (id: number, page = 1, limit = 50, filter?: string): Promise<{ recipients: Recipient[]; total: number }> => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (filter && filter !== 'all') {
      params.set('filter', filter);
    }
    const response = await api.get<{ recipients: Recipient[]; total: number }>(
      `/campaigns/${id}/recipients?${params.toString()}`
    );
    return response.data;
  },

  // Delete a recipient
  deleteRecipient: async (campaignId: number, recipientId: number): Promise<void> => {
    await api.delete(`/campaigns/${campaignId}/recipients/${recipientId}`);
  },

  // Mark recipient as replied
  markReplied: async (campaignId: number, recipientId: number): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(
      `/campaigns/${campaignId}/recipients/${recipientId}/mark-replied`
    );
    return response.data;
  },

  // Validate placeholders in email content against available columns
  validatePlaceholders: async (id: number): Promise<PlaceholderValidation> => {
    const response = await api.get<PlaceholderValidation>(`/campaigns/${id}/validate-placeholders`);
    return response.data;
  },

  // Get all sent emails across campaigns
  getSentEmails: async (
    page = 1,
    limit = 20,
    opts?: {
      search?: string;
      campaignIds?: number[];
      followUpCount?: number;
      followUpCountMin?: number;
      sentFilter?: 'all' | 'delivered' | 'opened' | 'replied' | 'failed';
    }
  ): Promise<{
    emails: SentEmailItem[];
    total: number;
    counts: { all: number; delivered: number; opened: number; replied: number; failed: number };
  }> => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    const q = opts?.search?.trim();
    if (q) params.set('search', q);
    if (opts?.campaignIds && opts.campaignIds.length > 0) {
      params.set('campaignIds', opts.campaignIds.join(','));
    }
    if (opts?.followUpCount !== undefined) params.set('followUpCount', String(opts.followUpCount));
    if (opts?.followUpCountMin !== undefined) params.set('followUpCountMin', String(opts.followUpCountMin));
    if (opts?.sentFilter) params.set('sentFilter', opts.sentFilter);
    const response = await api.get<{
      emails: SentEmailItem[];
      total: number;
      counts: { all: number; delivered: number; opened: number; replied: number; failed: number };
    }>(
      `/campaigns/sent-emails?${params.toString()}`
    );
    return response.data;
  },

  // Send a follow-up email to a recipient
  sendFollowUp: async (
    campaignId: number,
    recipientId: number,
    payload: { subject: string; body: string; templateId?: string }
  ): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(
      `/campaigns/${campaignId}/recipients/${recipientId}/follow-up`,
      payload
    );
    return response.data;
  },
};

// Sent Email Item type for inbox
export interface SentEmailItem {
  id: number;
  email: string;
  name: string | null;
  campaignId: number;
  campaignName: string;
  status: string;
  sentAt: string;
  openedAt: string | null;
  repliedAt: string | null;
  followUpCount?: number;
}

// Dashboard API
export const dashboardApi = {
  getStats: async (params?: {
    view?: 'monthly' | 'yearly';
    /** Comma-separated in query; empty/omit = all user campaigns */
    campaignIds?: number[];
  }): Promise<DashboardStats> => {
    const sp = new URLSearchParams();
    if (params?.view) sp.set('view', params.view);
    if (params?.campaignIds && params.campaignIds.length > 0) {
      sp.set('campaignIds', params.campaignIds.join(','));
    }
    const q = sp.toString();
    const response = await api.get<DashboardStats>(`/dashboard/stats${q ? `?${q}` : ''}`, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    return response.data;
  },
};

// Settings API (SMTP)
export interface SmtpSettingsResponse {
  id?: number;
  provider: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
  fromName?: string;
  fromEmail: string;
  replyToEmail?: string;
  trackingBaseUrl?: string;
  updatedAt?: string;
  hasPassword?: boolean;
  profiles?: SmtpSettingsResponse[];
  max?: number;
}

export interface SmtpProfileListResponse {
  profiles: SmtpSettingsResponse[];
  max: number;
}

/** True when user has at least one SMTP profile (or legacy single saved row). */
export function isSmtpConfigured(s: SmtpSettingsResponse | null | undefined): boolean {
  if (!s) return false;
  const profiles = s.profiles;
  if (Array.isArray(profiles) && profiles.length > 0) return true;
  if (!String(s.fromEmail ?? '').trim()) return false;
  if (!String(s.host ?? '').trim()) return false;
  if (!String(s.user ?? '').trim()) return false;
  return true;
}

export const settingsApi = {
  getSmtp: async (): Promise<SmtpSettingsResponse> => {
    const response = await api.get<SmtpSettingsResponse>('/settings/smtp');
    return response.data;
  },
  listSmtpProfiles: async (): Promise<SmtpProfileListResponse> => {
    const response = await api.get<SmtpProfileListResponse>('/settings/smtp/list');
    return response.data;
  },
  postSmtpProfile: async (data: {
    provider: string;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password?: string;
    fromName?: string;
    fromEmail: string;
    replyToEmail?: string;
    trackingBaseUrl?: string;
  }): Promise<{ id: number; message: string }> => {
    const response = await api.post<{ id: number; message: string }>('/settings/smtp', data);
    return response.data;
  },
  putSmtpProfile: async (
    id: number,
    data: {
      provider: string;
      host: string;
      port: number;
      secure: boolean;
      user: string;
      password?: string;
      fromName?: string;
      fromEmail: string;
      replyToEmail?: string;
      trackingBaseUrl?: string;
    }
  ): Promise<{ message: string }> => {
    const response = await api.put<{ message: string }>(`/settings/smtp/${id}`, data);
    return response.data;
  },
  deleteSmtpProfile: async (id: number): Promise<{ message: string }> => {
    const response = await api.delete<{ message: string }>(`/settings/smtp/${id}`);
    return response.data;
  },
  putSmtp: async (data: {
    provider: string;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password?: string;
    fromName?: string;
    fromEmail: string;
    replyToEmail?: string;
    trackingBaseUrl?: string;
  }): Promise<{ message: string }> => {
    const response = await api.put<{ message: string }>('/settings/smtp', data);
    return response.data;
  },
};

// Replies (Inbox)
export interface ReplyListItem {
  id: number;
  threadRootId: number;
  campaignId: number;
  recipientId: number;
  campaignName: string;
  recipientEmail: string;
  fromEmail: string;
  direction: string;
  isUnread: boolean;
  isSystemNotification: boolean;
  subject: string;
  snippet: string;
  receivedAt: string;
  followUpCount?: number;
}

export interface ReplyThreadMessage {
  id: number;
  direction: string;
  fromEmail: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: string;
}

export interface ReplyThread {
  threadRootId: number;
  campaignId: number;
  recipientId: number;
  campaignName: string;
  recipientEmail: string;
  isSystemNotification: boolean;
  subject: string;
  messages: ReplyThreadMessage[];
}

export const repliesApi = {
  getReplies: async (params?: {
    page?: number;
    limit?: number;
    campaignId?: number;
    campaignIds?: number[];
    search?: string;
    kind?: 'replies' | 'system';
    followUpCount?: number;
    followUpCountMin?: number;
  }): Promise<{ replies: ReplyListItem[]; total: number }> => {
    const sp = new URLSearchParams();
    if (params?.page != null) sp.set('page', String(params.page));
    if (params?.limit != null) sp.set('limit', String(params.limit));
    if (params?.campaignId != null) sp.set('campaignId', String(params.campaignId));
    if (params?.campaignIds && params.campaignIds.length > 0) {
      sp.set('campaignIds', params.campaignIds.join(','));
    }
    const sq = params?.search?.trim();
    if (sq) sp.set('search', sq);
    if (params?.kind) sp.set('kind', params.kind);
    if (params?.followUpCount !== undefined) sp.set('followUpCount', String(params.followUpCount));
    if (params?.followUpCountMin !== undefined) sp.set('followUpCountMin', String(params.followUpCountMin));
    const q = sp.toString();
    const response = await api.get<{ replies: ReplyListItem[]; total: number }>(`/replies${q ? `?${q}` : ''}`);
    return response.data;
  },
  getThreadRoot: async (campaignId: number, recipientId: number): Promise<{ threadRootId: number | null }> => {
    const sp = new URLSearchParams();
    sp.set('campaignId', String(campaignId));
    sp.set('recipientId', String(recipientId));
    const response = await api.get<{ threadRootId: number | null }>(`/replies/thread-root?${sp.toString()}`);
    return response.data;
  },
  getReplyThreadByRoot: async (threadRootId: number): Promise<ReplyThread> => {
    const response = await api.get<ReplyThread>(`/replies/by-thread/${threadRootId}`);
    return response.data;
  },
  getReplyById: async (id: number): Promise<ReplyThread> => {
    const response = await api.get<ReplyThread>(`/replies/${id}`);
    return response.data;
  },
  sendReply: async (id: number, body: string): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(`/replies/${id}/send`, { body });
    return response.data;
  },
};

// Auth API
export type PreferredTheme = 'light' | 'dark' | 'system';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  preferredTheme?: PreferredTheme;
}

export interface LoginResponse {
  user: AuthUser;
  token: string;
}

export const authApi = {
  login: async (body: { email: string; password: string }): Promise<LoginResponse> => {
    const response = await api.post<LoginResponse>('/auth/login', body);
    return response.data;
  },
  signup: async (body: { email: string; password: string; name: string }): Promise<LoginResponse> => {
    const response = await api.post<LoginResponse>('/auth/signup', body);
    return response.data;
  },
  forgotPassword: async (body: { email: string }): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>('/auth/forgot-password', body);
    return response.data;
  },
  verifyResetOtp: async (body: { email: string; otp: string }): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>('/auth/verify-reset-otp', body);
    return response.data;
  },
  resetPassword: async (body: {
    email: string;
    otp: string;
    newPassword: string;
    confirmPassword: string;
  }): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>('/auth/reset-password', body);
    return response.data;
  },
  getMe: async (): Promise<{ user: AuthUser }> => {
    const response = await api.get<{ user: AuthUser }>('/auth/me');
    return response.data;
  },
  updatePreferredTheme: async (preferredTheme: PreferredTheme): Promise<{ user: AuthUser }> => {
    const response = await api.patch<{ user: AuthUser }>('/auth/me', { preferredTheme });
    return response.data;
  },
};

// Admin API (super_admin only)
export interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

export const adminApi = {
  getUsers: async (params?: { page?: number; limit?: number }): Promise<{ users: AdminUser[]; total: number }> => {
    const sp = new URLSearchParams();
    if (params?.page != null) sp.set('page', String(params.page));
    if (params?.limit != null) sp.set('limit', String(params.limit));
    const q = sp.toString();
    const response = await api.get<{ users: AdminUser[]; total: number }>(`/admin/users${q ? `?${q}` : ''}`);
    return response.data;
  },
  updateUser: async (id: number, data: { role?: string; isActive?: boolean }): Promise<AdminUser> => {
    const response = await api.patch<AdminUser>(`/admin/users/${id}`, data);
    return response.data;
  },
  deleteUser: async (id: number): Promise<void> => {
    await api.delete(`/admin/users/${id}`);
  },
};

const AGENT_BASE_URL = import.meta.env.VITE_AGENT_API_URL ?? 'http://localhost:3002/api/agent';

const agentHttp = axios.create({
  baseURL: AGENT_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

agentHttp.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export interface AgentPendingAction {
  id: string;
  intent: string;
  toolName: string;
  expiresAt: string;
}

export interface AgentUiMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
}

type AgentResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function mapAgentError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const code = err.response?.data?.error?.code;
    const message = err.response?.data?.error?.message;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
  }
  return 'Unable to reach AI agent service.';
}

export const agentApi = {
  chat: async (
    message: string,
    sessionId?: string
  ): Promise<
    AgentResult<{
      approvalRequired?: boolean;
      sessionId?: string;
      /** Legacy plain-text response (approval prompts, workflow errors, plan confirmations). */
      response?: string;
      /** Normalised structured result from a regular chat turn. Always has `message`. */
      result?: AgentStructuredResult;
      message?: string;
      pendingAction?: AgentPendingAction;
    }>
  > => {
    try {
      const { data } = await agentHttp.post('/chat', { message, sessionId });
      if (!data?.success) {
        return { success: false, error: data?.error?.message ?? 'Agent chat failed.' };
      }
      return { success: true, data: data.data };
    } catch (err) {
      return { success: false, error: mapAgentError(err) };
    }
  },

  confirm: async (
    pendingActionId: string
  ): Promise<AgentResult<{ response?: string }>> => {
    try {
      const { data } = await agentHttp.post('/confirm', { pendingActionId });
      if (!data?.success) {
        return { success: false, error: data?.error?.message ?? 'Confirmation failed.' };
      }
      return { success: true, data: data.data };
    } catch (err) {
      return { success: false, error: mapAgentError(err) };
    }
  },

  cancel: async (
    pendingActionId: string
  ): Promise<AgentResult<{ message?: string }>> => {
    try {
      const { data } = await agentHttp.post('/cancel', { pendingActionId });
      if (!data?.success) {
        return { success: false, error: data?.error?.message ?? 'Cancel failed.' };
      }
      return { success: true, data: data.data };
    } catch (err) {
      return { success: false, error: mapAgentError(err) };
    }
  },
};

export default api;
