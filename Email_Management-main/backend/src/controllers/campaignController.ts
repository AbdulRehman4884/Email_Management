import {
    campaignTable,
    recipientTable,
    statsTable,
    emailRepliesTable,
    campaignAiPromptsTable,
    campaignPersonalizedEmailsTable,
    campaignSequenceTouchesTable,
    recipientSequenceStateTable,
} from "../db/schema";
import { suppressionListTable } from "../db/schema";
import { generatePersonalizedEmailBody } from "../lib/openaiEmailGenerator";
import { eq, and, count, inArray, sql, desc, asc, or } from "drizzle-orm";
import { db, dbPool } from "../lib/db";
import type { Request, Response } from "express";
import csv from "csv-parser";
import { Readable } from "stream";
import * as XLSX from "xlsx";
import type { CSVRequest, Recipient } from "../types/reciepients";

const RECIPIENT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_COLUMN_ALIASES = new Set(["email", "email_address"]);
const NAME_COLUMN_ALIASES  = new Set(["name", "full_name"]);

function parseExcelBuffer(buffer: Buffer): { email: string; name?: string; customFields?: Record<string, string> }[] {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return [];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    return rows.map((row) => {
        const keys = Object.keys(row);
        const emailKey = keys.find((k) => EMAIL_COLUMN_ALIASES.has(k.toLowerCase()));
        const nameKey  = keys.find((k) => NAME_COLUMN_ALIASES.has(k.toLowerCase()));
        const email = emailKey ? String(row[emailKey] ?? "").trim() : "";
        const name  = nameKey  ? String(row[nameKey]  ?? "").trim() || undefined : undefined;
        const customFields: Record<string, string> = {};
        for (const k of keys) {
            if (EMAIL_COLUMN_ALIASES.has(k.toLowerCase()) || NAME_COLUMN_ALIASES.has(k.toLowerCase())) continue;
            const v = row[k];
            if (v != null && String(v).trim() !== "") customFields[k.trim()] = String(v).trim();
        }
        return { email, name, customFields: Object.keys(customFields).length > 0 ? customFields : undefined };
    }).filter((r) => r.email);
}
import { buildHtml, type TemplateId } from "../lib/emailTemplates";
import { getSmtpSettings } from "../lib/smtpSettings";
import { CAMPAIGN_LIMITS, firstLengthViolation } from "../constants/fieldLimits";
import { isFutureLocalTimestamp, normalizeLocalScheduleInput, isScheduledTimeReached, parseLocalTimestamp } from "../lib/localDateTime";
import { buildDeliverabilityDiagnostics } from "../lib/deliverabilityDiagnostics";
import {
    generateSequencePlan,
    type CTAType,
    type SequenceType,
    type ToneType,
} from "../lib/sequenceGenerator";
import {
    getRecipientTouchHistory,
    getSequenceProgressSummary,
    listPendingFollowUps,
    markRecipientBounced as markRecipientBouncedState,
    pauseCampaignSequences,
    resumeCampaignSequences,
    upsertSequenceStateFromGeneratedTouches,
} from "../lib/sequenceExecutionEngine";
import { markRecipientReplied as markRecipientRepliedState } from "../lib/replyDetection";

/**
 * Store normalized "YYYY-MM-DD HH:MM:SS" as a real PostgreSQL string literal in the query text.
 * Parameter binding can still be typed as timestamp by the client; literals bypass that entirely.
 * Only use values from `normalizeLocalScheduleInput` or existing DB schedule strings.
 */
function scheduledAtAsPostgresVarchar(s: string) {
    const t = String(s).trim().replace("T", " ").slice(0, 19);
    return sql.raw(`'${t.replace(/'/g, "''")}'::varchar(30)`);
}

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

function asCleanString(value: unknown): string | undefined {
    const text = typeof value === "string" ? value.trim() : "";
    return text || undefined;
}

function coerceNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function parsePainPoints(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 5);
    }
    if (typeof value === "string" && value.trim() !== "") {
        return value
            .split(/[;,|]/)
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 5);
    }
    return [];
}

function resolveField(record: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (record[key] != null) return record[key];
    }
    return undefined;
}

function buildStrategyInputFromRecipient(
    customFields: Record<string, unknown> | undefined,
    reqBody: Record<string, unknown>,
    _recipientName: string | undefined,
    _recipientEmail: string,
) {
    const fields = customFields ?? {};
    const role = asCleanString(resolveField(fields, ["role", "department"]));
    const title = asCleanString(resolveField(fields, ["title", "jobTitle", "job_title", "position"]));
    const leadScore = coerceNumber(resolveField(fields, ["leadScore", "lead_score", "score"])) ?? coerceNumber(reqBody.leadScore);
    const industry = asCleanString(resolveField(fields, ["industry", "vertical", "segment"])) ?? asCleanString(reqBody.industry);
    const companySize = asCleanString(resolveField(fields, ["companySize", "company_size", "employees", "employeeCount"])) ??
        (typeof reqBody.companySize === "number" ? String(reqBody.companySize) : asCleanString(reqBody.companySize));
    const painPoints = parsePainPoints(resolveField(fields, ["painPoints", "pain_points"]))
        .concat(parsePainPoints(reqBody.painPoints))
        .slice(0, 5);

    return {
        leadScore,
        industry,
        companySize,
        enrichmentData: fields,
        painPoints,
        intent: asCleanString(reqBody.intent),
        recipientRole: role,
        recipientTitle: title,
        preferredTone: asCleanString(reqBody.tone) as ToneType | undefined,
        preferredCtaType: asCleanString(reqBody.ctaType) as CTAType | undefined,
        preferredSequenceType: asCleanString(reqBody.sequenceType) as SequenceType | undefined,
        sequenceLength: reqBody.sequenceLength === 3 ? 3 : reqBody.sequenceLength === 4 ? 4 : undefined,
        includeBreakupEmail: typeof reqBody.includeBreakupEmail === "boolean" ? reqBody.includeBreakupEmail : undefined,
        recipientName: _recipientName,
        recipientEmail: _recipientEmail,
    };
}

