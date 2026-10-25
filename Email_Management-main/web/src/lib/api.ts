import axios from 'axios';
import type { ReplyLabel, ReplyLabelSource } from './replyLabels';
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
  FollowUpAnalyticsResponse,
  FollowUpEngagement,
  FollowUpJobRow,
  FollowUpJobAnalyticsResponse,
} from '../types';
import type { AgentStructuredResult } from './agentMessage';
import type { SavedScript, ScriptCompaniesPage, ScriptCompanyDetail, ScriptFileSummary, ScriptType } from './scripts';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

/**
 * Monotonically-increasing counter that is bumped on every logout / account
 * switch (via clearUserScopedState → incrementSessionGeneration).
 * Every outgoing request is stamped with the current value; responses whose
 * stamp no longer matches are silently discarded so stale data from a previous
 * session can never overwrite the new user's store state.
 */
let _sessionGeneration = 0;

export function incrementSessionGeneration(): void {
  _sessionGeneration++;
}

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
  // Prevent the browser from returning a cached response after logout/login.
  config.headers['Cache-Control'] = 'no-cache';
  config.headers['Pragma'] = 'no-cache';
  // Stamp every request with the current session generation so the response
  // interceptor can discard replies that belong to a previous session.
  (config as Record<string, unknown>).__sessionGeneration = _sessionGeneration;
  return config;
});

/** Returns a Promise that never settles — used to silently drop stale responses. */
const _staleResponse = (): Promise<never> => new Promise(() => {});

