import { campaignTable, recipientTable, statsTable, emailRepliesTable } from "../db/schema";
import { suppressionListTable } from "../db/schema";
import { eq, and, count, inArray, sql, desc } from "drizzle-orm";
import { db, dbPool } from "../lib/db";
import type { Request, Response } from "express";
import csv from "csv-parser";
import { Readable } from "stream";
import * as XLSX from "xlsx";
import type { CSVRequest, Recipient } from "../types/reciepients";

const RECIPIENT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseExcelBuffer(buffer: Buffer): { email: string; name?: string }[] {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    return rows.map((row) => {
        const keys = Object.keys(row);
        const emailKey = keys.find((k) => k.toLowerCase() === "email");
        const nameKey = keys.find((k) => k.toLowerCase() === "name");
        const email = emailKey ? String(row[emailKey] ?? "").trim() : "";
        const name = nameKey ? String(row[nameKey] ?? "").trim() || undefined : undefined;
        return { email, name };
    }).filter((r) => r.email);
}
import { buildHtml, type TemplateId } from "../lib/emailTemplates";
import { getSmtpSettings } from "../lib/smtpSettings";
import { CAMPAIGN_LIMITS, firstLengthViolation } from "../constants/fieldLimits";
import { getCurrentLocalTimestampString, normalizeLocalScheduleInput } from "../lib/localDateTime";

function resolveEmailContent(body: {
    emailContent?: string;
    templateId?: TemplateId;
    templateData?: Record<string, unknown>;
}): string {
    if (body.emailContent && typeof body.emailContent === 'string') {
        return body.emailContent;
    }
    if (body.templateId && body.templateData && typeof body.templateData === 'object') {
        return buildHtml(body.templateId as TemplateId, body.templateData as unknown as Parameters<typeof buildHtml>[1]);
    }
    return '';
}

export const createCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { name, subject, emailContent, templateId, templateData, scheduledAt } = req.body;
        const content = resolveEmailContent({ emailContent, templateId, templateData });
        if (!content.trim()) {
            return res.status(400).json({ error: 'Provide either emailContent or templateId + templateData' });
        }

        const nameStr = name != null ? String(name).trim() : '';
        const subjectStr = subject != null ? String(subject).trim() : '';
        if (!nameStr) {
            return res.status(400).json({ error: 'Campaign name is required' });
        }
        if (!subjectStr) {
            return res.status(400).json({ error: 'Subject is required' });
        }
        const lenErr = firstLengthViolation([
            { label: 'Campaign name', value: nameStr, max: CAMPAIGN_LIMITS.name },
            { label: 'Subject', value: subjectStr, max: CAMPAIGN_LIMITS.subject },
            { label: 'Email content', value: content, max: CAMPAIGN_LIMITS.emailContent },
        ]);
        if (lenErr) {
            return res.status(400).json({ error: lenErr });
        }

        let validScheduledAt: string | null = null;
        if (scheduledAt) {
            const normalized = normalizeLocalScheduleInput(String(scheduledAt));
            if (!normalized) {
                return res.status(400).json({ error: 'Invalid scheduledAt date format' });
            }
            validScheduledAt = normalized;
        }

        const smtp = await getSmtpSettings(userId);
        const fromNameResolved = (smtp.fromName || 'MailFlow').trim();
        const fromEmailResolved = String(smtp.fromEmail || '').trim();
        const smtpLenErr = firstLengthViolation([
            { label: 'Sender name', value: fromNameResolved, max: CAMPAIGN_LIMITS.fromName },
            { label: 'From email', value: fromEmailResolved, max: CAMPAIGN_LIMITS.fromEmail },
        ]);
        if (smtpLenErr) {
            return res.status(400).json({
                error: `${smtpLenErr} Adjust SMTP sender fields in Settings.`,
            });
        }
        if (!fromEmailResolved) {
            return res.status(400).json({ error: 'Configure SMTP from email in Settings before creating a campaign' });
        }
        const result = await db.insert(campaignTable).values({
            userId,
            name: nameStr,
            status: validScheduledAt ? 'scheduled' : 'draft',
            subject: subjectStr,
            emailContent: content,
            fromName: fromNameResolved,
            fromEmail: fromEmailResolved,
            scheduledAt: validScheduledAt
        }).returning();
        
        if (!result[0]) {
            return res.status(500).json({ error: 'Failed to create campaign' });
        }
        
        // Create initial stats record for the campaign
        await db.insert(statsTable).values({
            campaignId: result[0].id,
            sentCount: 0,
            delieveredCount: 0,
            bouncedCount: 0,
            failedCount: 0,
            complainedCount: 0,
            openedCount: 0,
            repliedCount: 0,
        });
        
        res.status(201).json(result[0]);
    } catch (error) {
        console.error('Error creating campaign:', error);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
}

