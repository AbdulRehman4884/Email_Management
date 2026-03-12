import { campaignTable, recipientTable, statsTable } from "../db/schema";
import { suppressionListTable } from "../db/schema";
import { eq, and, count, sql } from "drizzle-orm";
import { db } from "../lib/db";
import type { Request, Response } from "express";
import csv from "csv-parser";
import { Readable } from "stream";
import type { CSVRequest, Recipient } from "../types/reciepients";
import { buildHtml, type TemplateId } from "../lib/emailTemplates";
import { getSmtpSettings } from "../lib/smtpSettings";

function resolveEmailContent(body: {
    emailContent?: string;
    templateId?: TemplateId;
    templateData?: Record<string, unknown>;
}): string {
    if (body.emailContent && typeof body.emailContent === 'string') {
        return body.emailContent;
    }
    if (body.templateId && body.templateData && typeof body.templateData === 'object') {
        return buildHtml(body.templateId as TemplateId, body.templateData as Parameters<typeof buildHtml>[1]);
    }
    return '';
}

export const createCampaign = async (req: Request, res: Response) => {
    try {
        const { name, subject, emailContent, templateId, templateData, scheduledAt } = req.body;
        const content = resolveEmailContent({ emailContent, templateId, templateData });
        if (!content.trim()) {
            return res.status(400).json({ error: 'Provide either emailContent or templateId + templateData' });
        }
        const smtp = await getSmtpSettings();
        const result = await db.insert(campaignTable).values({
            name,
            status: scheduledAt ? 'scheduled' : 'draft',
            subject,
            emailContent: content,
            fromName: smtp.fromName || 'MailFlow',
            fromEmail: smtp.fromEmail,
            scheduledAt
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
        const { id } = req.params;
        const campaign = await db.select().from(campaignTable).where(eq(campaignTable.id, Number(id)));
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
        const { id } = req.params;
        const { name, subject, emailContent, templateId, templateData, scheduledAt } = req.body;
        
        const existing = await db.select().from(campaignTable).where(eq(campaignTable.id, Number(id)));
        if (!existing[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        if (existing[0].status !== 'draft') {
            return res.status(400).json({ error: 'Only draft campaigns can be edited' });
        }
        
        const content = resolveEmailContent({ emailContent, templateId, templateData });
        const finalContent = content.trim() ? content : existing[0].emailContent;
        const smtp = await getSmtpSettings();
        const result = await db.update(campaignTable).set({
            name: name ?? existing[0].name,
            subject: subject ?? existing[0].subject,
            emailContent: finalContent,
            fromName: smtp.fromName || 'MailFlow',
            fromEmail: smtp.fromEmail,
            scheduledAt: scheduledAt !== undefined ? scheduledAt : existing[0].scheduledAt,
            status: scheduledAt ? 'scheduled' : 'draft'
        }).where(eq(campaignTable.id, Number(id))).returning();
        
        res.status(200).json(result[0]);
    } catch (error) {
        console.error('Error updating campaign:', error);
        res.status(500).json({ error: 'Failed to update campaign' });
    }
}

export const deleteCampaign = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        // Delete associated records first
        await db.delete(recipientTable).where(eq(recipientTable.campaignId, Number(id)));
        await db.delete(statsTable).where(eq(statsTable.campaignId, Number(id)));
        await db.delete(campaignTable).where(eq(campaignTable.id, Number(id)));
        
        res.status(200).json({ message: 'Campaign deleted successfully' });
    } catch (error) {
        console.error('Error deleting campaign:', error);
        res.status(500).json({ error: 'Failed to delete campaign' });
    }
}

export const uploadRecipientsCSV = async (req: CSVRequest, res: Response) => {
    const campaignId = Number(req.params.id);
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    const recipients: Recipient[] = [];
    try {
        const suppressedEmails = await db.select().from(suppressionListTable);
        const suppressedSet = new Set(suppressedEmails.map(entry => entry.email));
        const stream = Readable.from(req.file.buffer);
        stream
            .pipe(csv())
            .on('data', (data) => {
                const email = data.email;
                if (!suppressedSet.has(email)) {
                    recipients.push({
                        campaignId,
                        email,
                        name: data.name || null,
                        status: 'pending'
                    });
                }
            })
            .on('end', async () => {
                try {
                    if (recipients.length > 0) {
                        await db.insert(recipientTable).values(recipients);
                    }
                    await db.update(campaignTable).set({
                        recieptCount: sql`${campaignTable.recieptCount} + ${recipients.length}`
                    }).where(eq(campaignTable.id, campaignId));
                    res.status(200).json({ message: 'Recipients uploaded successfully', addedCount: recipients.length });
                } catch (error) {
                    console.error('Error inserting recipients:', error);
                    res.status(500).json({ error: 'Failed to insert recipients' });
               }
            }
            );
        } catch (error) {
            res.status(500).json({ error: 'Failed to process CSV file' });
        }
}

export const getRecipients = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
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

export const markRecipientReplied = async (req: Request, res: Response) => {
    try {
        const campaignId = Number(req.params.id);
        const recipientId = Number(req.params.recipientId);
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
        const { id } = req.params;
        
        // Check campaign status
        const campaign = await db.select().from(campaignTable).where(eq(campaignTable.id, Number(id)));
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

        await db.update(campaignTable).set({ status: 'in_progress' }).where(eq(campaignTable.id, Number(id)));
        res.status(200).json({ message: 'Campaign started successfully' });
    } catch (error) {
        console.error('Error starting campaign:', error);
        res.status(500).json({ error: 'Failed to start campaign' });
    }
}

export const pauseCampaign = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        const campaign = await db.select().from(campaignTable).where(eq(campaignTable.id, Number(id)));
        if (!campaign[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        if (campaign[0].status !== 'in_progress') {
            return res.status(400).json({ error: 'Only in-progress campaigns can be paused' });
        }
        
        await db.update(campaignTable).set({ status: 'paused' }).where(eq(campaignTable.id, Number(id)));
        res.status(200).json({ message: 'Campaign paused successfully' });
    } catch (error) {
        console.error('Error pausing campaign:', error);
        res.status(500).json({ error: 'Failed to pause campaign' });
    }
}

export const resumeCampaign = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        
        const campaign = await db.select().from(campaignTable).where(eq(campaignTable.id, Number(id)));
        if (!campaign[0]) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        if (campaign[0].status !== 'paused') {
            return res.status(400).json({ error: 'Only paused campaigns can be resumed' });
        }

        await db.update(campaignTable).set({ status: 'in_progress' }).where(eq(campaignTable.id, Number(id)));
        res.status(200).json({ message: 'Campaign resumed successfully' });
    } catch (error) {
        console.error('Error resuming campaign:', error);
        res.status(500).json({ error: 'Failed to resume campaign' });
    }
}