async function resolveCampaignRecipient(params: {
    campaignId: number;
    recipientId?: number;
    recipientEmail?: string;
}) {
    if (params.recipientId && Number.isInteger(params.recipientId) && params.recipientId > 0) {
        const [recipient] = await db
            .select()
            .from(recipientTable)
            .where(and(
                eq(recipientTable.campaignId, params.campaignId),
                eq(recipientTable.id, params.recipientId),
            ))
            .limit(1);
        return recipient ?? null;
    }

    if (params.recipientEmail) {
        const normalizedEmail = params.recipientEmail.trim().toLowerCase();
        const [recipient] = await db
            .select()
            .from(recipientTable)
            .where(and(
                eq(recipientTable.campaignId, params.campaignId),
                eq(recipientTable.email, normalizedEmail),
            ))
            .limit(1);
        return recipient ?? null;
    }

    return null;
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
            if (!isFutureLocalTimestamp(normalized)) {
                return res.status(400).json({ error: 'Scheduled time must be in the future' });
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
            scheduledAt: scheduledAt 
        }).returning();
        
        if (!result[0]) {
            return res.status(500).json({ error: 'Failed to create campaign' });
        }
        console.log(`[Campaign] Created #${result[0].id} status=${result[0].status} scheduledAt="${result[0].scheduledAt}"`);
        
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
                if (!isFutureLocalTimestamp(normalized)) {
                    return res.status(400).json({ error: 'Scheduled time must be in the future' });
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
            scheduledAt: resolvedScheduledAt ? scheduledAtAsPostgresVarchar(resolvedScheduledAt) : null,
            status: resolvedScheduledAt ? 'scheduled' : 'draft',
            updatedAt: sql`now()`,
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
        await db.delete(campaignSequenceTouchesTable).where(eq(campaignSequenceTouchesTable.campaignId, campaignId));
        await db.delete(recipientSequenceStateTable).where(eq(recipientSequenceStateTable.campaignId, campaignId));
        await db.delete(campaignPersonalizedEmailsTable).where(eq(campaignPersonalizedEmailsTable.campaignId, campaignId));
        await db.delete(campaignAiPromptsTable).where(eq(campaignAiPromptsTable.campaignId, campaignId));
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
            const byEmail = new Map<string, { email: string; name?: string | null; customFields?: Record<string, string> }>();
            for (const r of rows) {
                if (!r.email || suppressedSet.has(r.email)) continue;
                const key = r.email.toLowerCase().trim();
                if (!byEmail.has(key)) byEmail.set(key, { email: r.email.trim(), name: r.name || null, customFields: r.customFields });
            }
            const toAdd = Array.from(byEmail.values()).filter((r) => !existingSet.has(r.email.toLowerCase()));
            const validToAdd = toAdd.filter((r) => RECIPIENT_EMAIL_REGEX.test(r.email));
            const rejected = toAdd.length - validToAdd.length;
            const recipients = validToAdd.map((r) => ({
                campaignId,
                email: r.email,
                name: r.name ?? null,
                status: 'pending' as const,
                customFields: r.customFields ? JSON.stringify(r.customFields) : null,
            }));
            if (recipients.length > 0) {
                await db.insert(recipientTable).values(recipients);
                await db.update(campaignTable).set({
                    recieptCount: sql`${campaignTable.recieptCount} + ${recipients.length}`,
                    updatedAt: sql`now()`,
                }).where(eq(campaignTable.id, campaignId));
            }
            if (recipients.length === 0) {
                return res.status(200).json({
                    success: true, added: 0, rejected,
                    message: 'CSV processed but no valid recipients found. Please check column names (use "email" or "email_address").',
                });
            }
            return res.status(200).json({ success: true, added: recipients.length, rejected });
        }

        const rawRecipients: { email: string; name?: string | null; customFields?: Record<string, string> }[] = [];
        await new Promise<void>((resolve, reject) => {
            const stream = Readable.from(req.file!.buffer);
            stream
                .pipe(csv())
                .on('data', (data: Record<string, string>) => {
                    // Normalize keys to lowercase for flexible column matching
                    const norm: Record<string, string> = {};
                    for (const [k, v] of Object.entries(data)) {
                        if (k && v != null) norm[k.toLowerCase().trim()] = String(v).trim();
                    }
                    const email = (norm.email ?? norm.email_address ?? '').trim();
                    if (email && !suppressedSet.has(email)) {
                        const name = (norm.name ?? norm.full_name ?? '').trim() || null;
                        const skipKeys = new Set(['email', 'email_address', 'name', 'full_name']);
                        const customFields: Record<string, string> = {};
                        for (const [k, v] of Object.entries(norm)) {
                            if (!skipKeys.has(k) && v) customFields[k] = v;
                        }
                        rawRecipients.push({
                            email,
                            name,
                            customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                        });
                    }
                })
                .on('end', () => resolve())
                .on('error', reject);
        });
        const byEmail = new Map<string, { email: string; name?: string | null; customFields?: Record<string, string> }>();
        for (const r of rawRecipients) {
            const key = r.email.toLowerCase();
            if (!byEmail.has(key)) byEmail.set(key, { email: r.email, name: r.name ?? null, customFields: r.customFields });
        }
        const toAdd = Array.from(byEmail.values()).filter((r) => !existingSet.has(r.email.toLowerCase()));
        const validToAdd = toAdd.filter((r) => RECIPIENT_EMAIL_REGEX.test(r.email));
        const rejected = toAdd.length - validToAdd.length;
        const recipients = validToAdd.map((r) => ({
            campaignId,
            email: r.email,
            name: r.name ?? null,
            status: 'pending' as const,
            customFields: r.customFields ? JSON.stringify(r.customFields) : null,
        }));
        if (recipients.length > 0) {
            await db.insert(recipientTable).values(recipients);
            await db.update(campaignTable).set({
                recieptCount: sql`${campaignTable.recieptCount} + ${recipients.length}`,
                updatedAt: sql`now()`,
            }).where(eq(campaignTable.id, campaignId));
        }
        if (recipients.length === 0) {
            return res.status(200).json({
                success: true, added: 0, rejected,
                message: 'CSV processed but no valid recipients found. Please check column names (use "email" or "email_address").',
            });
        }
        res.status(200).json({ success: true, added: recipients.length, rejected });
    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: 'Failed to process file. Use CSV or Excel with email (and optional name) columns.' });
    }
}

