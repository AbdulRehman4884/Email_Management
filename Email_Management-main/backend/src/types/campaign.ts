export type CampaignStatus = 'draft' | 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

export interface FollowUpTemplate {
  id: string;
  title: string;
  subject: string;
  body: string;
}

export interface Campaign {
  id: number;
  userId: number;
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
  autoPauseAfterMinutes?: number | null;
  /** ISO weekdays 1–7 (Mon–Sun); null = any day */
  sendWeekdays?: number[] | null;
  availableColumns?: string | null;
  followUpTemplates?: FollowUpTemplate[];
  followUpSkipConfirm?: boolean;
  dailySendLimit?: number | null;
  pauseReason?: string | null;
  pausedAt?: string | null;
}