export const getCampaignById = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const campaign = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId)));
        if (campaign.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        res.status(200).json(campaign[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve campaign' });
    }
}

export const updateCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const { name, subject, emailContent, templateId, templateData, scheduledAt } = req.body;
        
        const existing = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId)));
        if (!existing[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        if (existing[0].status !== 'draft') {
            return res.status(400).json({ error: 'Only draft campaigns can be edited' });
        }
        
        const content = resolveEmailContent({ emailContent, templateId, templateData });
        const finalContent = content.trim() ? content : existing[0].emailContent;

        const nameStr = name !== undefined ? String(name).trim() : existing[0].name;
        const subjectStr = subject !== undefined ? String(subject).trim() : existing[0].subject;
        if (name !== undefined && !nameStr) {
            return res.status(400).json({ error: 'Campaign name is required' });
        }
        if (subject !== undefined && !subjectStr) {
            return res.status(400).json({ error: 'Subject is required' });
        }
        const updateLenErr = firstLengthViolation([
            { label: 'Campaign name', value: nameStr, max: CAMPAIGN_LIMITS.name },
            { label: 'Subject', value: subjectStr, max: CAMPAIGN_LIMITS.subject },
            { label: 'Email content', value: finalContent, max: CAMPAIGN_LIMITS.emailContent },
        ]);
        if (updateLenErr) {
            return res.status(400).json({ error: updateLenErr });
        }

        let validScheduledAt: string | null | undefined = undefined;
        if (scheduledAt !== undefined) {
            if (scheduledAt) {
                const normalized = normalizeLocalScheduleInput(String(scheduledAt));
                if (!normalized) {
                    return res.status(400).json({ error: 'Invalid scheduledAt date format' });
                }
                validScheduledAt = normalized;
            } else {
                validScheduledAt = null;
            }
        }

        const resolvedScheduledAt = validScheduledAt !== undefined ? validScheduledAt : existing[0].scheduledAt;
        const smtp = await getSmtpSettings(userId);
        const fromNameResolved = (smtp.fromName || 'MailFlow').trim();
        const fromEmailResolved = String(smtp.fromEmail || '').trim();
        const smtpUpdateLenErr = firstLengthViolation([
            { label: 'Sender name', value: fromNameResolved, max: CAMPAIGN_LIMITS.fromName },
            { label: 'From email', value: fromEmailResolved, max: CAMPAIGN_LIMITS.fromEmail },
        ]);
        if (smtpUpdateLenErr) {
            return res.status(400).json({
                error: `${smtpUpdateLenErr} Adjust SMTP sender fields in Settings.`,
            });
        }
        if (!fromEmailResolved) {
            return res.status(400).json({ error: 'Configure SMTP from email in Settings before updating a campaign' });
        }
        const result = await db.update(campaignTable).set({
            name: nameStr,
            subject: subjectStr,
            emailContent: finalContent,
            fromName: fromNameResolved,
            fromEmail: fromEmailResolved,
            scheduledAt: resolvedScheduledAt,
            status: resolvedScheduledAt ? 'scheduled' : 'draft',
            updatedAt: new Date().toISOString(),
        }).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId))).returning();
        
        res.status(200).json(result[0]);
    } catch (error) {
        console.error('Error updating campaign:', error);
        res.status(500).json({ error: 'Failed to update campaign' });
    }
}