api.interceptors.response.use(
  (res) => {
    // Discard responses from a previous session (e.g., in-flight when the user
    // logged out or switched accounts).  The awaiting store function will remain
    // suspended but its closure is garbage-collected once the component unmounts.
    if ((res.config as Record<string, unknown>).__sessionGeneration !== _sessionGeneration) {
      return _staleResponse();
    }
    return res;
  },
  (err) => {
    // Also drop errors (network timeouts, 5xx, etc.) from an old session so
    // they don't surface as error toasts for the newly-logged-in user.
    const reqGen = (err?.config as Record<string, unknown> | undefined)?.__sessionGeneration;
    if (reqGen !== undefined && reqGen !== _sessionGeneration) {
      return _staleResponse();
    }

    if (err.response?.status === 401) {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
      } catch {}
      // Dynamic import avoids a circular dependency (api -> sessionReset -> stores -> api).
      void import('./sessionReset')
        .then(({ clearUserScopedState }) => clearUserScopedState())
        .catch(() => {});
      const path = window.location.pathname || '';
      if (
        !path.startsWith('/login') &&
        !path.startsWith('/signup')
      ) {
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
  start: async (
    id: number,
    opts?: { force?: boolean }
  ): Promise<{ status: 'scheduled' | 'in_progress'; message: string }> => {
    const response = await api.post<{ status: 'scheduled' | 'in_progress'; message: string }>(`/campaigns/${id}/start`, {
      force: opts?.force === true,
    });
    return response.data;
  },

  // Pause campaign
  pause: async (id: number): Promise<{ message: string; code?: string }> => {
    const response = await api.post<{ message: string; code?: string }>(`/campaigns/${id}/pause`);
    return response.data;
  },

  // Resume campaign
  resume: async (id: number, opts?: { force?: boolean }): Promise<{ message: string; code?: string }> => {
    const response = await api.post<{ message: string; code?: string }>(`/campaigns/${id}/resume`, {
      force: opts?.force === true,
    });
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

  // Get one recipient (includes custom fields for token preview)
  getRecipientById: async (
    campaignId: number,
    recipientId: number
  ): Promise<{ id: number; campaignId: number; email: string; name: string | null; customFields: string | null }> => {
    const response = await api.get<{ id: number; campaignId: number; email: string; name: string | null; customFields: string | null }>(
      `/campaigns/${campaignId}/recipients/${recipientId}`
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
    followUpJobId?: number;
  }): Promise<DashboardStats> => {
    const sp = new URLSearchParams();
    if (params?.view) sp.set('view', params.view);
    if (params?.followUpJobId != null && params.followUpJobId > 0) {
      sp.set('followUpJobId', String(params.followUpJobId));
    }
    if (params?.campaignIds && params.campaignIds.length > 0) {
      sp.set('campaignIds', params.campaignIds.join(','));
    }
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
  /** Max sends per calendar day for this SMTP profile; null = unlimited, 0 = block all sending, 1-50 = cap */
  dailyEmailLimit?: number | null;
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
    dailyEmailLimit?: number | null;
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
      dailyEmailLimit?: number | null;
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
    dailyEmailLimit?: number | null;
  }): Promise<{ message: string }> => {
    const response = await api.put<{ message: string }>('/settings/smtp', data);
    return response.data;
  },
};

export interface UserNotificationRow {
  id: number;
  userId: number;
  type: string;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
  /** Same moment as createdAt, as a real UTC ISO time (CRM step 6). */
  createdAtIso?: string;
}

export const userApi = {
  getNotifications: async (): Promise<{ notifications: UserNotificationRow[]; unreadCount: number }> => {
    const response = await api.get<{ notifications: UserNotificationRow[]; unreadCount: number }>('/user/notifications');
    return response.data;
  },
  markNotificationsReadAll: async (): Promise<{ message: string }> => {
    const response = await api.post<{ message: string }>('/user/notifications/read-all');
    return response.data;
  },
  /** CRM step 6: mark one notification read (clicked in the bell). */
  markNotificationRead: async (id: number): Promise<{ ok: true; updated: number }> => {
    const response = await api.post<{ ok: true; updated: number }>(`/user/notifications/${id}/read`);
    return response.data;
  },
  getSmtpQuota: async (): Promise<{
    profiles: Array<{
      smtpSettingsId: number;
      fromEmail: string;
      dailyLimit: number;
      sentToday: number;
      remaining: number | null;
    }>;
  }> => {
    const response = await api.get<{
      profiles: Array<{
        smtpSettingsId: number;
        fromEmail: string;
        dailyLimit: number;
        sentToday: number;
        remaining: number | null;
      }>;
    }>('/user/smtp-quota');
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
  /** CRM label of the newest labeled inbound reply in this thread. */
  label?: ReplyLabel | null;
}

export interface ReplyThreadMessage {
  id: number;
  direction: string;
  fromEmail: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: string;
  /** CRM label (inbound messages only). */
  label?: ReplyLabel | null;
  labelSource?: ReplyLabelSource | null;
  labelConfidence?: number | null;
}

export interface ReplyLabelUpdateResult {
  id: number;
  label: ReplyLabel;
  labelSource: 'manual';
  labelConfidence: number;
  labeledAt: string;
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
    /** Only threads whose label is one of these. */
    labels?: ReplyLabel[];
    /** 'interested' (default on the server) = Interested threads first; 'newest' = plain newest first. */
    sort?: 'interested' | 'newest';
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
    if (params?.labels && params.labels.length > 0) sp.set('labels', params.labels.join(','));
    if (params?.sort) sp.set('sort', params.sort);
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
  /** Manual label override (CRM step 2). */
  updateLabel: async (id: number, label: ReplyLabel): Promise<ReplyLabelUpdateResult> => {
    const response = await api.patch<ReplyLabelUpdateResult>(`/replies/${id}/label`, { label });
    return response.data;
  },
};

// ─── CRM: Pipeline Builder (step 4) ─────────────────────────────────────────

export interface CrmConditionLeaf {
  field: string;
  operator: string;
  value?: unknown;
}
export interface CrmConditionGroup {
  op: 'AND' | 'OR';
  items: Array<CrmConditionLeaf | CrmConditionGroup>;
}
export type CrmRuleAction =
  | { type: 'move_to_stage'; stageId: number }
  | { type: 'add_tag'; tagId: number }
  | { type: 'remove_tag'; tagId: number }
  | { type: 'stop_follow_ups' }
  | { type: 'schedule_follow_up'; afterDays: number; templateId: string | null }
  | { type: 'notify_user'; message: string }
  | { type: 'add_score'; points: number };

export interface CrmPipelineSummary {
  id: number;
  name: string;
  isDefault: boolean;
  createdAt: string;
  stageCount: number;
  ruleCount: number;
  contactCount: number;
}
export interface CrmStage {
  id: number;
  pipelineId: number;
  name: string;
  color: string;
  position: number;
  type: 'normal' | 'won' | 'lost';
  manualOnly: boolean;
  stopFollowUps: boolean;
  contactCount: number;
}
export interface CrmRule {
  id: number;
  pipelineId: number;
  fromStageId: number | null;
  name: string;
  priority: number;
  isActive: boolean;
  trigger: string;
  conditions: CrmConditionGroup;
  actions: CrmRuleAction[];
  forwardOnly: boolean;
  createdAt: string;
  updatedAt: string;
}
export type CrmRuleInput = Omit<CrmRule, 'id' | 'pipelineId' | 'createdAt' | 'updatedAt'>;
export interface CrmPipelineTemplate {
  key: string;
  label: string;
  description: string;
  stages: string[];
  ruleCount: number;
}
export interface CrmTag {
  id: number;
  name: string;
  color: string;
  /** 'both' | 'contact' (leads only) | 'campaign' (campaigns only). Missing on the rule-editor list. */
  scope?: 'both' | 'contact' | 'campaign';
  contactCount?: number;
  campaignCount?: number;
}
export interface CrmContactLookup {
  id: number;
  email: string;
  name: string | null;
  stageName: string | null;
}
export interface CrmRuleTestResult {
  ruleId: number;
  name: string;
  trigger: string;
  priority: number;
  isActive: boolean;
  appliesToStage: boolean;
  conditionsMatch: boolean;
  move: { toStageId: number; toStageName: string | null; allowed: boolean; reason: string | null } | null;
  otherActions: string[];
  wins: boolean;
}

export const crmApi = {
  getTemplates: async (): Promise<CrmPipelineTemplate[]> =>
    (await api.get<{ templates: CrmPipelineTemplate[] }>('/crm/pipeline-templates')).data.templates,
  getPipelines: async (): Promise<CrmPipelineSummary[]> =>
    (await api.get<{ pipelines: CrmPipelineSummary[] }>('/crm/pipelines')).data.pipelines,
  getPipeline: async (id: number): Promise<{ pipeline: { id: number; name: string; isDefault: boolean }; stages: CrmStage[]; rules: CrmRule[] }> =>
    (await api.get(`/crm/pipelines/${id}`)).data,
  createPipeline: async (body: { name: string; template: string; makeDefault?: boolean }): Promise<{ id: number }> =>
    (await api.post<{ id: number }>('/crm/pipelines', body)).data,
  updatePipeline: async (id: number, body: { name?: string; isDefault?: boolean }) =>
    (await api.patch(`/crm/pipelines/${id}`, body)).data,
  deletePipeline: async (id: number, moveToStageId?: number): Promise<{ ok: true; moved: number }> =>
    (await api.delete(`/crm/pipelines/${id}`, { params: moveToStageId ? { moveToStageId } : {} })).data,

  createStage: async (pipelineId: number, body: Partial<CrmStage>): Promise<CrmStage> =>
    (await api.post<{ stage: CrmStage }>(`/crm/pipelines/${pipelineId}/stages`, body)).data.stage,
  updateStage: async (pipelineId: number, stageId: number, body: Partial<CrmStage>): Promise<CrmStage> =>
    (await api.patch<{ stage: CrmStage }>(`/crm/pipelines/${pipelineId}/stages/${stageId}`, body)).data.stage,
  reorderStages: async (pipelineId: number, stageIds: number[]): Promise<CrmStage[]> =>
    (await api.patch<{ stages: CrmStage[] }>(`/crm/pipelines/${pipelineId}/stages/reorder`, { stageIds })).data.stages,
  deleteStage: async (pipelineId: number, stageId: number, moveToStageId?: number): Promise<{ ok: true; moved: number; rulesTurnedOff: number }> =>
    (await api.delete(`/crm/pipelines/${pipelineId}/stages/${stageId}`, { params: moveToStageId ? { moveToStageId } : {} })).data,

  createRule: async (pipelineId: number, body: CrmRuleInput): Promise<CrmRule> =>
    (await api.post<{ rule: CrmRule }>(`/crm/pipelines/${pipelineId}/rules`, body)).data.rule,
  updateRule: async (pipelineId: number, ruleId: number, body: Partial<CrmRuleInput>): Promise<CrmRule> =>
    (await api.patch<{ rule: CrmRule }>(`/crm/pipelines/${pipelineId}/rules/${ruleId}`, body)).data.rule,
  deleteRule: async (pipelineId: number, ruleId: number) =>
    (await api.delete(`/crm/pipelines/${pipelineId}/rules/${ruleId}`)).data,
  testRules: async (
    pipelineId: number,
    body: { contactId: number; trigger?: string; label?: string }
  ): Promise<{ contact: { id: number; email: string; name: string | null; stageId: number | null; stageName: string | null }; results: CrmRuleTestResult[] }> =>
    (await api.post(`/crm/pipelines/${pipelineId}/rules/test`, body)).data,

  lookupContacts: async (pipelineId: number, search: string): Promise<CrmContactLookup[]> =>
    (await api.get<{ contacts: CrmContactLookup[] }>('/crm/contacts/lookup', { params: { pipelineId, search } })).data.contacts,
  getTags: async (): Promise<CrmTag[]> => (await api.get<{ tags: CrmTag[] }>('/crm/tags')).data.tags,

  // ── Step 5: tags on campaigns and leads ──
  listAllTags: async (): Promise<{ tags: CrmTag[]; colors: string[] }> => (await api.get('/tags')).data,
  createTag: async (body: { name: string; color?: string; scope?: CrmTag['scope'] }): Promise<CrmTag> =>
    (await api.post<{ tag: CrmTag }>('/tags', body)).data.tag,
  updateTag: async (id: number, body: Partial<Pick<CrmTag, 'name' | 'color' | 'scope'>>): Promise<CrmTag> =>
    (await api.patch<{ tag: CrmTag }>(`/tags/${id}`, body)).data.tag,
  deleteTag: async (id: number): Promise<{ ok: true; rulesTurnedOff: number }> => (await api.delete(`/tags/${id}`)).data,

  addCampaignTag: async (campaignId: number, tagId: number) => (await api.post(`/campaigns/${campaignId}/tags/${tagId}`)).data,
  removeCampaignTag: async (campaignId: number, tagId: number) => (await api.delete(`/campaigns/${campaignId}/tags/${tagId}`)).data,
  getCampaignTagMap: async (): Promise<{ tags: CrmTag[]; campaigns: Record<string, number[]> }> =>
    (await api.get('/crm/campaign-tags')).data,
  getCampaignCrm: async (campaignId: number): Promise<CrmCampaignSummary> => (await api.get(`/crm/campaigns/${campaignId}`)).data,
  saveCampaignSettings: async (campaignId: number, body: CrmCampaignSettings): Promise<{ settings: CrmCampaignSettings; tagged: number }> =>
    (await api.put(`/crm/campaigns/${campaignId}/settings`, body)).data,

  listContacts: async (params: CrmContactFilters): Promise<{ contacts: CrmContact[]; total: number; limit: number; offset: number; page: number }> =>
    (await api.get('/crm/contacts', { params: crmFilterParams(params) })).data,
  // ── Step 8: dashboard ──
  getSummary: async (params: CrmContactFilters): Promise<CrmSummary> => (await api.get('/crm/summary', { params: crmFilterParams(params) })).data,
  moveContactStage: async (contactId: number, stageId: number): Promise<{ ok: true; moved: boolean; stage: { id: number; pipelineId: number; name: string; color: string; type: string } }> =>
    (await api.patch(`/crm/contacts/${contactId}/stage`, { stageId })).data,
  /** CSV of the filtered leads, as a file download. */
  exportContactsCsv: async (params: CrmContactFilters): Promise<Blob> =>
    (await api.get('/crm/contacts/export', { params: crmFilterParams(params), responseType: 'blob' })).data as Blob,
  getContact: async (id: number): Promise<CrmContactDetail> => (await api.get(`/crm/contacts/${id}`)).data,
  addContactTag: async (contactId: number, tagId: number) => (await api.post(`/crm/contacts/${contactId}/tags/${tagId}`)).data,
  removeContactTag: async (contactId: number, tagId: number) => (await api.delete(`/crm/contacts/${contactId}/tags/${tagId}`)).data,
  // ── Step 6: needs-reply reminders ──
  getCrmSettings: async (): Promise<CrmSettings> => (await api.get<CrmSettings>('/crm/settings')).data,
  saveCrmSettings: async (body: Partial<Pick<CrmSettings, 'needsReplyAfterHours' | 'reminderEmailDigest'>>): Promise<CrmSettings> =>
    (await api.put<CrmSettings>('/crm/settings', body)).data,
  getNeedsReply: async (includeSnoozed = false): Promise<{ leads: CrmWaitingLead[]; counts: { waiting: number; overdue: number; snoozed: number } }> =>
    (await api.get('/crm/needs-reply', { params: includeSnoozed ? { includeSnoozed: 1 } : {} })).data,
  snoozeContact: async (contactId: number, until: Date): Promise<{ ok: true; snoozedUntil: string }> =>
    (await api.post(`/crm/contacts/${contactId}/snooze`, { until: until.toISOString() })).data,
  markNeedsReplyDone: async (contactId: number): Promise<{ ok: true }> => (await api.post(`/crm/contacts/${contactId}/needs-reply/done`)).data,

  // ── Step 7: lead scoring ──
  getScoring: async (): Promise<CrmScoring> => (await api.get<CrmScoring>('/crm/scoring')).data,
  saveScoring: async (body: { weights?: CrmScoreWeights; hotThreshold?: number; warmThreshold?: number }): Promise<CrmScoring> =>
    (await api.put<CrmScoring>('/crm/scoring', body)).data,
  startScoreRecalc: async (): Promise<CrmRecalcJob> => (await api.post<{ job: CrmRecalcJob }>('/crm/scoring/recalculate')).data.job,
  getScoreRecalc: async (): Promise<CrmRecalcJob | null> => (await api.get<{ job: CrmRecalcJob | null }>('/crm/scoring/recalculate')).data.job,

  bulkUpdateContacts: async (body: {
    contactIds: number[];
    addTagIds?: number[];
    removeTagIds?: number[];
    moveToStageId?: number;
  }): Promise<{ ok: true; matched: number; skipped: number; tagsAdded: number; tagsRemoved: number; moved: number }> =>
    (await api.post('/crm/contacts/bulk', body)).data,
};

export interface CrmSettings {
  needsReplyAfterHours: number;
  reminderEmailDigest: boolean;
  lastDigestSentAt: string | null;
  /** Server hour (0-23) from which the daily email is sent. */
  digestHour: number;
  smtpConfigured: boolean;
  limits: { minHours: number; maxHours: number };
}
export interface CrmWaitingLead {
  contactId: number;
  email: string;
  name: string | null;
  company: string | null;
  score: number;
  scoreTier: string;
  stageName: string | null;
  stageColor: string | null;
  since: string;
  waitingHours: number;
  dueHours: number;
  overdue: boolean;
  priority: 'high' | 'normal';
  snoozedUntil: string | null;
  reminded: boolean;
  replyId: number | null;
  threadRootId: number | null;
  label: string | null;
  subject: string | null;
  snippet: string;
}

export interface CrmCampaignSettings {
  /** null = the default pipeline */
  pipelineId: number | null;
  autoTagIds: number[];
}
export interface CrmCampaignSummary {
  campaign: { id: number; name: string };
  tags: CrmTag[];
  settings: CrmCampaignSettings;
  /** Leads per latest reply label: { interested: 3, ... } */
  labels: Record<string, number>;
  labeledLeads: number;
  leadCount: number;
}
export interface CrmContactFilters {
  pipelineId?: number;
  stageId?: number;
  tagIds?: number[];
  /** One or more reply labels, comma separated; 'none' = no reply yet. */
  label?: string;
  campaignId?: number;
  /** hot / warm / cold, comma separated (step 8) */
  scoreTier?: string;
  /** Only leads waiting for your reply (step 8) */
  needsReply?: boolean;
  /** Interested or hot (Hot Leads panel, step 8) */
  hotOnly?: boolean;
  /** Lead added to the CRM, YYYY-MM-DD (step 8) */
  from?: string;
  to?: string;
  search?: string;
  sort?: 'recent' | 'score' | 'name' | 'hot' | 'waiting' | 'added';
  limit?: number;
  offset?: number;
  page?: number;
}

/** Query string for the lead filters (lists joined with commas, flags as 1). */
export function crmFilterParams(f: CrmContactFilters): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v.join(',');
    } else if (v === true) out[k] = 1;
    else out[k] = v as string | number;
  }
  return out;
}

