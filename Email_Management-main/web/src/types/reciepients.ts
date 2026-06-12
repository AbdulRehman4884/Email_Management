interface Recipients {
    campaignId: number;
    email: string;
    name: string | null;
    customFields?: Record<string, string> | null;
    status: 'pending' | 'sent' | 'failed';
}