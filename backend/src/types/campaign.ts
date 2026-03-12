
export interface Campaign {
    id: number;
    name: string;
    subject: string;
    emailContent: string;
    fromName: string;
    fromEmail: string;
    status: 'draft' | 'scheduled' | 'sent' | 'paused';
    recieptCount: number;
    createdAt: string;
    scheduledAt: string | null;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sent' | 'paused';