// ─── CRM dashboard (step 8) ─────────────────────────────────────────────────

export interface CrmSummary {
  pipeline: { id: number; name: string } | null;
  kpis: { total: number; interested: number; meetings: number; won: number; lost: number; winRate: number | null; needsReply: number; hot: number } | null;
  stages: Array<{ id: number; name: string; color: string; type: string; position: number; count: number; avgDaysInStage: number | null }>;
  labels: Record<string, number>;
  funnel: Array<{ stageId: number; name: string; color: string; type: string; reached: number; conversionFromPrev: number | null }>;
}
export interface CrmTimelineItem {
  type: 'sent' | 'opened' | 'reply' | 'you_replied' | 'follow_up' | 'stage' | 'score';
  at: string;
  title: string;
  detail: string | null;
  label: string | null;
  points: number | null;
  campaignId: number | null;
  replyId: number | null;
  threadRootId: number | null;
}
export interface CrmContact {
  id: number;
  email: string;
  name: string | null;
  company: string | null;
  pipelineId: number | null;
  stageId: number | null;
  stageName: string | null;
  stageColor: string | null;
  stageType: string | null;
  score: number;
  scoreTier: string;
  lastReplyLabel: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  needsReply: boolean;
  /** When the lead started waiting for your reply (step 8 cards: "waiting 5h"). */
  needsReplySince?: string | null;
  snoozedUntil?: string | null;
  addedAt?: string;
  followUpsStopped: boolean;
  openCount: number;
  campaignCount: number;
  updatedAt: string;
  tags: CrmTag[];
}
export interface CrmContactDetail {
  contact: CrmContact & {
    customFields: Record<string, string>;
    notes: string | null;
    pipelineName: string | null;
    stageEnteredAt: string | null;
    createdAt: string;
  };
  campaigns: Array<{ id: number; name: string; recipientId: number; status: string; sentAt: string | null; openedAt: string | null; repliedAt: string | null }>;
  replies: Array<{ id: number; campaignId: number; subject: string; snippet: string; direction: string; label: string | null; labelSource: string | null; receivedAt: string; threadRootId?: number }>;
  /** Step 8: emails sent, opens, replies, stage moves and score changes, newest first. */
  timeline?: CrmTimelineItem[];
  history: Array<{ id: number; fromStageId: number | null; fromName: string | null; toStageId: number | null; toName: string | null; reason: string | null; ruleId: number | null; ruleName: string | null; at: string }>;
  /** Step 7: "why this score" (current parts) and the latest score changes. */
  score?: { breakdown: CrmScoreItem[]; updatedAt: string | null; events: CrmScoreEvent[] };
}

