// Campaign Types
export interface FollowUpTemplate {
  id: string;
  title: string;
  subject: string;
  body: string;
}

export interface Campaign {
  id: number;
  smtpSettingsId?: number | null;
  name: string;
  subject: string;
  emailContent: string;
  fromName: string;
  fromEmail: string;
  status: CampaignStatus;
  recieptCount: number;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  pauseAt: string | null;
  /** Minutes from send start; effective pause time is computed when sending begins */
  autoPauseAfterMinutes?: number | null;
  availableColumns?: string | null;
  followUpTemplates?: FollowUpTemplate[];
  /** When true, Sent tab sends follow-ups without opening the compose modal. */
  followUpSkipConfirm?: boolean;
  /** ISO weekdays 1–7 when sends may run; null = every day */
  sendWeekdays?: number[] | null;
  /** Optional max emails per day for this campaign (spread over days); null = only SMTP daily limit applies */
  dailySendLimit?: number | null;
  pauseReason?: string | null;
  pausedAt?: string | null;
}

export type FollowUpEngagement = 'sent' | 'opened' | 'delivered';

export type FollowUpJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface FollowUpJobRow {
  id: number;
  userId: number;
  campaignId: number;
  scheduledAt: string;
  status: FollowUpJobStatus;
  templateId: string;
  priorFollowUpCount: number;
  engagement: FollowUpEngagement;
  /** Stop bulk sends after this many minutes from job start; null = no limit */
  maxRunMinutes?: number | null;
  pausedCampaignWasRunning: boolean;
  /** ISO weekdays 1–7 when sends may run; null = every day */
  sendWeekdays?: number[] | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  campaignName?: string;
}

export interface FollowUpBucketCounts {
  0: number;
  1: number;
  2: number;
  3: number;
  4: number;
  /** Recipients with five or more follow-ups sent */
  5: number;
}

/** Totals for the current analytics scope (selected campaigns or all). */
export interface FollowUpAnalyticsScopeSummary {
  recipientTotal: number;
  primarySent: number;
  opened: number;
  replied: number;
}

export interface FollowUpAnalyticsCampaignRow {
  id: number;
  name: string;
  buckets: FollowUpBucketCounts;
  summary: FollowUpAnalyticsScopeSummary;
}

export interface FollowUpAnalyticsResponse {
  campaigns: FollowUpAnalyticsCampaignRow[];
  bucketsByCampaign: Record<number, FollowUpBucketCounts>;
  campaignsWithActivity: Array<{ id: number; name: string; followUpOutboundTotal: number }>;
  scopeSummary: FollowUpAnalyticsScopeSummary;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

export type TemplateId = 'simple' | 'announcement' | 'newsletter';

export interface CreateCampaignPayload {
  name: string;
  subject: string;
  emailContent?: string;
  templateId?: TemplateId;
  templateData?: Record<string, unknown>;
  /** Required: which saved SMTP profile sends this campaign */
  smtpSettingsId: number;
  fromName?: string;
  fromEmail?: string;
  scheduledAt?: string | null;
  pauseAt?: string | null;
  /** Omit or null to clear; positive integer minutes */
  autoPauseAfterMinutes?: number | null;
  /** ISO weekdays 1–7 (Mon–Sun); omit/null = send any day */
  sendWeekdays?: number[] | null;
  dailySendLimit?: number | null;
}

export interface UpdateCampaignPayload extends Partial<CreateCampaignPayload> {
  status?: CampaignStatus;
}

// Recipient Types
export interface Recipient {
  id: number;
  campaignId: number;
  email: string;
  name: string | null;
  status: RecipientStatus;
  messageId: string | null;
  sentAt: string | null;
  delieveredAt: string | null;
  openedAt?: string | null;
  repliedAt?: string | null;
}

export type RecipientStatus = 'pending' | 'sent' | 'delivered' | 'bounced' | 'failed' | 'complained';

// Stats Types
export interface CampaignStats {
  id: number;
  campaignId: number;
  sentCount: number;
  delieveredCount: number;
  bouncedCount: number;
  failedCount: number;
  complainedCount: number;
  openedCount?: number;
  repliedCount?: number;
}

// API Response Types
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface UploadResponse {
  success: boolean;
  added: number;
  rejected: number;
  message?: string;
  addedCount?: number;
  rejectedCount?: number;
  availableColumns?: string[];
}

export interface PlaceholderValidation {
  valid: boolean;
  missingColumns: string[];
  usedPlaceholders: string[];
  availableColumns: string[];
}

// Dashboard Stats
export interface DashboardStats {
  totalCampaigns: number;
  activeCampaigns: number;
  totalEmailsSent: number;
  totalDelivered: number;
  totalBounces: number;
  totalComplaints: number;
  totalFailed: number;
  totalOpened?: number;
  totalReplied?: number;
  averageDeliveryRate: number;
  /** Recipient rows in DB for the filtered campaign set (denominator aligned with totalEmailsSent). */
  totalRecipientCountInScope?: number;
  timeSeries?: Array<{
    day: string;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
  }>;
}