export const saveRecipientsBulk = async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = Number(req.params.id);
    const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { recipients: rawRecipients } = req.body;
    if (!Array.isArray(rawRecipients) || rawRecipients.length === 0) {
        return res.status(400).json({ success: false, message: 'recipients array is required and must not be empty' });
    }

    console.log(`[saveRecipientsBulk] campaignId=${campaignId} incoming=${rawRecipients.length}`);

    try {
        const suppressedEmails = await db.select().from(suppressionListTable);
        const suppressedSet = new Set(suppressedEmails.map(e => e.email.toLowerCase()));

        const existingForCampaign = await db.select({ email: recipientTable.email })
            .from(recipientTable).where(eq(recipientTable.campaignId, campaignId));
        const existingSet = new Set(existingForCampaign.map(r => r.email.toLowerCase().trim()));

        const rejected: { email: string; reason: string }[] = [];
        // seenInRequest prevents within-batch duplicates from being inserted twice
        const seenInRequest = new Set<string>();
        const toInsert: { email: string; name: string | null; customFields: string | null }[] = [];

        for (const raw of rawRecipients) {
            if (!raw || typeof raw !== 'object') continue;
            const r = raw as Record<string, unknown>;

            // ── Email: required, must be syntactically valid ──────────────────
            const emailRaw = typeof r.email === 'string' ? r.email.trim().toLowerCase() : '';
            if (!emailRaw) {
                rejected.push({ email: '', reason: 'missing_email' });
                continue;
            }
            if (!RECIPIENT_EMAIL_REGEX.test(emailRaw)) {
                rejected.push({ email: emailRaw, reason: 'invalid_email' });
                continue;
            }

            // ── Suppression check ─────────────────────────────────────────────
            if (suppressedSet.has(emailRaw)) {
                rejected.push({ email: emailRaw, reason: 'suppressed' });
                continue;
            }

            // ── Duplicate check (existing in campaign) ────────────────────────
            if (existingSet.has(emailRaw)) {
                rejected.push({ email: emailRaw, reason: 'duplicate' });
                continue;
            }

            // ── Within-batch duplicate ─────────────────────────────────────────
            if (seenInRequest.has(emailRaw)) {
                rejected.push({ email: emailRaw, reason: 'duplicate' });
                continue;
            }
            seenInRequest.add(emailRaw);

            // ── Name: optional ────────────────────────────────────────────────
            const name = typeof r.name === 'string' ? r.name.trim() || null : null;

            // ── customFields: merge nested object with any remaining top-level ─
            // The MCP layer sends { email, name, customFields: {...} }.
            // We store the entire customFields object as JSON in the DB column.
            let cfObject: Record<string, unknown> = {};
            if (r.customFields && typeof r.customFields === 'object' && !Array.isArray(r.customFields)) {
                cfObject = { ...(r.customFields as Record<string, unknown>) };
            }
            // Absorb any unexpected top-level enrichment keys (belt-and-braces)
            const knownKeys = new Set(['email', 'name', 'customFields']);
            for (const [k, v] of Object.entries(r)) {
                if (knownKeys.has(k) || v == null) continue;
                cfObject[k] = v;
            }

            toInsert.push({
                email:        emailRaw,
                name,
                customFields: Object.keys(cfObject).length > 0 ? JSON.stringify(cfObject) : null,
            });
        }

        let saved = 0;
        if (toInsert.length > 0) {
            const rows = toInsert.map(r => ({
                campaignId,
                email:        r.email,
                name:         r.name,
                status:       'pending' as const,
                customFields: r.customFields,
            }));
            await db.insert(recipientTable).values(rows);
            await db.update(campaignTable).set({
                recieptCount: sql`${campaignTable.recieptCount} + ${rows.length}`,
                updatedAt:    sql`now()`,
            }).where(eq(campaignTable.id, campaignId));
            saved = rows.length;
        }

        const skipped = rejected.length;
        console.log(`[saveRecipientsBulk] saved=${saved} skipped=${skipped} rejected=${JSON.stringify(rejected)}`);
        return res.status(200).json({ success: true, saved, skipped, rejected });
    } catch (error) {
        console.error('[saveRecipientsBulk] error:', error);
        return res.status(500).json({ success: false, message: 'Failed to save recipients' });
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
        const recipients = await db.select({
            id: recipientTable.id,
            campaignId: recipientTable.campaignId,
            email: recipientTable.email,
            status: recipientTable.status,
            name: recipientTable.name,
            messageId: recipientTable.messageId,
            sentAt: recipientTable.sentAt,
            delieveredAt: recipientTable.delieveredAt,
            openedAt: recipientTable.openedAt,
            repliedAt: recipientTable.repliedAt,
            customFields: recipientTable.customFields,
            lastSendError: recipientTable.lastSendError,
            last_send_error: recipientTable.lastSendError,
            currentTouchNumber: recipientSequenceStateTable.currentTouchNumber,
            nextTouchNumber: recipientSequenceStateTable.nextTouchNumber,
            nextScheduledTouchAt: recipientSequenceStateTable.nextScheduledTouchAt,
            sequenceStatus: recipientSequenceStateTable.sequenceStatus,
            sequenceStartedAt: recipientSequenceStateTable.sequenceStartedAt,
            sequenceCompletedAt: recipientSequenceStateTable.sequenceCompletedAt,
            lastTouchSentAt: recipientSequenceStateTable.lastTouchSentAt,
            lastReplyAt: recipientSequenceStateTable.lastReplyAt,
            lastBounceAt: recipientSequenceStateTable.lastBounceAt,
            unsubscribedAt: recipientSequenceStateTable.unsubscribedAt,
            stopReason: recipientSequenceStateTable.stopReason,
            sequencePaused: recipientSequenceStateTable.sequencePaused,
            retryCount: recipientSequenceStateTable.retryCount,
        }).from(recipientTable)
            .leftJoin(
                recipientSequenceStateTable,
                and(
                    eq(recipientSequenceStateTable.campaignId, recipientTable.campaignId),
                    eq(recipientSequenceStateTable.recipientId, recipientTable.id),
                ),
            )
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
        await db.delete(campaignSequenceTouchesTable).where(eq(campaignSequenceTouchesTable.recipientId, recipientId));
        await db.delete(recipientSequenceStateTable).where(eq(recipientSequenceStateTable.recipientId, recipientId));
        await db.delete(recipientTable).where(eq(recipientTable.id, recipientId));
        await db.update(campaignTable).set({
            recieptCount: sql`GREATEST(${campaignTable.recieptCount} - 1, 0)`,
            updatedAt: sql`now()`,
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
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const recipient = await resolveCampaignRecipient({
            campaignId,
            recipientId: Number.isFinite(Number(req.params.recipientId)) ? Number(req.params.recipientId) : undefined,
            recipientEmail: asCleanString(req.body?.recipientEmail) ?? asCleanString(req.query.recipientEmail),
        });
        if (!recipient) {
            return res.status(404).json({ error: 'Recipient not found' });
        }
        const result = await markRecipientRepliedState({ campaignId, recipientId: recipient.id });
        res.status(200).json({ message: result.alreadyMarked ? 'Already marked as replied' : 'Marked as replied' });
    } catch (error) {
        console.error('Error marking replied:', error);
        res.status(500).json({ error: 'Failed to update' });
    }
}

export const markRecipientBounced = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable).where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const recipient = await resolveCampaignRecipient({
            campaignId,
            recipientId: Number.isFinite(Number(req.params.recipientId)) ? Number(req.params.recipientId) : undefined,
            recipientEmail: asCleanString(req.body?.recipientEmail) ?? asCleanString(req.query.recipientEmail),
        });
        if (!recipient) {
            return res.status(404).json({ error: 'Recipient not found' });
        }
        if (recipient.status === 'bounced') {
            return res.status(200).json({ message: 'Already marked as bounced' });
        }
        await db.update(recipientTable).set({ status: 'bounced' }).where(eq(recipientTable.id, recipient.id));
        const [stat] = await db.select().from(statsTable).where(eq(statsTable.campaignId, campaignId)).limit(1);
        if (stat) {
            await db.update(statsTable).set({ bouncedCount: Number(stat.bouncedCount) + 1 }).where(eq(statsTable.campaignId, campaignId));
        }
        await markRecipientBouncedState({ campaignId, recipientId: recipient.id });
        try {
            await db.insert(suppressionListTable).values({ email: recipient.email.toLowerCase(), reason: 'bounce' });
        } catch {
            // ignore duplicate suppression inserts
        }
        res.status(200).json({ message: 'Marked as bounced' });
    } catch (error) {
        console.error('Error marking bounced:', error);
        res.status(500).json({ error: 'Failed to update' });
    }
}

