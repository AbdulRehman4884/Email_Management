interface Recipients {
    campaignId: number;
    email: string;
    name: string | null;
    status: 'pending' | 'sent' | 'failed';
}