export const getCampaignStats = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;  
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
        const campaigns = await db.select().from(campaignTable);
        res.status(200).json(campaigns);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve campaigns' });
    }   
}

export const getDashboardStats = async (req: Request, res: Response) => {
    try {
        const campaigns = await db.select().from(campaignTable);
        const allStats = await db.select().from(statsTable);
        
        const totalCampaigns = campaigns.length;
        const activeCampaigns = campaigns.filter(c => c.status === 'in_progress' || c.status === 'scheduled').length;
        
        const totalEmailsSent = allStats.reduce((sum, s) => sum + (s.sentCount || 0), 0);
        const totalDelivered = allStats.reduce((sum, s) => sum + (s.delieveredCount || 0), 0);
        const totalBounces = allStats.reduce((sum, s) => sum + (s.bouncedCount || 0), 0);
        const totalComplaints = allStats.reduce((sum, s) => sum + (s.complainedCount || 0), 0);
        
        const averageDeliveryRate = totalEmailsSent > 0 
            ? Math.round((totalDelivered / totalEmailsSent) * 100) 
            : 0;
        
        res.status(200).json({
            totalCampaigns,
            activeCampaigns,
            totalEmailsSent,
            averageDeliveryRate,
            totalBounces,
            totalComplaints
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Failed to retrieve dashboard stats' });
    }
}

