interface Campaign {
    id: number;
    name: string;
    subject: string;
    emailContent: string;
    fromName: string;
    fromEmail: string;
    status: 'draft' | 'scheduled' | 'sent' | 'paused';
    recipientCount: number;
    createdAt: Date;
    scheduledAt: Date | null;
}