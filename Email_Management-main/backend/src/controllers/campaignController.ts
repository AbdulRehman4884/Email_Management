import { campaignTable, recipientTable, statsTable, emailRepliesTable } from "../db/schema";
import { suppressionListTable } from "../db/schema";
import { eq, and, or, count, inArray, sql, desc, isNotNull, ilike, type SQL } from "drizzle-orm";
import { db, dbPool } from "../lib/db";
import type { Request, Response } from "express";
import csv from "csv-parser";
import { Readable } from "stream";
import * as XLSX from "xlsx";
import type { CSVRequest, Recipient } from "../types/reciepients";
import { sendEmail as sendViaSmtp } from "../lib/smtp.js";
import { normalizeMessageId } from "../lib/messageId.js";
import { resolveCanonicalThreadRootIdForRecipient } from "../lib/replyThreading.js";
import { replacePlaceholders } from "../lib/replacePlaceholders.js";

function escapeHtmlForFollowUp(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Comma-separated `campaignIds` query: filter to those campaigns. Missing/empty = all campaigns for this user. Invalid ids dropped; if none left, []. */
async function resolveCampaignIdsFromQuery(userId: number, req: Request): Promise<number[]> {
    const userRows = await db.select({ id: campaignTable.id }).from(campaignTable).where(eq(campaignTable.userId, userId));
    const allowed = new Set(userRows.map((r) => r.id));
    const raw = req.query.campaignIds;
    if (raw === undefined || raw === '') {
        return [...allowed];
    }
    const str = Array.isArray(raw) ? raw.join(',') : String(raw);
    if (!str.trim()) {
        return [...allowed];
    }
    const requested = str.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
    const filtered = [...new Set(requested.filter((id) => allowed.has(id)))];
    return filtered;
}

const RECIPIENT_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Outbound rows in `email_replies` per recipient (follow-ups only). */
function recipientFollowUpCountExpr() {
    return sql<number>`(
        SELECT COUNT(*)::int FROM ${emailRepliesTable} fu
        WHERE fu.recipient_id = ${recipientTable.id}
          AND fu.campaign_id = ${recipientTable.campaignId}
          AND fu.direction = 'outbound'
    )`.mapWith(Number);
}

function parseSentFollowUpFilter(req: Request): SQL | undefined {
    const rawMin = req.query.followUpCountMin;
    const rawExact = req.query.followUpCount;
    if (rawMin !== undefined && rawMin !== '') {
        const n = parseInt(String(rawMin), 10);
        if (Number.isFinite(n) && n >= 0) {
            return sql`${recipientFollowUpCountExpr()} >= ${n}`;
        }
    }
    if (rawExact !== undefined && rawExact !== '') {
        const n = parseInt(String(rawExact), 10);
        if (Number.isFinite(n) && n >= 0) {
            return sql`${recipientFollowUpCountExpr()} = ${n}`;
        }
    }
    return undefined;
}

function normalizeColumnName(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
}

interface ParsedExcelResult {
    columns: string[];
    rows: Array<{
        email: string;
        name: string | null;
        customFields: Record<string, string>;
    }>;
}

function parseExcelBuffer(buffer: Buffer): ParsedExcelResult {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { columns: [], rows: [] };
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return { columns: [], rows: [] };
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    
    if (rawRows.length === 0) return { columns: [], rows: [] };
    
    const firstRow = rawRows[0];
    if (!firstRow) return { columns: [], rows: [] };
    const originalColumns = Object.keys(firstRow);
    
    const columnMapping: Record<string, string> = {};
    const normalizedColumns: string[] = [];
    
    for (const col of originalColumns) {
        const normalized = normalizeColumnName(col);
        if (normalized && normalized !== 'email') {
            columnMapping[col] = normalized;
            if (!normalizedColumns.includes(normalized)) {
                normalizedColumns.push(normalized);
            }
        }
    }
    
    const rows = rawRows.map((row) => {
        const keys = Object.keys(row);
        const emailKey = keys.find((k) => k.toLowerCase() === "email");
        const nameKey = keys.find((k) => k.toLowerCase().trim() === "name");
        
        const email = emailKey ? String(row[emailKey] ?? "").trim() : "";
        const name = nameKey ? String(row[nameKey] ?? "").trim() || null : null;
        
        const customFields: Record<string, string> = {};
        for (const [originalCol, normalizedCol] of Object.entries(columnMapping)) {
            const value = row[originalCol];
            if (value !== undefined && value !== null && value !== '') {
                customFields[normalizedCol] = String(value).trim();
            }
        }
        
        return { email, name, customFields };
    }).filter((r) => r.email);
    
    return { columns: normalizedColumns, rows };
}
import { buildHtml, type TemplateId } from "../lib/emailTemplates";
import { getSmtpSettings, requireSmtpProfile } from "../lib/smtpSettings";
import { CAMPAIGN_LIMITS, firstLengthViolation } from "../constants/fieldLimits";
import { isFutureLocalTimestamp, normalizeLocalScheduleInput, isScheduledTimeReached, parseLocalTimestamp } from "../lib/localDateTime";

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

export const createCampaign = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const { name, subject, emailContent, templateId, templateData, scheduledAt, pauseAt, smtpSettingsId: smtpIdRaw } = req.body;
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

        let validPauseAt: string | null = null;
        if (pauseAt) {
            const normalizedPause = normalizeLocalScheduleInput(String(pauseAt));
            if (!normalizedPause) {
                return res.status(400).json({ error: 'Invalid pauseAt date format' });
            }
            if (!isFutureLocalTimestamp(normalizedPause)) {
                return res.status(400).json({ error: 'Pause time must be in the future' });
            }
            if (validScheduledAt) {
                const sched = parseLocalTimestamp(validScheduledAt);
                const paus = parseLocalTimestamp(normalizedPause);
                if (sched && paus && paus.getTime() <= sched.getTime()) {
                    return res.status(400).json({ error: 'Pause time must be after the scheduled time' });
                }
            }
            validPauseAt = normalizedPause;
        }

        const smtpProfileId = Number(smtpIdRaw);
        if (!Number.isFinite(smtpProfileId) || smtpProfileId < 1) {
            return res.status(400).json({
                error: 'smtpSettingsId is required — choose which SMTP account sends this campaign.',
            });
        }
        let smtp;
        try {
            smtp = await requireSmtpProfile(userId, smtpProfileId);
        } catch {
            return res.status(400).json({ error: 'Invalid or unauthorized SMTP profile.' });
        }
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
            return res.status(400).json({ error: 'Configure SMTP from email on the selected profile' });
        }
        const result = await db.insert(campaignTable).values({
            userId,
            smtpSettingsId: smtpProfileId,
            name: nameStr,
            status: validScheduledAt ? 'scheduled' : 'draft',
            subject: subjectStr,
            emailContent: content,
            fromName: fromNameResolved,
            fromEmail: fromEmailResolved,
            scheduledAt: validScheduledAt ? scheduledAtAsPostgresVarchar(validScheduledAt) : null,
            pauseAt: validPauseAt ? scheduledAtAsPostgresVarchar(validPauseAt) : null,
        }).returning();
        
        if (!result[0]) {
            return res.status(500).json({ error: 'Failed to create campaign' });
        }
        console.log(`[Campaign] Created #${result[0].id} status=${result[0].status} scheduledAt="${result[0].scheduledAt}" pauseAt="${result[0].pauseAt ?? ''}"`);
        
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