// ─── CRM: lead scoring (step 7) ─────────────────────────────────────────────

export interface CrmScoreItem {
  key: string;
  source: string;
  label: string;
  points: number;
}
export interface CrmScoreEvent {
  id: number;
  points: number;
  reason: string;
  source: string;
  at: string;
}
export interface CrmScoreWeights {
  email_opened: number;
  email_opened_max: number;
  reply_received: number;
  labels: Record<string, number>;
  follow_up_no_reply: number;
  inactivity: number;
  inactivity_days: number;
  tags: Record<string, number>;
  custom_fields: Array<{ field: string; equals: string; points: number }>;
}
export interface CrmRecalcJob {
  total: number;
  done: number;
  changed: number;
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}
export interface CrmScoring {
  weights: CrmScoreWeights;
  hotThreshold: number;
  warmThreshold: number;
  defaults: { weights: CrmScoreWeights; hotThreshold: number; warmThreshold: number };
  tags: Array<{ id: number; name: string; color: string }>;
  customFieldNames: string[];
  job: CrmRecalcJob | null;
}

/** Error text from an API error (axios), for toasts. */
export function apiErrorMessage(e: unknown, fallback: string): string {
  const msg = e && typeof e === 'object' && 'response' in e
    ? (e as { response?: { data?: { error?: string } } }).response?.data?.error
    : undefined;
  return typeof msg === 'string' && msg.length > 0 ? msg : fallback;
}