export const deleteCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const campaignId = Number(id);
        await db.delete(emailRepliesTable).where(eq(emailRepliesTable.campaignId, campaignId));
        await db.delete(recipientTable).where(eq(recipientTable.campaignId, campaignId));
        await db.delete(statsTable).where(eq(statsTable.campaignId, campaignId));
        await db.delete(campaignTable).where(eq(campaignTable.id, campaignId));
        res.status(200).json({ message: 'Campaign deleted successfully' });
    } catch (error) {
        console.error('Error deleting campaign:', error);
        res.status(500).json({ error: 'Failed to delete campaign' });
    }
}

export const uploadRecipientsCSV = async (req: CSVRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = Number(req.params.id);
    const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const filename = (req.file.originalname || req.file.filename || '').toLowerCase();
    const isExcel = filename.endsWith('.xlsx') || filename.endsWith('.xls');

    const suppressedEmails = await db.select().from(suppressionListTable);
    const suppressedSet = new Set(suppressedEmails.map(entry => entry.email));

    try {
        const existingForCampaign = await db.select({ email: recipientTable.email }).from(recipientTable).where(eq(recipientTable.campaignId, campaignId));
        const existingSet = new Set(existingForCampaign.map((r) => r.email.toLowerCase().trim()));

        if (isExcel) {
            const rows = parseExcelBuffer(req.file.buffer);
            const byEmail = new Map<string, { email: string; name?: string | null }>();
            for (const r of rows) {
                if (!r.email || suppressedSet.has(r.email)) continue;
                const key = r.email.toLowerCase().trim();
                if (!byEmail.has(key)) byEmail.set(key, { email: r.email.trim(), name: r.name || null });
            }
            const toAdd = Array.from(byEmail.values()).filter((r) => !existingSet.has(r.email.toLowerCase()));
            const validToAdd = toAdd.filter((r) => RECIPIENT_EMAIL_REGEX.test(r.email));
            const rejectedCount = toAdd.length - validToAdd.length;
            const recipients: Recipient[] = validToAdd.map((r) => ({ campaignId, email: r.email, name: r.name ?? null, status: 'pending' as const }));
            if (recipients.length > 0) {
                await db.insert(recipientTable).values(recipients);
                await db.update(campaignTable).set({
                    recieptCount: sql`${campaignTable.recieptCount} + ${recipients.length}`,
                    updatedAt: new Date().toISOString(),
                }).where(eq(campaignTable.id, campaignId));
            }
            return res.status(200).json({ message: 'Recipients uploaded successfully', addedCount: recipients.length, rejectedCount });
        }

        const rawRecipients: { email: string; name?: string | null }[] = [];
        await new Promise<void>((resolve, reject) => {
            const stream = Readable.from(req.file!.buffer);
            stream
                .pipe(csv())
                .on('data', (data: { email?: string; name?: string }) => {
                    const email = data.email?.trim();
                    if (email && !suppressedSet.has(email)) {
                        rawRecipients.push({ email, name: data.name?.trim() || null });
                    }
                })
                .on('end', () => resolve())
                .on('error', reject);
        });
        const byEmail = new Map<string, { email: string; name?: string | null }>();
        for (const r of rawRecipients) {
            const key = r.email.toLowerCase();
            if (!byEmail.has(key)) byEmail.set(key, { email: r.email, name: r.name ?? null });
        }
        const toAdd = Array.from(byEmail.values()).filter((r) => !existingSet.has(r.email.toLowerCase()));
        const validToAdd = toAdd.filter((r) => RECIPIENT_EMAIL_REGEX.test(r.email));
        const rejectedCount = toAdd.length - validToAdd.length;
        const recipients: Recipient[] = validToAdd.map((r) => ({ campaignId, email: r.email, name: r.name ?? null, status: 'pending' as const }));
        if (recipients.length > 0) {
            await db.insert(recipientTable).values(recipients);
            await db.update(campaignTable).set({
                recieptCount: sql`${campaignTable.recieptCount} + ${recipients.length}`,
                updatedAt: new Date().toISOString(),
            }).where(eq(campaignTable.id, campaignId));
        }
        res.status(200).json({ message: 'Recipients uploaded successfully', addedCount: recipients.length, rejectedCount });
    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: 'Failed to process file. Use CSV or Excel with email (and optional name) columns.' });
    }
}