const FOLLOW_UP_TEMPLATE_LIMITS = {
  maxTemplates: 30,
  title: 200,
  subject: 255,
  body: 10000,
} as const;

export type FollowUpTemplateDto = { id: string; title: string; subject: string; body: string };

function normalizeFollowUpTemplatesInput(raw: unknown): { ok: true; value: FollowUpTemplateDto[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'followUpTemplates must be an array' };
  }
  if (raw.length > FOLLOW_UP_TEMPLATE_LIMITS.maxTemplates) {
    return { ok: false, error: `At most ${FOLLOW_UP_TEMPLATE_LIMITS.maxTemplates} follow-up templates allowed` };
  }
  const out: FollowUpTemplateDto[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `Invalid template at index ${i}` };
    }
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    const title = String(o.title ?? '').trim();
    const subject = String(o.subject ?? '').trim();
    const body = String(o.body ?? '').trim();
    if (!id) {
      return { ok: false, error: `Template id is required at index ${i}` };
    }
    if (!subject) {
      return { ok: false, error: `Template subject is required at index ${i}` };
    }
    if (!body) {
      return { ok: false, error: `Template body is required at index ${i}` };
    }
    if (title.length > FOLLOW_UP_TEMPLATE_LIMITS.title) {
      return { ok: false, error: `Template title too long at index ${i}` };
    }
    if (subject.length > FOLLOW_UP_TEMPLATE_LIMITS.subject) {
      return { ok: false, error: `Template subject too long at index ${i}` };
    }
    if (body.length > FOLLOW_UP_TEMPLATE_LIMITS.body) {
      return { ok: false, error: `Template body too long at index ${i}` };
    }
    out.push({ id, title, subject, body });
  }
  return { ok: true, value: out };
}

