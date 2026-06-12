import type{ Request } from 'express';
export interface CSVRequest extends Request {
    file?: Express.Multer.File;
}

export interface Recipient {
    campaignId: number;
    email: string;
    name: string | null;
    customFields?: string | null;
    status: 'pending' | 'sent' | 'failed';
}