export const getSequenceProgress = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
            .limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const progress = await getSequenceProgressSummary(campaignId);
        res.status(200).json(progress);
    } catch (error) {
        console.error('Error fetching sequence progress:', error);
        res.status(500).json({ error: 'Failed to retrieve sequence progress' });
    }
};

export const getPendingFollowUps = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
            .limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const limit = Number(req.query.limit) || 50;
        const items = await listPendingFollowUps(campaignId, limit);
        res.status(200).json({ campaignId, total: items.length, items });
    } catch (error) {
        console.error('Error fetching pending follow-ups:', error);
        res.status(500).json({ error: 'Failed to retrieve pending follow-ups' });
    }
};

export const getRecipientSequenceHistory = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
            .limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const recipient = await resolveCampaignRecipient({
            campaignId,
            recipientId: Number.isFinite(Number(req.params.recipientId)) ? Number(req.params.recipientId) : undefined,
            recipientEmail: asCleanString(req.query.recipientEmail),
        });
        if (!recipient) {
            return res.status(404).json({ error: 'Recipient not found' });
        }

        const history = await getRecipientTouchHistory(campaignId, recipient.id);
        res.status(200).json({
            campaignId,
            recipientId: recipient.id,
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            ...history,
        });
    } catch (error) {
        console.error('Error fetching recipient sequence history:', error);
        res.status(500).json({ error: 'Failed to retrieve recipient sequence history' });
    }
};

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

        const isFuture = !isScheduledTimeReached(campaign[0].scheduledAt);
        const scheduledDate = parseLocalTimestamp(campaign[0].scheduledAt);

        await db.update(campaignTable).set({ status: 'in_progress', updatedAt: sql`now()` }).where(eq(campaignTable.id, Number(id)));

        const message = isFuture && scheduledDate
            ? `Campaign queued. Sending will begin at scheduled time (${scheduledDate.toLocaleString()}).`
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
        
        await db.update(campaignTable).set({ status: 'paused', updatedAt: sql`now()` }).where(eq(campaignTable.id, Number(id)));
        await db.update(recipientTable)
            .set({ status: 'pending' })
            .where(and(eq(recipientTable.campaignId, Number(id)), eq(recipientTable.status, 'sending')));
        await pauseCampaignSequences(Number(id));
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

        await db.update(campaignTable).set({ status: 'in_progress', updatedAt: sql`now()` }).where(eq(campaignTable.id, Number(id)));
        await resumeCampaignSequences(Number(id));
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
            const sequence = await getSequenceProgressSummary(Number(id));
            return res.status(200).json({
                campaignId: Number(id),
                sentCount: 0,
                delieveredCount: 0,
                bouncedCount: 0,
                failedCount: 0,
                complainedCount: 0,
                openedCount: 0,
                repliedCount: 0,
                sequence,
            });
        }
        const sequence = await getSequenceProgressSummary(Number(id));
        res.status(200).json({ ...stats[0], sequence });
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
                    const bucket = buckets[idx];
                    if (!bucket) return;
                    bucket[field] += 1;
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
                    const bucket = buckets[idx];
                    if (!bucket) return;
                    bucket[field] += 1;
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