/** Updates follow-up templates and/or skip-confirm flag for any campaign status. */
export const patchCampaignFollowUpSettings = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const campaignId = Number(req.params.id);
    if (!Number.isFinite(campaignId) || campaignId < 1) {
      return res.status(400).json({ error: 'Invalid campaign id' });
    }

    const [existing] = await db
      .select({ id: campaignTable.id })
      .from(campaignTable)
      .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const { followUpTemplates, followUpSkipConfirm } = req.body ?? {};
    if (followUpTemplates === undefined && followUpSkipConfirm === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    let templatesValue: FollowUpTemplateDto[] | undefined;
    if (followUpTemplates !== undefined) {
      const norm = normalizeFollowUpTemplatesInput(followUpTemplates);
      if (!norm.ok) {
        return res.status(400).json({ error: norm.error });
      }
      templatesValue = norm.value;
    }

    const [row] = await db
      .update(campaignTable)
      .set({
        ...(templatesValue !== undefined ? { followUpTemplates: templatesValue } : {}),
        ...(followUpSkipConfirm !== undefined ? { followUpSkipConfirm: Boolean(followUpSkipConfirm) } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
      .returning();

    return res.status(200).json(row);
  } catch (error) {
    console.error('Error patching follow-up settings:', error);
    return res.status(500).json({ error: 'Failed to update follow-up settings' });
  }
};

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
        const { name, subject, emailContent, templateId, templateData, scheduledAt, pauseAt, smtpSettingsId: smtpIdBody } = req.body;
        
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

        let validPauseAt: string | null | undefined = undefined;
        if (pauseAt !== undefined) {
            if (pauseAt) {
                const normalizedPause = normalizeLocalScheduleInput(String(pauseAt));
                if (!normalizedPause) {
                    return res.status(400).json({ error: 'Invalid pauseAt date format' });
                }
                if (!isFutureLocalTimestamp(normalizedPause)) {
                    return res.status(400).json({ error: 'Pause time must be in the future' });
                }
                validPauseAt = normalizedPause;
            } else {
                validPauseAt = null;
            }
        }

        const resolvedScheduledAt = validScheduledAt !== undefined ? validScheduledAt : existing[0].scheduledAt;
        const resolvedPauseAt = validPauseAt !== undefined ? validPauseAt : existing[0].pauseAt;
        if (resolvedPauseAt && resolvedScheduledAt) {
            const sched = parseLocalTimestamp(resolvedScheduledAt);
            const paus = parseLocalTimestamp(resolvedPauseAt);
            if (sched && paus && paus.getTime() <= sched.getTime()) {
                return res.status(400).json({ error: 'Pause time must be after the scheduled time' });
            }
        }
        let resolvedSmtpId: number | null = existing[0].smtpSettingsId ?? null;
        if (smtpIdBody !== undefined && smtpIdBody !== null && smtpIdBody !== '') {
            const n = Number(smtpIdBody);
            if (!Number.isFinite(n) || n < 1) {
                return res.status(400).json({ error: 'Invalid smtpSettingsId' });
            }
            try {
                await requireSmtpProfile(userId, n);
            } catch {
                return res.status(400).json({ error: 'Invalid or unauthorized SMTP profile.' });
            }
            resolvedSmtpId = n;
        }
        const smtp = await getSmtpSettings(userId, resolvedSmtpId);
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
            smtpSettingsId: resolvedSmtpId,
            fromName: fromNameResolved,
            fromEmail: fromEmailResolved,
            scheduledAt: resolvedScheduledAt ? scheduledAtAsPostgresVarchar(resolvedScheduledAt) : null,
            pauseAt: resolvedPauseAt ? scheduledAtAsPostgresVarchar(resolvedPauseAt) : null,
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
        await db.delete(recipientTable).where(eq(recipientTable.campaignId, campaignId));
        await db.delete(statsTable).where(eq(statsTable.campaignId, campaignId));
        await db.delete(campaignTable).where(eq(campaignTable.id, campaignId));
        res.status(200).json({ message: 'Campaign deleted successfully' });
    } catch (error) {
        console.error('Error deleting campaign:', error);
        res.status(500).json({ error: 'Failed to delete campaign' });
    }
}