export const getRecipients = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const recipients = await db.select().from(recipientTable)
            .where(eq(recipientTable.campaignId, Number(id)))
            .limit(limit)
            .offset(offset);
        const totalResult = await db.select({ count: count() }).from(recipientTable)
            .where(eq(recipientTable.campaignId, Number(id)));
        const total = totalResult[0]?.count || 0;
        res.status(200).json({ recipients, total });
    } catch (error) {
        console.error('Error fetching recipients:', error);
        res.status(500).json({ error: 'Failed to retrieve recipients' });
    }
}

export const deleteRecipient = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const recipientId = Number(req.params.recipientId);
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        if (campaign.status !== 'draft') {
            return res.status(400).json({ error: 'Recipients can only be removed from draft campaigns' });
        }
        const [recipient] = await db.select().from(recipientTable)
            .where(and(eq(recipientTable.id, recipientId), eq(recipientTable.campaignId, campaignId)))
            .limit(1);
        if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
        await db.delete(emailRepliesTable).where(eq(emailRepliesTable.recipientId, recipientId));
        await db.delete(recipientTable).where(eq(recipientTable.id, recipientId));
        await db.update(campaignTable).set({
            recieptCount: sql`GREATEST(${campaignTable.recieptCount} - 1, 0)`,
            updatedAt: new Date().toISOString(),
        }).where(eq(campaignTable.id, campaignId));
        res.status(200).json({ message: 'Recipient deleted' });
    } catch (error) {
        console.error('Error deleting recipient:', error);
        res.status(500).json({ error: 'Failed to delete recipient' });
    }
};

export const markRecipientReplied = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const recipientId = Number(req.params.recipientId);
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const [recipient] = await db.select().from(recipientTable)
            .where(and(eq(recipientTable.id, recipientId), eq(recipientTable.campaignId, campaignId)))
            .limit(1);
        if (!recipient) {
            return res.status(404).json({ error: 'Recipient not found' });
        }
        if (recipient.repliedAt) {
            return res.status(200).json({ message: 'Already marked as replied' });
        }
        await db.update(recipientTable).set({ repliedAt: new Date() }).where(eq(recipientTable.id, recipientId));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, campaignId)).limit(1);
        if (stat) {
            await db.update(statsTable).set({ repliedCount: Number(stat.repliedCount) + 1 }).where(eq(statsTable.campaignId, campaignId));
        }
        res.status(200).json({ message: 'Marked as replied' });
    } catch (error) {
        console.error('Error marking replied:', error);
        res.status(500).json({ error: 'Failed to update' });
    }
}

export const startCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const campaign = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId)));
        if (!campaign[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        if (!['draft', 'scheduled'].includes(campaign[0].status)) {
            return res.status(400).json({ error: 'Campaign cannot be started from current status' });
        }

        const reciepients = await db.select().from(recipientTable).where(and(eq(recipientTable.campaignId, Number(id)), eq(recipientTable.status, 'pending')));

        if (reciepients.length === 0) {
            return res.status(400).json({ error: 'No pending recipients to send to' });
        }

        const scheduledAt = campaign[0].scheduledAt ? String(campaign[0].scheduledAt).slice(0, 19).replace('T', ' ') : null;
        const isFuture = scheduledAt && scheduledAt > getCurrentLocalTimestampString();

        const now = new Date();
        await db.update(campaignTable).set({ status: 'in_progress', updatedAt: now.toISOString() }).where(eq(campaignTable.id, Number(id)));

        const message = isFuture
            ? `Campaign queued. Sending will begin at scheduled time (${scheduledAt}).`
            : 'Campaign started successfully';
        res.status(200).json({ status: 'in_progress', message });
    } catch (error) {
        console.error('Error starting campaign:', error);
        res.status(500).json({ error: 'Failed to start campaign' });
    }
}

