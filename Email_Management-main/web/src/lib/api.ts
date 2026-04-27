import axios from 'axios';
import type {
  Campaign,
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

  // Get recipients for a campaign
  getRecipients: async (id: number, page = 1, limit = 50): Promise<{ recipients: Recipient[]; total: number }> => {
    const response = await api.get<{ recipients: Recipient[]; total: number }>(
      `/campaigns/${id}/recipients?page=${page}&limit=${limit}`
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
};

// Dashboard API
export const dashboardApi = {
  getStats: async (params?: { view?: 'monthly' | 'yearly' }): Promise<DashboardStats> => {
    const sp = new URLSearchParams();
    if (params?.view) sp.set('view', params.view);
    const q = sp.toString();
    const response = await api.get<DashboardStats>(`/dashboard/stats${q ? `?${q}` : ''}`);
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
}

/** True when user has saved SMTP + sender email so campaigns can send. */
export function isSmtpConfigured(s: SmtpSettingsResponse | null | undefined): boolean {
  if (!s) return false;
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
    kind?: 'replies' | 'system';
  }): Promise<{ replies: ReplyListItem[]; total: number }> => {
    const sp = new URLSearchParams();
    if (params?.page != null) sp.set('page', String(params.page));
    if (params?.limit != null) sp.set('limit', String(params.limit));
    if (params?.campaignId != null) sp.set('campaignId', String(params.campaignId));
    if (params?.kind) sp.set('kind', params.kind);
    const q = sp.toString();
    const response = await api.get<{ replies: ReplyListItem[]; total: number }>(`/replies${q ? `?${q}` : ''}`);
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