function parseCSVBuffer(buffer: Buffer): Promise<ParsedExcelResult> {
    return new Promise((resolve, reject) => {
        const rows: Array<{ email: string; name: string | null; customFields: Record<string, string> }> = [];
        const columns: string[] = [];
        let columnMapping: Record<string, string> = {};
        let isFirstRow = true;
        
        const stream = Readable.from(buffer);
        stream
            .pipe(csv())
            .on('headers', (headers: string[]) => {
                for (const col of headers) {
                    const normalized = normalizeColumnName(col);
                    if (normalized && normalized !== 'email') {
                        columnMapping[col] = normalized;
                        if (!columns.includes(normalized)) {
                            columns.push(normalized);
                        }
                    }
                }
            })
            .on('data', (data: Record<string, string>) => {
                const keys = Object.keys(data);
                const emailKey = keys.find((k) => k.toLowerCase() === "email");
                const nameKey = keys.find((k) => k.toLowerCase().trim() === "name");

                const email = emailKey ? String(data[emailKey] ?? "").trim() : "";
                if (!email) return;

                const name = nameKey ? String(data[nameKey] ?? "").trim() || null : null;
                
                const customFields: Record<string, string> = {};
                for (const [originalCol, normalizedCol] of Object.entries(columnMapping)) {
                    const value = data[originalCol];
                    if (value !== undefined && value !== null && value !== '') {
                        customFields[normalizedCol] = String(value).trim();
                    }
                }
                
                rows.push({ email, name, customFields });
            })
            .on('end', () => resolve({ columns, rows }))
            .on('error', reject);
    });
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

        const parsed = isExcel 
            ? parseExcelBuffer(req.file.buffer)
            : await parseCSVBuffer(req.file.buffer);
        
        const { columns, rows } = parsed;
        
        const byEmail = new Map<string, { email: string; name: string | null; customFields: Record<string, string> }>();
        for (const r of rows) {
            if (!r.email || suppressedSet.has(r.email)) continue;
            const key = r.email.toLowerCase().trim();
            if (!byEmail.has(key)) {
                byEmail.set(key, { 
                    email: r.email.trim(), 
                    name: r.name, 
                    customFields: r.customFields 
                });
            }
        }
        
        const toAdd = Array.from(byEmail.values()).filter((r) => !existingSet.has(r.email.toLowerCase()));
        const validToAdd = toAdd.filter((r) => RECIPIENT_EMAIL_REGEX.test(r.email));
        const rejectedCount = toAdd.length - validToAdd.length;
        
        const recipients = validToAdd.map((r) => ({ 
            campaignId, 
            email: r.email, 
            name: r.name ?? null, 
            customFields: Object.keys(r.customFields).length > 0 ? JSON.stringify(r.customFields) : null,
            status: 'pending' as const 
        }));
        
        const existingColumns: string[] = campaign.availableColumns 
            ? JSON.parse(campaign.availableColumns) 
            : [];
        const mergedColumns = [...new Set([...existingColumns, ...columns])];
        
        if (recipients.length > 0) {
            await db.insert(recipientTable).values(recipients);
        }
        
        await db.update(campaignTable).set({
            recieptCount: sql`${campaignTable.recieptCount} + ${recipients.length}`,
            availableColumns: JSON.stringify(mergedColumns),
            updatedAt: sql`now()`,
        }).where(eq(campaignTable.id, campaignId));
        
        res.status(200).json({ 
            message: 'Recipients uploaded successfully', 
            addedCount: recipients.length, 
            rejectedCount,
            availableColumns: mergedColumns
        });
    } catch (error) {
        console.error('Error processing file:', error);
        res.status(500).json({ error: 'Failed to process file. Use CSV or Excel with email column.' });
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
        const filter = req.query.filter as string | undefined;

        // Build WHERE conditions based on filter
        const baseCondition = eq(recipientTable.campaignId, Number(id));
        let whereCondition;
        
        if (filter === 'delivered') {
            // Strict: only show recipients that are actually delivered (not merely sent).
            whereCondition = and(baseCondition, eq(recipientTable.status, 'delivered'));
        } else if (filter === 'opened') {
            whereCondition = and(baseCondition, isNotNull(recipientTable.openedAt));
        } else if (filter === 'replied') {
            whereCondition = and(baseCondition, isNotNull(recipientTable.repliedAt));
        } else {
            whereCondition = baseCondition;
        }

        const recipients = await db.select().from(recipientTable)
            .where(whereCondition)
            .limit(limit)
            .offset(offset);
        const totalResult = await db.select({ count: count() }).from(recipientTable)
            .where(whereCondition);
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

function extractPlaceholders(content: string): string[] {
    const placeholders: Set<string> = new Set();
    const singleBraceRegex = /\{([a-z_][a-z0-9_]*)\}/gi;
    const doubleBraceRegex = /\{\{([a-z_][a-z0-9_]*)\}\}/gi;
    
    let match;
    while ((match = singleBraceRegex.exec(content)) !== null) {
        if (match[1]) placeholders.add(match[1].toLowerCase());
    }
    while ((match = doubleBraceRegex.exec(content)) !== null) {
        if (match[1]) placeholders.add(match[1].toLowerCase());
    }
    
    return Array.from(placeholders);
}

export function validatePlaceholdersAgainstColumns(
    emailContent: string, 
    subject: string,
    availableColumns: string[]
): { valid: boolean; missingColumns: string[]; usedPlaceholders: string[] } {
    const contentPlaceholders = extractPlaceholders(emailContent);
    const subjectPlaceholders = extractPlaceholders(subject);
    const allPlaceholders = [...new Set([...contentPlaceholders, ...subjectPlaceholders])];
    
    const availableSet = new Set(availableColumns.map(c => c.toLowerCase()));
    availableSet.add('email');
    availableSet.add('name');
    availableSet.add('firstname');
    availableSet.add('first_name');
    
    const missingColumns = allPlaceholders.filter(p => !availableSet.has(p.toLowerCase()));
    
    return {
        valid: missingColumns.length === 0,
        missingColumns,
        usedPlaceholders: allPlaceholders
    };
}

export const validatePlaceholders = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        const campaignId = Number(req.params.id);
        const [campaign] = await db.select().from(campaignTable)
            .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId)))
            .limit(1);
        
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        
        const availableColumns: string[] = campaign.availableColumns 
            ? JSON.parse(campaign.availableColumns) 
            : [];
        
        const validation = validatePlaceholdersAgainstColumns(
            campaign.emailContent,
            campaign.subject,
            availableColumns
        );
        
        res.status(200).json({
            valid: validation.valid,
            missingColumns: validation.missingColumns,
            usedPlaceholders: validation.usedPlaceholders,
            availableColumns
        });
    } catch (error) {
        console.error('Error validating placeholders:', error);
        res.status(500).json({ error: 'Failed to validate placeholders' });
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

        const availableColumns: string[] = campaign[0].availableColumns 
            ? JSON.parse(campaign[0].availableColumns) 
            : [];
        
        const validation = validatePlaceholdersAgainstColumns(
            campaign[0].emailContent,
            campaign[0].subject,
            availableColumns
        );
        
        if (!validation.valid) {
            return res.status(400).json({ 
                error: `Invalid placeholders in email content. The following columns do not exist in your uploaded data: ${validation.missingColumns.join(', ')}`,
                missingColumns: validation.missingColumns,
                availableColumns
            });
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
        
        await db.update(campaignTable).set({ status: 'paused', pauseAt: null, updatedAt: sql`now()` }).where(eq(campaignTable.id, Number(id)));
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

        await db.update(campaignTable).set({ status: 'in_progress', pauseAt: null, updatedAt: sql`now()` }).where(eq(campaignTable.id, Number(id)));
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
        const filterIds = await resolveCampaignIdsFromQuery(userId, req);
        if (filterIds.length === 0) {
            return res.status(200).json({
                totalCampaigns: 0,
                activeCampaigns: 0,
                totalEmailsSent: 0,
                totalDelivered: 0,
                totalBounces: 0,
                totalComplaints: 0,
                totalFailed: 0,
                totalOpened: 0,
                totalReplied: 0,
                averageDeliveryRate: 0,
                totalRecipientCountInScope: 0,
                timeSeries: [] as Array<{ day: string; sent: number; delivered: number; opened: number; clicked: number }>,
            });
        }
        const campaigns = await db.select().from(campaignTable).where(
            and(eq(campaignTable.userId, userId), inArray(campaignTable.id, filterIds))
        );
        const campaignIds = filterIds;
        const allStats = campaignIds.length > 0
            ? await db.select().from(statsTable).where(inArray(statsTable.campaignId, campaignIds))
            : [];
        const totalCampaigns = campaigns.length;
        const activeCampaigns = campaigns.filter(c => c.status === 'in_progress' || c.status === 'scheduled').length;
        /** List size + sent count from same source (recipients in scope) so rates never exceed 100% from mismatched stats vs campaign.reciept_count. */
        let totalRecipientCountInScope = 0;
        let sentFromRecipients = 0;
        if (campaignIds.length > 0) {
            const scopeR = await dbPool.query(
                `
                SELECT
                  count(*)::int AS total_rows,
                  count(*) FILTER (
                    WHERE sent_at IS NOT NULL
                      OR (message_id IS NOT NULL AND length(trim(message_id)) > 0)
                      OR status IN ('sent', 'delivered', 'bounced', 'failed', 'complained')
                  )::int AS sent_n
                FROM recipients
                WHERE campaign_id = ANY($1::int[])
                `,
                [campaignIds],
            );
            const scopeRow = scopeR.rows[0] as { total_rows?: number; sent_n?: number } | undefined;
            totalRecipientCountInScope = scopeRow?.total_rows ?? 0;
            sentFromRecipients = scopeRow?.sent_n ?? 0;
        }
        const totalEmailsSent = sentFromRecipients;
        const totalDelivered = allStats.reduce((sum, s) => sum + (s.delieveredCount || 0), 0);
        const totalBounces = allStats.reduce((sum, s) => sum + (s.bouncedCount || 0), 0);
        const totalComplaints = allStats.reduce((sum, s) => sum + (s.complainedCount || 0), 0);
        const totalFailed = allStats.reduce((sum, s) => sum + (s.failedCount || 0), 0);
        const totalOpened = allStats.reduce((sum, s) => sum + (s.openedCount || 0), 0);
        // Reply count used for reply rate should exclude system notifications (mailer-daemon/postmaster).
        // We compute distinct recipients with at least one non-system inbound reply.
        let totalReplied = 0;
        if (campaignIds.length > 0) {
            const replyCountResult = await dbPool.query(
                `
                SELECT count(DISTINCT er.recipient_id)::int AS c
                FROM email_replies er
                INNER JOIN campaigns c ON er.campaign_id = c.id
                WHERE c.user_id = $1
                  AND er.campaign_id = ANY($2::int[])
                  AND er.direction = 'inbound'
                  AND NOT (
                    LOWER(SPLIT_PART(er.from_email, '@', 1)) = 'mailer-daemon'
                    OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon-%'
                    OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon+%'
                    OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon.%'
                    OR POSITION('postmaster' IN LOWER(SPLIT_PART(er.from_email, '@', 1))) > 0
                  )
                `,
                [userId, campaignIds]
            );
            totalReplied = (replyCountResult.rows[0] as { c?: number } | undefined)?.c ?? 0;
        }

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
                `SELECT sent_at, delivered_at, opened_at
                 FROM recipients
                 WHERE campaign_id = ANY($1::int[])`,
                [campaignIds]
            );

            // For "clicked" (engagement proxy), use non-system inbound reply timestamps.
            const replyRows = await dbPool.query(
                `
                SELECT er.received_at
                FROM email_replies er
                INNER JOIN campaigns c ON er.campaign_id = c.id
                WHERE c.user_id = $1
                  AND er.campaign_id = ANY($2::int[])
                  AND er.direction = 'inbound'
                  AND NOT (
                    LOWER(SPLIT_PART(er.from_email, '@', 1)) = 'mailer-daemon'
                    OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon-%'
                    OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon+%'
                    OR LOWER(SPLIT_PART(er.from_email, '@', 1)) LIKE 'mailer-daemon.%'
                    OR POSITION('postmaster' IN LOWER(SPLIT_PART(er.from_email, '@', 1))) > 0
                  )
                `,
                [userId, campaignIds]
            );

            const allDates: Date[] = [];
            for (const row of rows.rows as Array<Record<string, unknown>>) {
                for (const key of ["sent_at", "delivered_at", "opened_at"] as const) {
                    const raw = row[key];
                    if (!raw) continue;
                    const dt = new Date(String(raw));
                    if (!Number.isNaN(dt.getTime())) allDates.push(dt);
                }
            }
            for (const row of replyRows.rows as Array<Record<string, unknown>>) {
                const raw = row.received_at;
                if (!raw) continue;
                const dt = new Date(String(raw));
                if (!Number.isNaN(dt.getTime())) allDates.push(dt);
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
                    if (idx == null || !buckets[idx]) return;
                    buckets[idx][field] += 1;
                };

                for (const row of rows.rows as Array<Record<string, unknown>>) {
                    addByMonth(row.sent_at, "sent");
                    addByMonth(row.delivered_at, "delivered");
                    addByMonth(row.opened_at, "opened");
                }
                // Click tracking is not stored yet; using non-system reply timestamp as engagement proxy.
                for (const row of replyRows.rows as Array<Record<string, unknown>>) {
                    addByMonth(row.received_at, "clicked");
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
                    if (idx == null || !buckets[idx]) return;
                    buckets[idx][field] += 1;
                };

                for (const row of rows.rows as Array<Record<string, unknown>>) {
                    addByDate(row.sent_at, "sent");
                    addByDate(row.delivered_at, "delivered");
                    addByDate(row.opened_at, "opened");
                }
                // Click tracking is not stored yet; using non-system reply timestamp as engagement proxy.
                for (const row of replyRows.rows as Array<Record<string, unknown>>) {
                    addByDate(row.received_at, "clicked");
                }

                timeSeries.push(...buckets);
            }
        }

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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
            totalRecipientCountInScope,
            timeSeries,
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Failed to retrieve dashboard stats' });
    }
}