export const pauseCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const campaign = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId)));
        if (!campaign[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        if (campaign[0].status !== 'in_progress') {
            return res.status(400).json({ error: 'Only in-progress campaigns can be paused' });
        }
        
        await db.update(campaignTable).set({ status: 'paused', updatedAt: new Date().toISOString() }).where(eq(campaignTable.id, Number(id)));
        await db.update(recipientTable)
            .set({ status: 'pending' })
            .where(and(eq(recipientTable.campaignId, Number(id)), eq(recipientTable.status, 'sending')));
        res.status(200).json({ message: 'Campaign paused successfully' });
    } catch (error) {
        console.error('Error pausing campaign:', error);
        res.status(500).json({ error: 'Failed to pause campaign' });
    }
}

export const resumeCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const campaign = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId)));
        if (!campaign[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        if (campaign[0].status !== 'paused') {
            return res.status(400).json({ error: 'Only paused campaigns can be resumed' });
        }

        // Recover any in-flight rows so worker can claim them again cleanly on resume.
        await db.update(recipientTable)
            .set({ status: 'pending' })
            .where(and(eq(recipientTable.campaignId, Number(id)), eq(recipientTable.status, 'sending')));

        await db.update(campaignTable).set({ status: 'in_progress', updatedAt: new Date().toISOString() }).where(eq(campaignTable.id, Number(id)));
        res.status(200).json({ message: 'Campaign resumed successfully' });
    } catch (error) {
        console.error('Error resuming campaign:', error);
        res.status(500).json({ error: 'Failed to resume campaign' });
    }
}

export const getCampaignStats = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { id } = req.params;
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, Number(id)), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const stats = await db.select().from(statsTable).where(eq(statsTable.campaignId, Number(id)));
        if (stats.length === 0) {
            return res.status(200).json({
                campaignId: Number(id),
                sentCount: 0,
                delieveredCount: 0,
                bouncedCount: 0,
                failedCount: 0,
                complainedCount: 0,
                openedCount: 0,
                repliedCount: 0,
            });
        }
        res.status(200).json(stats[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve campaign stats' });
    }
}

export const getAllCampaigns = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaigns = await db.select().from(campaignTable).where(eq(campaignTable.userId, userId)).orderBy(desc(campaignTable.updatedAt));
        res.status(200).json(campaigns);
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        res.status(500).json({ error: 'Failed to retrieve campaigns' });
    }   
}

