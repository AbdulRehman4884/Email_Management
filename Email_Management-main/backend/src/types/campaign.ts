export type CampaignStatus = 'draft' | 'scheduled' | 'in_progress' | 'paused' | 'completed' | 'cancelled';

export interface Campaign {
  id: number;
  userId: number;
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
  availableColumns?: string | null;
}