export const getSentEmails = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
        
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        const campaignIds = await resolveCampaignIdsFromQuery(userId, req);
        if (campaignIds.length === 0) {
            return res.status(200).json({
                emails: [],
                total: 0,
                counts: { all: 0, delivered: 0, opened: 0, replied: 0, failed: 0 },
            });
        }

        const searchRaw = String(req.query.search ?? '').trim();
        // Inbox "Sent" view should include:
        // - successful sends (sent_at or message_id or status in sent/delivered)
        // - failures (status in failed/bounced/complained) so "Failed" filter can show rows
        const baseCond = [
            eq(campaignTable.userId, userId),
            inArray(recipientTable.campaignId, campaignIds),
            or(
                isNotNull(recipientTable.sentAt),
                isNotNull(recipientTable.messageId),
                inArray(recipientTable.status, ['sent', 'delivered', 'failed', 'bounced', 'complained']),
            )!,
        ] as const;
        const followFilter = parseSentFollowUpFilter(req);
        const scopeCond =
            searchRaw.length > 0 && followFilter
                ? and(
                      ...baseCond,
                      or(
                          ilike(recipientTable.email, `%${searchRaw}%`),
                          ilike(recipientTable.name, `%${searchRaw}%`),
                          ilike(campaignTable.name, `%${searchRaw}%`),
                      )!,
                      followFilter,
                  )
                : searchRaw.length > 0
                  ? and(
                        ...baseCond,
                        or(
                            ilike(recipientTable.email, `%${searchRaw}%`),
                            ilike(recipientTable.name, `%${searchRaw}%`),
                            ilike(campaignTable.name, `%${searchRaw}%`),
                        )!,
                    )
                  : followFilter
                    ? and(...baseCond, followFilter)
                    : and(...baseCond);

        // Sent tab filter (applies to list + pagination), counts ignore this filter.
        const sentFilterRaw = String(req.query.sentFilter ?? 'all').trim().toLowerCase();
        const FAILED_SET = ['failed', 'bounced', 'complained'] as const;
        const sentFilterCond =
            sentFilterRaw === 'failed'
                ? inArray(recipientTable.status, FAILED_SET as unknown as string[])
                : sentFilterRaw === 'delivered'
                  ? sql`NOT (${recipientTable.status} = ANY(ARRAY['failed','bounced','complained']))`
                  : sentFilterRaw === 'opened'
                    ? isNotNull(recipientTable.openedAt)
                    : sentFilterRaw === 'replied'
                      ? isNotNull(recipientTable.repliedAt)
                      : undefined;

        const listCond = sentFilterCond ? and(scopeCond, sentFilterCond) : scopeCond;

        const sentEmails = await db
            .select({
                id: recipientTable.id,
                email: recipientTable.email,
                name: recipientTable.name,
                campaignId: recipientTable.campaignId,
                campaignName: campaignTable.name,
                status: recipientTable.status,
                sentAt: recipientTable.sentAt,
                openedAt: recipientTable.openedAt,
                repliedAt: recipientTable.repliedAt,
                followUpCount: recipientFollowUpCountExpr(),
            })
            .from(recipientTable)
            .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
            .where(listCond)
            .orderBy(desc(recipientTable.id))
            .limit(limit)
            .offset(offset);

        const [totalResult, countsResult] = await Promise.all([
            db
                .select({ count: count() })
                .from(recipientTable)
                .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
                .where(listCond),
            db
                .select({
                    all: count(),
                    failed: sql<number>`COUNT(*) FILTER (WHERE ${recipientTable.status} = ANY(ARRAY['failed','bounced','complained']))::int`.mapWith(Number),
                    opened: sql<number>`COUNT(*) FILTER (WHERE ${recipientTable.openedAt} IS NOT NULL)::int`.mapWith(Number),
                    replied: sql<number>`COUNT(*) FILTER (WHERE ${recipientTable.repliedAt} IS NOT NULL)::int`.mapWith(Number),
                })
                .from(recipientTable)
                .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
                .where(scopeCond),
        ]);

        const total = Number(totalResult[0]?.count || 0);
        const c0 = countsResult[0];
        const all = Number(c0?.all ?? 0);
        const failed = Number(c0?.failed ?? 0);
        const opened = Number(c0?.opened ?? 0);
        const replied = Number(c0?.replied ?? 0);
        const delivered = Math.max(0, all - failed);

        res.status(200).json({
            emails: sentEmails,
            total,
            counts: { all, delivered, opened, replied, failed },
        });
    } catch (error) {
        console.error('Error fetching sent emails:', error);
        res.status(500).json({ error: 'Failed to retrieve sent emails' });
    }
}