export const getDashboardStats = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaigns = await db.select().from(campaignTable).where(eq(campaignTable.userId, userId));
        const campaignIds = campaigns.map(c => c.id);
        const allStats = campaignIds.length > 0
            ? await db.select().from(statsTable).where(inArray(statsTable.campaignId, campaignIds))
            : [];
        const totalCampaigns = campaigns.length;
        const activeCampaigns = campaigns.filter(c => c.status === 'in_progress' || c.status === 'scheduled').length;
        const totalEmailsSent = allStats.reduce((sum, s) => sum + (s.sentCount || 0), 0);
        const totalDelivered = allStats.reduce((sum, s) => sum + (s.delieveredCount || 0), 0);
        const totalBounces = allStats.reduce((sum, s) => sum + (s.bouncedCount || 0), 0);
        const totalComplaints = allStats.reduce((sum, s) => sum + (s.complainedCount || 0), 0);
        const totalFailed = allStats.reduce((sum, s) => sum + (s.failedCount || 0), 0);
        const totalOpened = allStats.reduce((sum, s) => sum + (s.openedCount || 0), 0);
        const totalReplied = allStats.reduce((sum, s) => sum + (s.repliedCount || 0), 0);

        const averageDeliveryRate = totalEmailsSent > 0
            ? Math.round((totalDelivered / totalEmailsSent) * 100)
            : 0;

        const view = String(req.query.view ?? 'monthly').toLowerCase();
        const timeSeries: Array<{
            day: string;
            sent: number;
            delivered: number;
            opened: number;
            clicked: number;
        }> = [];

        if (campaignIds.length > 0) {
            const rows = await dbPool.query(
                `SELECT sent_at, delivered_at, opened_at, replied_at
                 FROM recipients
                 WHERE campaign_id = ANY($1::int[])`,
                [campaignIds]
            );

            const allDates: Date[] = [];
            for (const row of rows.rows as Array<Record<string, unknown>>) {
                for (const key of ["sent_at", "delivered_at", "opened_at", "replied_at"] as const) {
                    const raw = row[key];
                    if (!raw) continue;
                    const dt = new Date(String(raw));
                    if (!Number.isNaN(dt.getTime())) allDates.push(dt);
                }
            }

            // Anchor to latest available event date so historical data always renders.
            const anchor = allDates.length > 0
                ? new Date(Math.max(...allDates.map((d) => d.getTime())))
                : new Date();
            if (view === 'yearly') {
                const labels: string[] = [];
                const indexByMonth = new Map<string, number>();
                for (let i = 11; i >= 0; i--) {
                    const d = new Date(anchor);
                    d.setMonth(anchor.getMonth() - i);
                    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
                    labels.push(key);
                    indexByMonth.set(key, labels.length - 1);
                }

                const buckets = labels.map((key) => ({
                    day: new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short" }),
                    sent: 0,
                    delivered: 0,
                    opened: 0,
                    clicked: 0,
                }));

                const addByMonth = (val: unknown, field: "sent" | "delivered" | "opened" | "clicked") => {
                    if (!val) return;
                    const dt = new Date(String(val));
                    if (Number.isNaN(dt.getTime())) return;
                    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
                    const idx = indexByMonth.get(key);
                    if (idx == null) return;
                    buckets[idx][field] += 1;
                };

                for (const row of rows.rows as Array<Record<string, unknown>>) {
                    addByMonth(row.sent_at, "sent");
                    addByMonth(row.delivered_at, "delivered");
                    addByMonth(row.opened_at, "opened");
                    // Click tracking is not stored yet; using reply timestamp as engagement proxy.
                    addByMonth(row.replied_at, "clicked");
                }

                timeSeries.push(...buckets);
            } else {
                // Monthly view: daily points for the anchor month (month containing latest data)
                const y = anchor.getUTCFullYear();
                const m = anchor.getUTCMonth();
                const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
                const labels: string[] = [];
                const indexByDay = new Map<string, number>();
                for (let day = 1; day <= lastDay; day++) {
                    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    labels.push(key);
                    indexByDay.set(key, labels.length - 1);
                }

                const buckets = labels.map((key) => ({
                    day: new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                    sent: 0,
                    delivered: 0,
                    opened: 0,
                    clicked: 0,
                }));

                const addByDate = (val: unknown, field: "sent" | "delivered" | "opened" | "clicked") => {
                    if (!val) return;
                    const dt = new Date(String(val));
                    if (Number.isNaN(dt.getTime())) return;
                    const key = dt.toISOString().slice(0, 10);
                    const idx = indexByDay.get(key);
                    if (idx == null) return;
                    buckets[idx][field] += 1;
                };

                for (const row of rows.rows as Array<Record<string, unknown>>) {
                    addByDate(row.sent_at, "sent");
                    addByDate(row.delivered_at, "delivered");
                    addByDate(row.opened_at, "opened");
                    // Click tracking is not stored yet; using reply timestamp as engagement proxy.
                    addByDate(row.replied_at, "clicked");
                }

                timeSeries.push(...buckets);
            }
        }

        res.status(200).json({
            totalCampaigns,
            activeCampaigns,
            totalEmailsSent,
            totalDelivered,
            totalBounces,
            totalComplaints,
            totalFailed,
            totalOpened,
            totalReplied,
            averageDeliveryRate,
            timeSeries,
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Failed to retrieve dashboard stats' });
    }
}

