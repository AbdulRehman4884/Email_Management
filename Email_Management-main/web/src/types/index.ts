// Campaign Types
export interface Campaign {
  id: number;
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
}

export type CampaignStatus = 'draft' | 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

export type TemplateId = 'simple' | 'announcement' | 'newsletter';

export interface CreateCampaignPayload {
  name: string;
  subject: string;
  emailContent?: string;
  templateId?: TemplateId;
  templateData?: Record<string, unknown>;
  fromName: string;
  fromEmail: string;
  scheduledAt?: string | null;
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
  timeSeries?: Array<{
    day: string;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
  }>;
}