export const sendFollowUpEmail = async (req: Request, res: Response) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });

        const campaignId = Number(req.params.id);
        const recipientId = Number(req.params.recipientId);
        if (!Number.isFinite(campaignId) || !Number.isFinite(recipientId)) {
            return res.status(400).json({ error: 'Invalid campaign or recipient id' });
        }

        const subject = String(req.body?.subject ?? '').trim();
        const body = String(req.body?.body ?? '').trim();
        if (!subject) return res.status(400).json({ error: 'Subject is required' });
        if (!body) return res.status(400).json({ error: 'Body is required' });

        // Auth-scope check: load recipient + parent campaign and confirm ownership
        const rows = await db
            .select({
                recipientEmail: recipientTable.email,
                recipientName: recipientTable.name,
                recipientCustomFields: recipientTable.customFields,
                campaignFromName: campaignTable.fromName,
                campaignFromEmail: campaignTable.fromEmail,
                campaignSmtpSettingsId: campaignTable.smtpSettingsId,
            })
            .from(recipientTable)
            .innerJoin(campaignTable, eq(recipientTable.campaignId, campaignTable.id))
            .where(
                and(
                    eq(recipientTable.id, recipientId),
                    eq(recipientTable.campaignId, campaignId),
                    eq(campaignTable.userId, userId)
                )
            )
            .limit(1);

        const row = rows[0];
        if (!row) return res.status(404).json({ error: 'Recipient not found' });

        const recipientForTokens = {
            email: row.recipientEmail,
            name: row.recipientName,
            customFields: row.recipientCustomFields,
        };
        const resolvedSubject = replacePlaceholders(subject, recipientForTokens).trim();
        const resolvedBody = replacePlaceholders(body, recipientForTokens).trim();
        if (!resolvedSubject) {
            return res.status(400).json({ error: 'Subject is empty after resolving placeholders' });
        }
        if (!resolvedBody) {
            return res.status(400).json({ error: 'Body is empty after resolving placeholders' });
        }

        const safeHtml = `<p style="white-space:pre-wrap;margin:0;">${escapeHtmlForFollowUp(resolvedBody)}</p>`;

        const sentRawMessageId = await sendViaSmtp({
            to: row.recipientEmail,
            subject: resolvedSubject,
            text: resolvedBody,
            html: safeHtml,
            fromName: row.campaignFromName,
            fromEmail: row.campaignFromEmail,
            userId,
            smtpSettingsId: row.campaignSmtpSettingsId,
        });

        const sentMessageId = normalizeMessageId(sentRawMessageId || undefined);

        const existingThreadRoot = await resolveCanonicalThreadRootIdForRecipient(campaignId, recipientId);

        // Persist outbound row; attach to existing conversation when present (same root as first reply/follow-up).
        const [inserted] = await db
            .insert(emailRepliesTable)
            .values({
                campaignId,
                recipientId,
                fromEmail: row.campaignFromEmail,
                subject: resolvedSubject,
                bodyText: resolvedBody,
                bodyHtml: safeHtml.slice(0, 20000),
                messageId: sentMessageId,
                inReplyTo: null,
                direction: 'outbound',
                threadRootId: existingThreadRoot ?? null,
            })
            .returning({ id: emailRepliesTable.id });

        const newId = inserted?.id;
        if (newId != null && existingThreadRoot == null) {
            await db
                .update(emailRepliesTable)
                .set({ threadRootId: newId })
                .where(eq(emailRepliesTable.id, newId));
        }

        return res.status(200).json({ message: 'Follow-up sent' });
    } catch (error) {
        console.error('Error sending follow-up email:', error);
        return res.status(500).json({ error: 'Failed to send follow-up email' });
    }
}