// Auth API
export type PreferredTheme = 'light' | 'dark' | 'system';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
  preferredTheme?: PreferredTheme;
  plan?: {
    code: string;
    name: string;
    smtpLimit: number;
    dailyEmailLimit: number;
    inboxEnabled: boolean;
    followUpEnabled: boolean;
    /** CRM module (plans.crm_enabled). */
    crmEnabled?: boolean;
  } | null;
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

export const followUpApi = {
  listJobs: async (params?: { campaignId?: number }): Promise<{ jobs: FollowUpJobRow[] }> => {
    const sp = new URLSearchParams();
    if (params?.campaignId != null && params.campaignId > 0) {
      sp.set('campaignId', String(params.campaignId));
    }
    const q = sp.toString();
    const response = await api.get<{ jobs: FollowUpJobRow[] }>(
      `/follow-up-jobs${q ? `?${q}` : ''}`
    );
    return response.data;
  },

  getJobAnalytics: async (jobId: number): Promise<FollowUpJobAnalyticsResponse> => {
    const response = await api.get<FollowUpJobAnalyticsResponse>(`/follow-up-analytics/jobs/${jobId}`);
    return response.data;
  },

  createJob: async (payload: {
    campaignId: number;
    scheduledAt: string;
    templateId: string;
    priorFollowUpCount: number;
    engagement: FollowUpEngagement;
    /** Optional: stop after N minutes from when the job starts running (1–10080) */
    maxRunMinutes?: number | null;
    /** Optional: ISO weekdays 1–7 when sends may run */
    sendWeekdays?: number[] | null;
  }): Promise<{ job: FollowUpJobRow }> => {
    const response = await api.post<{ job: FollowUpJobRow }>('/follow-up-jobs', payload);
    return response.data;
  },

  cancelJob: async (id: number): Promise<{ ok: boolean }> => {
    const response = await api.delete<{ ok: boolean }>(`/follow-up-jobs/${id}`);
    return response.data;
  },

  stopJob: async (id: number): Promise<{ ok: boolean; stoppedId?: number }> => {
    const response = await api.post<{ ok: boolean; stoppedId?: number }>(`/follow-up-jobs/${id}/stop`);
    return response.data;
  },

  retryJob: async (id: number): Promise<{ ok: boolean; resumedId?: number }> => {
    const response = await api.post<{ ok: boolean; resumedId?: number }>(`/follow-up-jobs/${id}/retry`);
    return response.data;
  },

  previewCount: async (params: {
    campaignId: number;
    templateId: string;
    priorFollowUpCount: number;
    engagement: FollowUpEngagement;
  }): Promise<{ count: number }> => {
    const sp = new URLSearchParams();
    sp.set('campaignId', String(params.campaignId));
    sp.set('templateId', params.templateId);
    sp.set('priorFollowUpCount', String(params.priorFollowUpCount));
    sp.set('engagement', params.engagement);
    const response = await api.get<{ count: number }>(`/follow-up-jobs/preview-count?${sp.toString()}`);
    return response.data;
  },

  getAnalytics: async (campaignIds: number[]): Promise<FollowUpAnalyticsResponse> => {
    const sp = new URLSearchParams();
    if (campaignIds.length > 0) sp.set('campaignIds', campaignIds.join(','));
    const q = sp.toString();
    const response = await api.get<FollowUpAnalyticsResponse>(
      `/follow-up-analytics${q ? `?${q}` : ''}`
    );
    return response.data;
  },
};

