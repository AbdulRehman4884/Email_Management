import axios from 'axios';
import type {
  Campaign,
  CreateCampaignPayload,
  UpdateCampaignPayload,
  CampaignStats,
  Recipient,
  UploadResponse,
  DashboardStats,
} from '../types';

const API_BASE_URL = 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

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
  start: async (id: number): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(`/campaigns/${id}/start`);
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

  // Mark recipient as replied
  markReplied: async (campaignId: number, recipientId: number): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>(
      `/campaigns/${campaignId}/recipients/${recipientId}/mark-replied`
    );
    return response.data;
  },
};

// Dashboard API
export const dashboardApi = {
  getStats: async (): Promise<DashboardStats> => {
    const response = await api.get<DashboardStats>('/dashboard/stats');
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
  fromName?: string;
  fromEmail: string;
  trackingBaseUrl?: string;
  updatedAt?: string;
  hasPassword?: boolean;
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
    trackingBaseUrl?: string;
  }): Promise<{ message: string }> => {
    const response = await api.put<{ message: string }>('/settings/smtp', data);
    return response.data;
  },
};

// Replies (Inbox)
export interface ReplyListItem {
  id: number;
  campaignId: number;
  recipientId: number;
  campaignName: string;
  recipientEmail: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
}

export interface ReplyDetail extends ReplyListItem {
  bodyText: string | null;
  bodyHtml: string | null;
}

export const repliesApi = {
  getReplies: async (params?: { page?: number; limit?: number; campaignId?: number }): Promise<{ replies: ReplyListItem[]; total: number }> => {
    const sp = new URLSearchParams();
    if (params?.page != null) sp.set('page', String(params.page));
    if (params?.limit != null) sp.set('limit', String(params.limit));
    if (params?.campaignId != null) sp.set('campaignId', String(params.campaignId));
    const q = sp.toString();
    const response = await api.get<{ replies: ReplyListItem[]; total: number }>(`/replies${q ? `?${q}` : ''}`);
    return response.data;
  },
  getReplyById: async (id: number): Promise<ReplyDetail> => {
    const response = await api.get<ReplyDetail>(`/replies/${id}`);
    return response.data;
  },
};

export default api;