// ── Phase 1: AI Campaign ──────────────────────────────────────────────────────

export const getRecipientCount = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const result = await db.select({ count: count() }).from(recipientTable)
            .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, 'pending')));
        const total = await db.select({ count: count() }).from(recipientTable)
            .where(eq(recipientTable.campaignId, campaignId));
        res.status(200).json({
            campaignId,
            pendingCount: Number(result[0]?.count ?? 0),
            totalCount: Number(total[0]?.count ?? 0),
        });
    } catch (error) {
        console.error('Error fetching recipient count:', error);
        res.status(500).json({ error: 'Failed to retrieve recipient count' });
    }
};

export const saveAiCampaignPrompt = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const { templateType, toneInstruction, customPrompt } = req.body as {
            templateType?: string;
            toneInstruction?: string;
            customPrompt?: string;
        };

        const existing = await db.select({ id: campaignAiPromptsTable.id })
            .from(campaignAiPromptsTable)
            .where(eq(campaignAiPromptsTable.campaignId, campaignId))
            .limit(1);

        if (existing[0]) {
            await db.update(campaignAiPromptsTable).set({
                templateType: templateType ?? null,
                toneInstruction: toneInstruction ?? null,
                customPrompt: customPrompt ?? null,
                updatedAt: sql`now()`,
            }).where(eq(campaignAiPromptsTable.id, existing[0].id));
        } else {
            await db.insert(campaignAiPromptsTable).values({
                campaignId,
                userId,
                templateType: templateType ?? null,
                toneInstruction: toneInstruction ?? null,
                customPrompt: customPrompt ?? null,
            });
        }

        res.status(200).json({ message: 'AI prompt configuration saved', campaignId });
    } catch (error) {
        console.error('Error saving AI prompt:', error);
        res.status(500).json({ error: 'Failed to save AI prompt configuration' });
    }
};