type AgentChatPayload = {
  approvalRequired?: boolean;
  sessionId?: string;
  /** Legacy plain-text response (approval prompts, workflow errors, plan confirmations). */
  response?: string;
  /** Normalised structured result from a regular chat turn. Always has `message`. */
  result?: AgentStructuredResult;
  message?: string;
  pendingAction?: AgentPendingAction;
};

export const agentApi = {
  /** Sends the user's prompt together with an attached CSV/XLSX file (multipart). */
  chatWithFile: async (
    message: string,
    file: File,
    sessionId?: string
  ): Promise<AgentResult<AgentChatPayload>> => {
    try {
      const form = new FormData();
      form.append('message', message);
      if (sessionId) form.append('sessionId', sessionId);
      form.append('file', file);
      // Override the instance's JSON default — otherwise axios serialises the
      // FormData to JSON. The browser then fills in the multipart boundary.
      const { data } = await agentHttp.post('/chat', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (!data?.success) {
        return { success: false, error: data?.error?.message ?? 'Agent chat failed.' };
      }
      return { success: true, data: data.data };
    } catch (err) {
      return { success: false, error: mapAgentError(err) };
    }
  },

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
  ): Promise<AgentResult<{ response?: string; error?: boolean; toolResult?: { data: unknown; isToolError: boolean } }>> => {
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

/** Script generation — saved company lists (backend) + on-demand scripts (agent). */
export const scriptsApi = {
  listFiles: async (): Promise<ScriptFileSummary[]> => {
    const response = await api.get<{ files: ScriptFileSummary[] }>('/script-files');
    return response.data.files;
  },

  listCompanies: async (fileId: number, page: number, limit = 50): Promise<ScriptCompaniesPage> => {
    const response = await api.get<ScriptCompaniesPage>(`/script-files/${fileId}/companies`, { params: { page, limit } });
    return response.data;
  },

  getCompany: async (companyId: number): Promise<ScriptCompanyDetail> => {
    const response = await api.get<ScriptCompanyDetail>(`/script-companies/${companyId}`);
    return response.data;
  },

  deleteFile: async (fileId: number): Promise<void> => {
    await api.delete(`/script-files/${fileId}`);
  },

  /** Generates (or returns the saved) script. regenerate=true always writes a new one. */
  generate: async (
    companyId: number,
    type: ScriptType,
    regenerate = false,
  ): Promise<AgentResult<{ script: SavedScript; cached: boolean }>> => {
    try {
      const { data } = await agentHttp.post(`/scripts/companies/${companyId}/generate`, { type, regenerate });
      return data?.success ? { success: true, data: data.data } : { success: false, error: data?.error?.message ?? 'Could not generate the script.' };
    } catch (err) {
      return { success: false, error: mapAgentError(err) };
    }
  },
};

export interface PlanInfo {
  code: string;
  name: string;
  smtpLimit: number;
  dailyEmailLimit: number;
  inboxEnabled: boolean;
  followUpEnabled: boolean;
  stripePriceId: string | null;
  priceUsd: string;
}

export const paymentApi = {
  getPlans: async (): Promise<{ plans: PlanInfo[] }> => {
    const response = await api.get<{ plans: PlanInfo[] }>('/plans');
    return response.data;
  },
  createCheckoutSession: async (body: {
    name: string;
    email: string;
    password: string;
    planCode: 'basic' | 'standard' | 'premium';
  }): Promise<{ url: string }> => {
    const response = await api.post<{ url: string }>('/payment/checkout', body);
    return response.data;
  },
  getCheckoutStatus: async (sessionId: string): Promise<{
    status: string;
    paymentStatus: string;
    email: string | null;
  }> => {
    const response = await api.get<{ status: string; paymentStatus: string; email: string | null }>(
      `/payment/checkout-status?session_id=${encodeURIComponent(sessionId)}`
    );
    return response.data;
  },
  createCustomerPortal: async (): Promise<{ url: string }> => {
    const response = await api.post<{ url: string }>('/payment/customer-portal');
    return response.data;
  },
};

export default api;