export const generatePersonalizedEmails = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

        const [aiPrompt] = await db.select().from(campaignAiPromptsTable)
            .where(eq(campaignAiPromptsTable.campaignId, campaignId)).limit(1);
        const smtp = await getSmtpSettings(userId);
        const reqBody = (req.body && typeof req.body === "object") ? req.body as Record<string, unknown> : {};
        const requestedMode = typeof reqBody.mode === "string" ? reqBody.mode : undefined;

        const recipients = await db.select().from(recipientTable)
            .where(eq(recipientTable.campaignId, campaignId));

        if (recipients.length === 0) {
            return res.status(422).json({ error: 'No recipients found. Upload a CSV first.' });
        }

        const campaignCtx = {
            name: campaign.name,
            subject: campaign.subject,
            templateType: aiPrompt?.templateType ?? null,
            toneInstruction: aiPrompt?.toneInstruction ?? null,
            customPrompt: aiPrompt?.customPrompt ?? null,
            senderName: campaign.fromName,
            mode: requestedMode ?? "low_promotional_plaintext",
        };

        let generatedCount = 0;
        let failedCount = 0;
        let totalGeneratedTouches = 0;
        let deliverabilitySummary: ReturnType<typeof buildDeliverabilityDiagnostics> | null = null;
        let preview: { recipientEmail: string; subject: string; bodyText: string } | null = null;
        let strategySummary: {
            tone: string;
            ctaType: string;
            ctaText: string;
            sequenceType: string;
            outreachApproach: string;
            reasoning: string[];
        } | null = null;
        let touchSchedule: number[] = [];
        let previewSequence: Array<{
            touchNumber: number;
            subject: string;
            bodyText: string;
            ctaType: string;
            ctaText: string;
            delayDays: number;
            tone: string;
            objective: string;
        }> = [];

        const startTime = Date.now();
        console.log(`[generatePersonalizedEmails] campaignId=${campaignId} totalRecipients=${recipients.length} starting`);

        for (const recipient of recipients) {
            const recipientStart = Date.now();
            const customFields: Record<string, unknown> | undefined = recipient.customFields
                ? (() => { try { return JSON.parse(recipient.customFields) as Record<string, unknown>; } catch { return undefined; } })()
                : undefined;

            // Resolve name with fallbacks so every recipient gets a personalized greeting
            const resolvedName =
                recipient.name ||
                (customFields?.firstName as string | undefined) ||
                (customFields?.fullName  as string | undefined) ||
                recipient.email.split("@")[0];
            const recipientMs = Date.now() - recipientStart;

            const strategyInput = buildStrategyInputFromRecipient(
                customFields,
                reqBody,
                resolvedName,
                recipient.email,
            );
            const sequencePlan = generateSequencePlan({
                ...strategyInput,
                sequenceLength:
                    reqBody.removeBreakupEmail === true
                        ? 3
                        : (reqBody.sequenceLength === 3 || reqBody.sequenceLength === 4 ? reqBody.sequenceLength : undefined),
                includeBreakupEmail:
                    reqBody.removeBreakupEmail === true
                        ? false
                        : (typeof reqBody.includeBreakupEmail === "boolean" ? reqBody.includeBreakupEmail : undefined),
            });

            const unsubscribeBaseUrl =
                process.env.UNSUBSCRIBE_BASE_URL ||
                process.env.TRACKING_BASE_URL ||
                process.env.PUBLIC_URL ||
                smtp.trackingBaseUrl ||
                "";

            const generatedTouches: Array<{
                touchNumber: number;
                delayDays: number;
                objective: string;
                subject: string;
                html: string;
                text: string;
                toneUsed: string;
                ctaType: string;
                ctaText: string;
                deliverabilityRisk: string;
                strategyReasoning: string;
                diagnostics: ReturnType<typeof buildDeliverabilityDiagnostics>;
            }> = [];

            for (const touch of sequencePlan.touches) {
                const generated = await generatePersonalizedEmailBody(
                    { name: resolvedName, email: recipient.email, customFields },
                    {
                        ...campaignCtx,
                        toneUsed: sequencePlan.tone,
                        ctaType: touch.ctaType,
                        ctaText: touch.ctaText,
                        sequenceType: sequencePlan.sequenceType,
                        touchNumber: touch.touchNumber,
                        touchObjective: touch.objective,
                        previousTouchSummary: touch.previousTouchSummary,
                        recommendedDelayDays: touch.delayDays,
                        leadScore: strategyInput.leadScore,
                        painPoints: strategyInput.painPoints,
                        enrichmentData: strategyInput.enrichmentData ?? undefined,
                        shortenEmails: reqBody.shortenEmails === true,
                        strategyReasoning: [
                            sequencePlan.toneReasoning,
                            sequencePlan.ctaReasoning,
                            sequencePlan.sequenceReasoning,
                            `Touch ${touch.touchNumber}: ${touch.objective}.`,
                        ].join(" "),
                    },
                );

                if (!generated) continue;

                const diagnostics = buildDeliverabilityDiagnostics({
                    subject: generated.subject || campaign.subject,
                    html: generated.html,
                    text: generated.text,
                    smtpProvider: smtp.provider,
                    senderEmail: campaign.fromEmail,
                    recipientEmail: recipient.email,
                    trackingDomain: smtp.trackingBaseUrl ?? null,
                    unsubscribeHeaderPresence: Boolean(unsubscribeBaseUrl),
                });

                generatedTouches.push({
                    touchNumber: touch.touchNumber,
                    delayDays: touch.delayDays,
                    objective: touch.objective,
                    subject: generated.subject,
                    html: generated.html,
                    text: generated.text,
                    toneUsed: generated.toneUsed,
                    ctaType: generated.ctaType,
                    ctaText: generated.ctaText,
                    deliverabilityRisk: diagnostics.inboxRisk,
                    strategyReasoning: generated.strategyReasoning,
                    diagnostics,
                });
            }

            if (generatedTouches.length === 0) {
                failedCount++;
                console.error(`[generatePersonalizedEmails] failed to generate email sequence for ${recipient.email} in ${recipientMs}ms`);
                continue;
            }

            await db.delete(campaignSequenceTouchesTable).where(and(
                eq(campaignSequenceTouchesTable.campaignId, campaignId),
                eq(campaignSequenceTouchesTable.recipientId, recipient.id),
            ));

            await db.insert(campaignSequenceTouchesTable).values(
                generatedTouches.map((touch) => ({
                    campaignId,
                    recipientId: recipient.id,
                    touchNumber: touch.touchNumber,
                    sequenceType: sequencePlan.sequenceType,
                    objective: touch.objective,
                    recommendedDelayDays: touch.delayDays,
                    toneUsed: touch.toneUsed,
                    ctaType: touch.ctaType,
                    ctaText: touch.ctaText,
                    personalizedSubject: touch.subject,
                    personalizedBody: touch.html,
                    personalizedText: touch.text,
                    previousTouchSummary: sequencePlan.touches.find((item) => item.touchNumber === touch.touchNumber)?.previousTouchSummary ?? null,
                    deliverabilityRisk: touch.deliverabilityRisk,
                    strategyReasoning: touch.strategyReasoning,
                    executionStatus: "pending",
                    scheduledForAt: null,
                    sentAt: null,
                    messageId: null,
                    attemptCount: 0,
                    lastAttemptAt: null,
                    retryAfterAt: null,
                    lastError: null,
                    skippedAt: null,
                    skipReason: null,
                    bouncedAt: null,
                    repliedAt: null,
                    unsubscribedAt: null,
                    generationStatus: "generated",
                })),
            );

            await upsertSequenceStateFromGeneratedTouches({
                campaignId,
                recipientId: recipient.id,
                touchCount: generatedTouches.length,
            });

            const firstTouch = generatedTouches[0]!;
            const existing = await db.select({ id: campaignPersonalizedEmailsTable.id })
                .from(campaignPersonalizedEmailsTable)
                .where(and(
                    eq(campaignPersonalizedEmailsTable.campaignId, campaignId),
                    eq(campaignPersonalizedEmailsTable.recipientId, recipient.id),
                )).limit(1);

            if (existing[0]) {
                await db.update(campaignPersonalizedEmailsTable).set({
                    personalizedSubject: firstTouch.subject,
                    personalizedBody: firstTouch.html,
                    toneUsed: firstTouch.toneUsed,
                    ctaType: firstTouch.ctaType,
                    ctaText: firstTouch.ctaText,
                    sequenceType: sequencePlan.sequenceType,
                    touchNumber: 1,
                    deliverabilityRisk: firstTouch.deliverabilityRisk,
                    strategyReasoning: firstTouch.strategyReasoning,
                    generationStatus: 'generated',
                }).where(eq(campaignPersonalizedEmailsTable.id, existing[0].id));
            } else {
                await db.insert(campaignPersonalizedEmailsTable).values({
                    campaignId,
                    recipientId: recipient.id,
                    personalizedSubject: firstTouch.subject,
                    personalizedBody: firstTouch.html,
                    toneUsed: firstTouch.toneUsed,
                    ctaType: firstTouch.ctaType,
                    ctaText: firstTouch.ctaText,
                    sequenceType: sequencePlan.sequenceType,
                    touchNumber: 1,
                    deliverabilityRisk: firstTouch.deliverabilityRisk,
                    strategyReasoning: firstTouch.strategyReasoning,
                    generationStatus: 'generated',
                });
            }

            generatedCount++;
            totalGeneratedTouches += generatedTouches.length;

            if (!preview) {
                preview = {
                    recipientEmail: recipient.email,
                    subject: firstTouch.subject,
                    bodyText: firstTouch.text,
                };
            }
            if (!strategySummary) {
                strategySummary = {
                    tone: sequencePlan.tone,
                    ctaType: sequencePlan.ctaType,
                    ctaText: sequencePlan.ctaText,
                    sequenceType: sequencePlan.sequenceType,
                    outreachApproach: sequencePlan.outreachApproach,
                    reasoning: [
                        sequencePlan.toneReasoning,
                        sequencePlan.ctaReasoning,
                        sequencePlan.sequenceReasoning,
                    ],
                };
                touchSchedule = generatedTouches.map((touch) => touch.delayDays);
                previewSequence = generatedTouches.map((touch) => ({
                    touchNumber: touch.touchNumber,
                    subject: touch.subject,
                    bodyText: touch.text,
                    ctaType: touch.ctaType,
                    ctaText: touch.ctaText,
                    delayDays: touch.delayDays,
                    tone: touch.toneUsed,
                    objective: touch.objective,
                }));
            }

            for (const touch of generatedTouches) {
                const currentRiskRank = touch.diagnostics.inboxRisk === "high" ? 3 : touch.diagnostics.inboxRisk === "medium" ? 2 : 1;
                const existingRiskRank = deliverabilitySummary
                    ? deliverabilitySummary.inboxRisk === "high" ? 3 : deliverabilitySummary.inboxRisk === "medium" ? 2 : 1
                    : 0;
                if (!deliverabilitySummary || currentRiskRank >= existingRiskRank) {
                    deliverabilitySummary = touch.diagnostics;
                }
            }

            console.log(
                `[generatePersonalizedEmails] generated ${generatedTouches.length} touch(es) for ${recipient.email} in ${recipientMs}ms`,
            );
        }

        const totalMs = Date.now() - startTime;
        console.log(`[generatePersonalizedEmails] complete campaignId=${campaignId} generated=${generatedCount} failed=${failedCount} totalMs=${totalMs}`);

        res.status(200).json({
            message: 'Personalized email generation complete',
            campaignId,
            totalRecipients: recipients.length,
            generatedCount,
            failedCount,
            touchesPerLead: touchSchedule.length || 1,
            totalGeneratedTouches,
            modeUsed: campaignCtx.mode,
            preview,
            deliverability: deliverabilitySummary,
            strategy: strategySummary,
            touchSchedule,
            previewSequence,
        });
    } catch (error) {
        console.error('Error generating personalized emails:', error);
        res.status(500).json({ error: 'Failed to generate personalized emails' });
    }
};

export const getPersonalizedEmails = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const smtp = await getSmtpSettings(userId);
        const unsubscribeBaseUrl =
            process.env.UNSUBSCRIBE_BASE_URL ||
            process.env.TRACKING_BASE_URL ||
            process.env.PUBLIC_URL ||
            smtp.trackingBaseUrl ||
            "";

        const rows = await db
            .select({
                id: campaignPersonalizedEmailsTable.id,
                recipientId: campaignPersonalizedEmailsTable.recipientId,
                personalizedSubject: campaignPersonalizedEmailsTable.personalizedSubject,
                personalizedBody: campaignPersonalizedEmailsTable.personalizedBody,
                toneUsed: campaignPersonalizedEmailsTable.toneUsed,
                ctaType: campaignPersonalizedEmailsTable.ctaType,
                ctaText: campaignPersonalizedEmailsTable.ctaText,
                sequenceType: campaignPersonalizedEmailsTable.sequenceType,
                touchNumber: campaignPersonalizedEmailsTable.touchNumber,
                deliverabilityRisk: campaignPersonalizedEmailsTable.deliverabilityRisk,
                strategyReasoning: campaignPersonalizedEmailsTable.strategyReasoning,
                generationStatus: campaignPersonalizedEmailsTable.generationStatus,
                recipientEmail: recipientTable.email,
                recipientName: recipientTable.name,
                sequenceStatus: recipientSequenceStateTable.sequenceStatus,
                currentTouchNumber: recipientSequenceStateTable.currentTouchNumber,
                nextTouchNumber: recipientSequenceStateTable.nextTouchNumber,
                nextScheduledTouchAt: recipientSequenceStateTable.nextScheduledTouchAt,
                stopReason: recipientSequenceStateTable.stopReason,
            })
            .from(campaignPersonalizedEmailsTable)
            .innerJoin(recipientTable, eq(recipientTable.id, campaignPersonalizedEmailsTable.recipientId))
            .leftJoin(
                recipientSequenceStateTable,
                and(
                    eq(recipientSequenceStateTable.campaignId, campaignPersonalizedEmailsTable.campaignId),
                    eq(recipientSequenceStateTable.recipientId, campaignPersonalizedEmailsTable.recipientId),
                ),
            )
            .where(eq(campaignPersonalizedEmailsTable.campaignId, campaignId))
            .limit(Number(req.query.limit) || 100);

        const recipientIds = rows.map((row) => row.recipientId);
        const touchRows = recipientIds.length === 0
            ? []
            : await db
                .select({
                    recipientId: campaignSequenceTouchesTable.recipientId,
                    touchNumber: campaignSequenceTouchesTable.touchNumber,
                    sequenceType: campaignSequenceTouchesTable.sequenceType,
                    objective: campaignSequenceTouchesTable.objective,
                    recommendedDelayDays: campaignSequenceTouchesTable.recommendedDelayDays,
                    toneUsed: campaignSequenceTouchesTable.toneUsed,
                    ctaType: campaignSequenceTouchesTable.ctaType,
                    ctaText: campaignSequenceTouchesTable.ctaText,
                    personalizedSubject: campaignSequenceTouchesTable.personalizedSubject,
                    personalizedBody: campaignSequenceTouchesTable.personalizedBody,
                    personalizedText: campaignSequenceTouchesTable.personalizedText,
                    previousTouchSummary: campaignSequenceTouchesTable.previousTouchSummary,
                    deliverabilityRisk: campaignSequenceTouchesTable.deliverabilityRisk,
                    strategyReasoning: campaignSequenceTouchesTable.strategyReasoning,
                    executionStatus: campaignSequenceTouchesTable.executionStatus,
                    scheduledForAt: campaignSequenceTouchesTable.scheduledForAt,
                    sentAt: campaignSequenceTouchesTable.sentAt,
                    messageId: campaignSequenceTouchesTable.messageId,
                    attemptCount: campaignSequenceTouchesTable.attemptCount,
                    lastAttemptAt: campaignSequenceTouchesTable.lastAttemptAt,
                    retryAfterAt: campaignSequenceTouchesTable.retryAfterAt,
                    lastError: campaignSequenceTouchesTable.lastError,
                    skippedAt: campaignSequenceTouchesTable.skippedAt,
                    skipReason: campaignSequenceTouchesTable.skipReason,
                    bouncedAt: campaignSequenceTouchesTable.bouncedAt,
                    repliedAt: campaignSequenceTouchesTable.repliedAt,
                    unsubscribedAt: campaignSequenceTouchesTable.unsubscribedAt,
                })
                .from(campaignSequenceTouchesTable)
                .where(and(
                    eq(campaignSequenceTouchesTable.campaignId, campaignId),
                    inArray(campaignSequenceTouchesTable.recipientId, recipientIds),
                ));

        const touchesByRecipient = new Map<number, typeof touchRows>();
        for (const touch of touchRows) {
            const list = touchesByRecipient.get(touch.recipientId) ?? [];
            list.push(touch);
            touchesByRecipient.set(touch.recipientId, list);
        }

        const emails = rows.map((row) => ({
            ...row,
            deliverabilityDiagnostics: buildDeliverabilityDiagnostics({
                subject: row.personalizedSubject || campaign.subject,
                html: row.personalizedBody,
                smtpProvider: smtp.provider,
                senderEmail: campaign.fromEmail,
                recipientEmail: row.recipientEmail,
                trackingDomain: smtp.trackingBaseUrl ?? null,
                unsubscribeHeaderPresence: Boolean(unsubscribeBaseUrl),
            }),
            sequenceTouches: (touchesByRecipient.get(row.recipientId) ?? [])
                .sort((a, b) => a.touchNumber - b.touchNumber)
                .map((touch) => ({
                    ...touch,
                    deliverabilityDiagnostics: buildDeliverabilityDiagnostics({
                        subject: touch.personalizedSubject || campaign.subject,
                        html: touch.personalizedBody,
                        text: touch.personalizedText ?? undefined,
                        smtpProvider: smtp.provider,
                        senderEmail: campaign.fromEmail,
                        recipientEmail: row.recipientEmail,
                        trackingDomain: smtp.trackingBaseUrl ?? null,
                        unsubscribeHeaderPresence: Boolean(unsubscribeBaseUrl),
                    }),
                })),
        }));

        res.status(200).json({
            campaignId,
            total: emails.length,
            emails,
        });
    } catch (error) {
        console.error('Error fetching personalized emails:', error);
        res.status(500).json({ error: 'Failed to retrieve personalized emails' });
    }
};
