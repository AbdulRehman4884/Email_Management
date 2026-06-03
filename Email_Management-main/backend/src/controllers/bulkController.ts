import type { Request, Response } from "express";
import * as XLSX from "xlsx";
import { Readable } from "stream";
import csv from "csv-parser";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import {
  bulkImportJobsTable,
  bulkImportRowsTable,
  campaignPersonalizedEmailsTable,
  campaignSequenceTouchesTable,
  campaignTable,
  generatedTemplatesTable,
  recipientSequenceStateTable,
  recipientTable,
  smtpSettingsTable,
  statsTable,
} from "../db/schema.js";
import { validateBulkRows, type BulkLeadInput } from "../lib/bulkValidation.js";
import { enqueueBulkProcessing, generateExecutiveTemplate } from "../lib/bulkProcessingQueue.js";
import { requireSmtpProfile } from "../lib/smtpSettings.js";
import {
  ALLOWED_BULK_RECIPIENT_PLACEHOLDERS,
  classifyIndustryGroup,
  normalizeTemplateStrategy,
  recommendTemplateForGroup,
  resolveSenderName,
  sanitizeBulkTemplateContent,
  templateOptions,
  type TemplateStrategy,
} from "../lib/templateInjectionEngine.js";

interface FileRequest extends Request {
  file?: Express.Multer.File;
}

export async function uploadBulkFile(req: FileRequest, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const fileName = req.file.originalname || "bulk-import.csv";
    const rows = await parseUploadRows(req.file.buffer, fileName);
    if (rows.length === 0) return res.status(400).json({ error: "No rows found in file" });

    const validation = validateBulkRows(rows);
    const batchSize = clampInt(req.body?.batchSize, 10, 200, 50);
    const [job] = await db.insert(bulkImportJobsTable).values({
      userId,
      fileName,
      status: validation.validRows.length > 0 ? "awaiting_template_selection" : "validation_failed",
      totalRows: validation.summary.totalRows,
      validRows: validation.summary.valid,
      duplicateRows: validation.summary.duplicates,
      invalidRows: validation.summary.invalid,
      batchSize,
      validationSummary: validation.summary,
    }).returning();

    if (!job) return res.status(500).json({ error: "Failed to create import job" });

    if (validation.rows.length > 0) {
      await db.insert(bulkImportRowsTable).values(validation.rows.map((row) => ({
        jobId: job.id,
        rowNumber: row.rowNumber,
        name: row.name || null,
        company: row.company || null,
        website: row.normalizedWebsite || row.website || null,
        email: row.normalizedEmail || row.email || null,
        role: row.role || null,
        industry: row.industry || null,
        status: row.valid ? "queued" : row.duplicate ? "duplicate" : "invalid",
        error: row.errors.length ? row.errors.join(",") : null,
      })));
    }

    return res.status(201).json({
      jobId: job.id,
      fileName,
      columns: detectColumns(rows),
      previewRows: rows.slice(0, 10),
      summary: validation.summary,
      status: validation.validRows.length > 0 ? "awaiting_template_selection" : job.status,
      templateOptions: templateOptions(),
      detectedGroups: summarizeTemplateGroups(validation.validRows),
      message: `${validation.summary.valid} valid leads detected. Before generating emails, please select a template strategy.`,
    });
  } catch (error) {
    console.error("[bulk] upload failed:", error);
    return res.status(500).json({ error: "Failed to process bulk upload" });
  }
}

export async function uploadBulkRows(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const rows: BulkLeadInput[] = inputRows.map((row: Record<string, unknown>, index: number) => ({
      rowNumber: Number(row.rowNumber) || index + 1,
      name: cleanOptional(row.name) ?? cleanOptional(row.first_name) ?? "",
      email: cleanOptional(row.email) ?? "",
      company: cleanOptional(row.company) ?? "",
      website: cleanOptional(row.website) ?? "",
      role: cleanOptional(row.role) ?? "",
      industry: cleanOptional(row.industry) ?? "",
    }));
    if (rows.length === 0) return res.status(400).json({ error: "No rows provided" });

    const validation = validateBulkRows(rows);
    const batchSize = clampInt(req.body?.batchSize, 10, 200, 50);
    const [job] = await db.insert(bulkImportJobsTable).values({
      userId,
      fileName: "manual-chat-rows",
      status: validation.validRows.length > 0 ? "awaiting_template_selection" : "validation_failed",
      totalRows: validation.summary.totalRows,
      validRows: validation.summary.valid,
      duplicateRows: validation.summary.duplicates,
      invalidRows: validation.summary.invalid,
      batchSize,
      validationSummary: validation.summary,
    }).returning();
    if (!job) return res.status(500).json({ error: "Failed to create import job" });
    await db.insert(bulkImportRowsTable).values(validation.rows.map((row) => ({
      jobId: job.id,
      rowNumber: row.rowNumber,
      name: row.name || null,
      company: row.company || null,
      website: row.normalizedWebsite || row.website || null,
      email: row.normalizedEmail || row.email || null,
      role: row.role || null,
      industry: row.industry || null,
      status: row.valid ? "queued" : row.duplicate ? "duplicate" : "invalid",
      error: row.errors.length ? row.errors.join(",") : null,
    })));
    return res.status(201).json({
      jobId: job.id,
      fileName: "manual-chat-rows",
      columns: detectColumns(rows),
      previewRows: rows.slice(0, 10),
      summary: validation.summary,
      status: job.status,
      templateOptions: templateOptions(),
      detectedGroups: summarizeTemplateGroups(validation.validRows),
      message: `${validation.summary.valid} valid leads detected. Before generating emails, please select a template strategy.`,
    });
  } catch (error) {
    console.error("[bulk] manual rows failed:", error);
    return res.status(500).json({ error: "Failed to process manual rows" });
  }
}

export async function configureBulkTemplateStrategy(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const jobId = Number(req.params.jobId);
  const [job] = await db.select().from(bulkImportJobsTable)
    .where(and(eq(bulkImportJobsTable.id, jobId), eq(bulkImportJobsTable.userId, userId))).limit(1);
  if (!job) return res.status(404).json({ error: "Import job not found" });
  if (job.campaignId) return res.status(409).json({ error: "Campaign draft already created" });

  const strategy = normalizeTemplateStrategy(req.body as Partial<TemplateStrategy>);
  await db.update(bulkImportJobsTable).set({
    templateSelection: strategy as unknown as Record<string, unknown>,
    templateConfiguredAt: sql`now()`,
    status: "queued",
    processedRows: 0,
    failedRows: 0,
    updatedAt: sql`now()`,
  }).where(eq(bulkImportJobsTable.id, jobId));

  await db.update(bulkImportRowsTable).set({ status: "queued", error: null })
    .where(and(eq(bulkImportRowsTable.jobId, jobId), inArray(bulkImportRowsTable.status, ["generated", "failed", "processing"])));

  enqueueBulkProcessing(jobId, { batchSize: job.batchSize });
  return res.json({
    jobId,
    strategy,
    message: `Template strategy saved. Generating templates in batches of ${job.batchSize}. No emails are being sent.`,
  });
}

export async function getBulkStatus(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const jobId = Number(req.params.jobId);

  const [job] = await db.select().from(bulkImportJobsTable)
    .where(and(eq(bulkImportJobsTable.id, jobId), eq(bulkImportJobsTable.userId, userId))).limit(1);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  const total = job.validRows;
  const processed = job.processedRows;
  const failed = job.failedRows;
  const remaining = Math.max(0, total - processed);
  return res.json({
    jobId: job.id,
    total,
    processed,
    failed,
    remaining,
    status: job.status,
    summary: job.validationSummary,
    campaignId: job.campaignId,
    templateSelection: job.templateSelection,
  });
}

export async function retryBulkJob(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const jobId = Number(req.params.jobId);
  const [job] = await db.select().from(bulkImportJobsTable)
    .where(and(eq(bulkImportJobsTable.id, jobId), eq(bulkImportJobsTable.userId, userId))).limit(1);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  const failedRows = await db.select({ id: bulkImportRowsTable.id }).from(bulkImportRowsTable)
    .where(and(eq(bulkImportRowsTable.jobId, jobId), eq(bulkImportRowsTable.status, "failed")));
  if (failedRows.length > 0) {
    await db.update(bulkImportRowsTable).set({ status: "queued", error: null })
      .where(inArray(bulkImportRowsTable.id, failedRows.map((row) => row.id)));
    await db.update(bulkImportJobsTable).set({
      status: "queued",
      processedRows: sql`GREATEST(${bulkImportJobsTable.processedRows} - ${failedRows.length}, 0)`,
      failedRows: sql`GREATEST(${bulkImportJobsTable.failedRows} - ${failedRows.length}, 0)`,
      updatedAt: sql`now()`,
    }).where(eq(bulkImportJobsTable.id, jobId));
  }
  enqueueBulkProcessing(jobId, { batchSize: job.batchSize });
  return res.json({ message: "Retry queued", retried: failedRows.length });
}

export async function listBulkTemplates(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const jobId = Number(req.params.jobId);
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const search = String(req.query.search ?? "").trim();
  const status = String(req.query.status ?? "").trim();
  const templateType = String(req.query.templateType ?? "").trim();

  const [job] = await db.select({ id: bulkImportJobsTable.id }).from(bulkImportJobsTable)
    .where(and(eq(bulkImportJobsTable.id, jobId), eq(bulkImportJobsTable.userId, userId))).limit(1);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  const conditions = [eq(bulkImportRowsTable.jobId, jobId)];
  if (search) conditions.push(ilike(bulkImportRowsTable.company, `%${search}%`));
  if (status) conditions.push(eq(generatedTemplatesTable.status, status));
  if (templateType) conditions.push(eq(generatedTemplatesTable.selectedTemplateId, templateType));

  const where = and(...conditions);
  const [totalRow] = await db.select({ total: count() }).from(generatedTemplatesTable)
    .innerJoin(bulkImportRowsTable, eq(bulkImportRowsTable.id, generatedTemplatesTable.rowId))
    .where(where);
  const rows = await db.select({
    id: generatedTemplatesTable.id,
    rowId: generatedTemplatesTable.rowId,
    subject: generatedTemplatesTable.subject,
    body: generatedTemplatesTable.body,
    followup1: generatedTemplatesTable.followup1,
    followup2: generatedTemplatesTable.followup2,
    cta: generatedTemplatesTable.cta,
    selectedTemplateId: generatedTemplatesTable.selectedTemplateId,
    templateName: generatedTemplatesTable.templateName,
    selectedTone: generatedTemplatesTable.selectedTone,
    selectedCTAStyle: generatedTemplatesTable.selectedCTAStyle,
    missingDataWarnings: generatedTemplatesTable.missingDataWarnings,
    rationale: generatedTemplatesTable.rationale,
    confidence: generatedTemplatesTable.confidence,
    persona: generatedTemplatesTable.persona,
    status: generatedTemplatesTable.status,
    company: bulkImportRowsTable.company,
    website: bulkImportRowsTable.website,
    email: bulkImportRowsTable.email,
    name: bulkImportRowsTable.name,
    role: bulkImportRowsTable.role,
    industry: bulkImportRowsTable.industry,
  }).from(generatedTemplatesTable)
    .innerJoin(bulkImportRowsTable, eq(bulkImportRowsTable.id, generatedTemplatesTable.rowId))
    .where(where)
    .orderBy(desc(generatedTemplatesTable.confidence), asc(generatedTemplatesTable.id))
    .limit(limit)
    .offset(offset);

  return res.json({ jobId, page, limit, total: Number(totalRow?.total ?? 0), templates: rows });
}

export async function updateBulkTemplate(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const templateId = Number(req.params.templateId);
  const authorized = await authorizeTemplate(userId, templateId);
  if (!authorized) return res.status(404).json({ error: "Template not found" });

  const updates = {
    subject: cleanOptional(req.body?.subject),
    body: cleanOptional(req.body?.body),
    followup1: cleanOptional(req.body?.followup1),
    followup2: cleanOptional(req.body?.followup2),
    cta: cleanOptional(req.body?.cta),
    status: ["pending_review", "approved", "rejected", "needs_edit", "regenerated"].includes(String(req.body?.status)) ? String(req.body.status) : undefined,
  };
  const set = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
  await db.update(generatedTemplatesTable).set({
    ...set,
    userEditedSubject: updates.subject,
    userEditedBody: updates.body,
    userEditedFollowup1: updates.followup1,
    userEditedFollowup2: updates.followup2,
    approvedAt: updates.status === "approved" ? sql`now()` : undefined,
    updatedAt: sql`now()`,
  }).where(eq(generatedTemplatesTable.id, templateId));
  return res.json({ message: "Template updated" });
}

export async function bulkApproveTemplateStatuses(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const jobId = Number(req.params.jobId);
  const [job] = await db.select({ id: bulkImportJobsTable.id }).from(bulkImportJobsTable)
    .where(and(eq(bulkImportJobsTable.id, jobId), eq(bulkImportJobsTable.userId, userId))).limit(1);
  if (!job) return res.status(404).json({ error: "Import job not found" });

  const mode = String(req.body?.mode ?? "selected");
  const ids = Array.isArray(req.body?.templateIds) ? req.body.templateIds.map(Number).filter(Number.isFinite) : [];
  const conditions = [eq(bulkImportRowsTable.jobId, jobId)];
  if (mode !== "all") {
    if (ids.length === 0) return res.status(400).json({ error: "templateIds are required for selected approval" });
    conditions.push(inArray(generatedTemplatesTable.id, ids));
  }
  const rows = await db.select({ id: generatedTemplatesTable.id }).from(generatedTemplatesTable)
    .innerJoin(bulkImportRowsTable, eq(bulkImportRowsTable.id, generatedTemplatesTable.rowId))
    .where(and(...conditions));
  if (rows.length === 0) return res.status(404).json({ error: "No templates found to approve" });
  await db.update(generatedTemplatesTable)
    .set({ status: "approved", approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(inArray(generatedTemplatesTable.id, rows.map((row) => row.id)));
  return res.json({ message: "Templates approved", approved: rows.length });
}

export async function regenerateBulkTemplate(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const templateId = Number(req.params.templateId);
  const [row] = await db.select({
    templateId: generatedTemplatesTable.id,
    jobId: bulkImportRowsTable.jobId,
    rowId: bulkImportRowsTable.id,
    name: bulkImportRowsTable.name,
    email: bulkImportRowsTable.email,
    company: bulkImportRowsTable.company,
    website: bulkImportRowsTable.website,
    role: bulkImportRowsTable.role,
    industry: bulkImportRowsTable.industry,
    templateSelection: bulkImportJobsTable.templateSelection,
  }).from(generatedTemplatesTable)
    .innerJoin(bulkImportRowsTable, eq(bulkImportRowsTable.id, generatedTemplatesTable.rowId))
    .innerJoin(bulkImportJobsTable, eq(bulkImportJobsTable.id, bulkImportRowsTable.jobId))
    .where(and(eq(generatedTemplatesTable.id, templateId), eq(bulkImportJobsTable.userId, userId)))
    .limit(1);
  if (!row) return res.status(404).json({ error: "Template not found" });

  const strategy = normalizeTemplateStrategy({
    ...(row.templateSelection as Partial<TemplateStrategy> | null),
    userCustomizationInstructions: cleanOptional(req.body?.instructions)
      ?? (row.templateSelection as Partial<TemplateStrategy> | null)?.userCustomizationInstructions,
  });
  const template = generateExecutiveTemplate({
    name: row.name ?? "",
    email: row.email ?? "",
    company: row.company ?? "the company",
    website: row.website ?? "",
    role: row.role ?? "",
    industry: row.industry ?? "",
    services: [],
    signals: ["row regeneration"],
    confidence: row.website ? 0.64 : 0.52,
    strategy,
  });
  await db.update(generatedTemplatesTable).set({
    ...template,
    status: "regenerated",
    updatedAt: sql`now()`,
  }).where(eq(generatedTemplatesTable.id, templateId));
  return res.json({ message: "Template regenerated", templateId });
}

export async function approveBulkTemplates(req: Request, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const jobId = Number(req.params.jobId);
  const [job] = await db.select().from(bulkImportJobsTable)
    .where(and(eq(bulkImportJobsTable.id, jobId), eq(bulkImportJobsTable.userId, userId))).limit(1);
  if (!job) return res.status(404).json({ error: "Import job not found" });
  if (job.campaignId) return res.status(409).json({ error: "Campaign draft already created", campaignId: job.campaignId });

  const smtpSettingsId = Number(req.body?.smtpSettingsId);
  if (!Number.isFinite(smtpSettingsId) || smtpSettingsId < 1) {
    return res.status(400).json({ error: "smtpSettingsId is required before campaign draft creation" });
  }
  const smtp = await requireSmtpProfile(userId, smtpSettingsId).catch(() => null);
  if (!smtp) return res.status(400).json({ error: "Invalid or unauthorized SMTP profile" });
  const senderName = smtp.fromName || "MailFlow";

  const rows = await db.select({
    templateId: generatedTemplatesTable.id,
    subject: generatedTemplatesTable.subject,
    body: generatedTemplatesTable.body,
    followup1: generatedTemplatesTable.followup1,
    followup2: generatedTemplatesTable.followup2,
    cta: generatedTemplatesTable.cta,
    persona: generatedTemplatesTable.persona,
    confidence: generatedTemplatesTable.confidence,
    rowId: bulkImportRowsTable.id,
    email: bulkImportRowsTable.email,
    name: bulkImportRowsTable.name,
    company: bulkImportRowsTable.company,
    website: bulkImportRowsTable.website,
    role: bulkImportRowsTable.role,
    industry: bulkImportRowsTable.industry,
  }).from(generatedTemplatesTable)
    .innerJoin(bulkImportRowsTable, eq(bulkImportRowsTable.id, generatedTemplatesTable.rowId))
    .where(and(
      eq(bulkImportRowsTable.jobId, jobId),
      eq(bulkImportRowsTable.status, "generated"),
      eq(generatedTemplatesTable.status, "approved"),
    ))
    .orderBy(asc(generatedTemplatesTable.id));

  if (rows.length === 0) return res.status(422).json({ error: "No approved templates available for campaign draft" });

  const sanitizedRows = rows.map((row) => {
    const sanitized = sanitizeBulkTemplateContent({
      subject: row.subject,
      body: row.body,
      followup1: row.followup1,
      followup2: row.followup2,
      cta: row.cta,
    }, senderName);
    return { ...row, ...sanitized };
  });
  const unsupported = sanitizedRows
    .flatMap((row) => row.unsupportedPlaceholders.map((placeholder) => ({ templateId: row.templateId, placeholder })));
  if (unsupported.length > 0) {
    return res.status(422).json({
      error: "Approved templates contain unsupported placeholders",
      allowedPlaceholders: ["name", "email", "company", "website", "role", "industry", "persona"],
      unsupportedPlaceholders: unsupported,
    });
  }

  const changedRows = sanitizedRows.filter((row) =>
    row.subject !== rows.find((original) => original.templateId === row.templateId)?.subject
    || row.body !== rows.find((original) => original.templateId === row.templateId)?.body
    || row.followup1 !== rows.find((original) => original.templateId === row.templateId)?.followup1
    || row.followup2 !== rows.find((original) => original.templateId === row.templateId)?.followup2
    || row.cta !== rows.find((original) => original.templateId === row.templateId)?.cta
  );
  for (const row of changedRows) {
    await db.update(generatedTemplatesTable).set({
      subject: row.subject,
      body: row.body,
      followup1: row.followup1,
      followup2: row.followup2,
      cta: row.cta,
      updatedAt: sql`now()`,
    }).where(eq(generatedTemplatesTable.id, row.templateId));
  }

  const first = sanitizedRows[0]!;
  const campaignName = cleanOptional(req.body?.campaignName) ?? `Bulk Executive Outreach - ${new Date().toISOString().slice(0, 10)}`;
  const dailySendLimit = clampInt(req.body?.dailySendLimit, 1, 1000, 50);
  const [campaign] = await db.insert(campaignTable).values({
    userId,
    smtpSettingsId,
    name: campaignName,
    status: "draft",
    subject: first.subject,
    emailContent: first.body,
    fromName: senderName,
    fromEmail: smtp.fromEmail,
    recieptCount: sanitizedRows.length,
    availableColumns: JSON.stringify(["name", "email", "company", "website", "role", "industry", "persona"]),
    followUpTemplates: [
      { id: "bulk-follow-up-1", title: "Follow-up 1", subject: "Re: {{company}}", body: first.followup1 },
      { id: "bulk-follow-up-2", title: "Follow-up 2", subject: "Closing the loop", body: first.followup2 },
    ],
    dailySendLimit,
  }).returning();

  if (!campaign) return res.status(500).json({ error: "Failed to create campaign draft" });
  await db.insert(statsTable).values({ campaignId: campaign.id });

  const insertedRecipients = await db.insert(recipientTable).values(sanitizedRows.map((row) => ({
    campaignId: campaign.id,
    email: row.email!,
    name: row.name || null,
    status: "pending",
    customFields: JSON.stringify({
      company: row.company,
      website: row.website,
      role: row.role,
      industry: row.industry,
      persona: row.persona,
      confidence: row.confidence,
    }),
  }))).returning({ id: recipientTable.id, email: recipientTable.email });

  const recipientsByEmail = new Map(insertedRecipients.map((row) => [row.email.toLowerCase(), row.id]));
  await db.insert(campaignPersonalizedEmailsTable).values(sanitizedRows.map((row) => ({
    campaignId: campaign.id,
    recipientId: recipientsByEmail.get(row.email!.toLowerCase())!,
    personalizedSubject: row.subject,
    personalizedBody: row.body,
    toneUsed: row.persona,
    ctaType: "approved_bulk_template",
    ctaText: row.cta,
    sequenceType: "bulk_executive_outreach",
    touchNumber: 1,
    deliverabilityRisk: "low",
    strategyReasoning: `Bulk import template for ${row.company}; persona ${row.persona}; confidence ${row.confidence}.`,
    generationStatus: "generated",
  })));

  await db.insert(campaignSequenceTouchesTable).values(sanitizedRows.flatMap((row) => {
    const recipientId = recipientsByEmail.get(row.email!.toLowerCase())!;
    return [
      sequenceTouch(campaign.id, recipientId, 1, "initial executive outreach", row.subject, row.body, row.cta, 0),
      sequenceTouch(campaign.id, recipientId, 2, "operational pressure follow-up", `Re: ${row.company}`, row.followup1, row.cta, 3),
      sequenceTouch(campaign.id, recipientId, 3, "soft close follow-up", "Closing the loop", row.followup2, row.cta, 7),
    ];
  }));

  await db.insert(recipientSequenceStateTable).values(sanitizedRows.map((row) => ({
    campaignId: campaign.id,
    recipientId: recipientsByEmail.get(row.email!.toLowerCase())!,
    currentTouchNumber: 0,
    nextTouchNumber: 1,
    sequenceStatus: "pending",
  })));

  await db.update(bulkImportJobsTable).set({ status: "campaign_draft_created", campaignId: campaign.id, updatedAt: sql`now()` })
    .where(eq(bulkImportJobsTable.id, jobId));

  const smtpRows = await db.select({ dailyEmailLimit: smtpSettingsTable.dailyEmailLimit }).from(smtpSettingsTable)
    .where(eq(smtpSettingsTable.userId, userId));
  const dailyCapacity = smtpRows.reduce((sum, row) => sum + Math.max(0, Number(row.dailyEmailLimit ?? 50)), 0) || dailySendLimit;
  const effectiveDaily = Math.min(dailyCapacity, dailySendLimit || dailyCapacity);
  const estimatedDays = Math.max(1, Math.ceil(sanitizedRows.length / Math.max(1, effectiveDaily)));

  return res.status(201).json({
    campaignId: campaign.id,
    status: campaign.status,
    recipients: sanitizedRows.length,
    message: "Campaign draft created. Review it before starting; no emails have been sent.",
    estimatedSendDurationDays: estimatedDays,
    smtpSafeDailyCapacity: effectiveDaily,
  });
}

export async function repairBulkCampaignReadiness(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const campaignId = Number(req.params.campaignId);
    if (!Number.isFinite(campaignId) || campaignId < 1) {
      return res.status(400).json({ error: "Invalid campaignId" });
    }

    const [campaign] = await db.select().from(campaignTable)
      .where(and(eq(campaignTable.id, campaignId), eq(campaignTable.userId, userId))).limit(1);
    if (!campaign) {
      return res.json({
        ready: false,
        campaignFound: false,
        smtpConfigured: false,
        recipientsExist: false,
        recipientCount: 0,
        pendingRecipientCount: 0,
        unsupportedPlaceholders: [],
        repairedSenderName: false,
        repairedFields: [],
        issues: ["campaign_not_found"],
      });
    }

    const senderName = resolveSenderName(campaign.fromName);
    const [smtp] = campaign.smtpSettingsId
      ? await db.select({ id: smtpSettingsTable.id }).from(smtpSettingsTable)
        .where(and(eq(smtpSettingsTable.id, campaign.smtpSettingsId), eq(smtpSettingsTable.userId, userId))).limit(1)
      : [];
    const [{ totalRecipients = 0 } = { totalRecipients: 0 }] = await db.select({ totalRecipients: count() }).from(recipientTable)
      .where(eq(recipientTable.campaignId, campaignId));
    const [{ pendingRecipients = 0 } = { pendingRecipients: 0 }] = await db.select({ pendingRecipients: count() }).from(recipientTable)
      .where(and(eq(recipientTable.campaignId, campaignId), eq(recipientTable.status, "pending")));

    const repairedFields: string[] = [];
    const unsupported = new Set<string>();

    const campaignTextFields = {
      subject: campaign.subject,
      body: campaign.emailContent,
      followup1: Array.isArray(campaign.followUpTemplates) ? campaign.followUpTemplates[0]?.body ?? "" : "",
      followup2: Array.isArray(campaign.followUpTemplates) ? campaign.followUpTemplates[1]?.body ?? "" : "",
      cta: "",
    };
    const sanitizedCampaign = sanitizeBulkTemplateContent(campaignTextFields, senderName);
    sanitizedCampaign.unsupportedPlaceholders.forEach((placeholder) => unsupported.add(placeholder));

    const updatedFollowups = Array.isArray(campaign.followUpTemplates)
      ? campaign.followUpTemplates.map((template, index) => ({
          ...template,
          body: index === 0
            ? sanitizedCampaign.followup1
            : index === 1
              ? sanitizedCampaign.followup2
              : replaceSenderNameOnly(template.body, senderName),
          subject: replaceSenderNameOnly(template.subject, senderName),
        }))
      : [];

    if (sanitizedCampaign.subject !== campaign.subject) repairedFields.push("campaign.subject");
    if (sanitizedCampaign.body !== campaign.emailContent) repairedFields.push("campaign.emailContent");
    if (JSON.stringify(updatedFollowups) !== JSON.stringify(campaign.followUpTemplates ?? [])) {
      repairedFields.push("campaign.followUpTemplates");
    }
    if (
      sanitizedCampaign.subject !== campaign.subject
      || sanitizedCampaign.body !== campaign.emailContent
      || JSON.stringify(updatedFollowups) !== JSON.stringify(campaign.followUpTemplates ?? [])
    ) {
      await db.update(campaignTable).set({
        subject: sanitizedCampaign.subject,
        emailContent: sanitizedCampaign.body,
        followUpTemplates: updatedFollowups,
        updatedAt: sql`now()`,
      }).where(eq(campaignTable.id, campaignId));
    }

    const personalizedRows = await db.select().from(campaignPersonalizedEmailsTable)
      .where(eq(campaignPersonalizedEmailsTable.campaignId, campaignId));
    for (const row of personalizedRows) {
      const next = sanitizeLooseFields({
        personalizedSubject: row.personalizedSubject ?? "",
        personalizedBody: row.personalizedBody,
        ctaText: row.ctaText ?? "",
      }, senderName, unsupported);
      if (
        next.personalizedSubject !== (row.personalizedSubject ?? "")
        || next.personalizedBody !== row.personalizedBody
        || next.ctaText !== (row.ctaText ?? "")
      ) {
        repairedFields.push(`personalized_email.${row.id}`);
        await db.update(campaignPersonalizedEmailsTable).set({
          personalizedSubject: next.personalizedSubject,
          personalizedBody: next.personalizedBody,
          ctaText: next.ctaText,
        }).where(eq(campaignPersonalizedEmailsTable.id, row.id));
      }
    }

    const touchRows = await db.select().from(campaignSequenceTouchesTable)
      .where(eq(campaignSequenceTouchesTable.campaignId, campaignId));
    for (const row of touchRows) {
      const next = sanitizeLooseFields({
        personalizedSubject: row.personalizedSubject ?? "",
        personalizedBody: row.personalizedBody,
        personalizedText: row.personalizedText ?? "",
        ctaText: row.ctaText ?? "",
      }, senderName, unsupported);
      if (
        next.personalizedSubject !== (row.personalizedSubject ?? "")
        || next.personalizedBody !== row.personalizedBody
        || next.personalizedText !== (row.personalizedText ?? "")
        || next.ctaText !== (row.ctaText ?? "")
      ) {
        repairedFields.push(`sequence_touch.${row.id}`);
        await db.update(campaignSequenceTouchesTable).set({
          personalizedSubject: next.personalizedSubject,
          personalizedBody: next.personalizedBody,
          personalizedText: next.personalizedText,
          ctaText: next.ctaText,
        }).where(eq(campaignSequenceTouchesTable.id, row.id));
      }
    }

    const unsupportedPlaceholders = [...unsupported].sort();
    const issues = [
      ...(smtp ? [] : ["smtp_not_configured"]),
      ...(totalRecipients > 0 && pendingRecipients > 0 ? [] : ["no_pending_recipients"]),
      ...(unsupportedPlaceholders.length > 0 ? ["unsupported_placeholders"] : []),
    ];

    return res.json({
      ready: issues.length === 0,
      campaignFound: true,
      smtpConfigured: Boolean(smtp),
      recipientsExist: totalRecipients > 0,
      recipientCount: totalRecipients,
      pendingRecipientCount: pendingRecipients,
      unsupportedPlaceholders,
      repairedSenderName: repairedFields.length > 0,
      repairedFields,
      issues,
    });
  } catch (error) {
    console.error("[bulk] campaign readiness repair failed:", error);
    return res.status(500).json({ error: "Failed to verify campaign readiness" });
  }
}

async function parseUploadRows(buffer: Buffer, fileName: string): Promise<BulkLeadInput[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ""];
    const rawRows = sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet) : [];
    return rawRows.map((row, index) => mapRawRow(row, index + 2));
  }

  const parsed: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    Readable.from(buffer)
      .pipe(csv())
      .on("data", (row) => parsed.push(row))
      .on("end", resolve)
      .on("error", reject);
  });
  return parsed.map((row, index) => mapRawRow(row, index + 2));
}

function mapRawRow(row: Record<string, unknown>, rowNumber: number): BulkLeadInput {
  return {
    rowNumber,
    name: getAny(row, ["name", "full name", "full_name", "first name", "first_name"]),
    email: getAny(row, ["email", "email address", "email_address", "work email", "work_email"]),
    company: getAny(row, ["company", "company name", "company_name", "account"]),
    website: getAny(row, ["website", "url", "company website", "company_website", "domain"]),
    role: getAny(row, ["role", "title", "job title", "job_title", "position"]),
    industry: getAny(row, ["industry", "vertical", "sector"]),
  };
}

function getAny(row: Record<string, unknown>, keys: string[]): string {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const key of keys) {
    const value = normalized.get(normalizeKey(key));
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function detectColumns(rows: BulkLeadInput[]): string[] {
  const columns = new Set<string>();
  for (const row of rows.slice(0, 10)) {
    for (const key of ["name", "email", "company", "website", "role", "industry"] as const) {
      if (row[key]) columns.add(key);
    }
  }
  return [...columns];
}

function summarizeTemplateGroups(rows: BulkLeadInput[]) {
  const groups = new Map<string, { count: number; recommendedTemplate: string }>();
  for (const row of rows) {
    const group = classifyIndustryGroup(`${row.industry ?? ""} ${row.company ?? ""} ${row.website ?? ""}`);
    const current = groups.get(group) ?? { count: 0, recommendedTemplate: recommendTemplateForGroup(group) };
    current.count += 1;
    groups.set(group, current);
  }
  return [...groups.entries()].map(([group, value]) => ({
    group,
    count: value.count,
    recommendedTemplate: value.recommendedTemplate,
  }));
}

function replaceSenderNameOnly(value: unknown, senderName: string): string {
  return String(value ?? "").trim().replace(/{{\s*sender_name\s*}}/gi, senderName);
}

function sanitizeLooseFields<T extends Record<string, string>>(
  fields: T,
  senderName: string,
  unsupported: Set<string>,
): T {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    const text = replaceSenderNameOnly(value, senderName);
    for (const match of text.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)) {
      const placeholder = match[1]?.toLowerCase() ?? "";
      if (!ALLOWED_BULK_RECIPIENT_PLACEHOLDERS.has(placeholder)) unsupported.add(placeholder);
    }
    return [key, text];
  })) as T;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function cleanOptional(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

async function authorizeTemplate(userId: number, templateId: number): Promise<boolean> {
  const [row] = await db.select({ id: generatedTemplatesTable.id }).from(generatedTemplatesTable)
    .innerJoin(bulkImportRowsTable, eq(bulkImportRowsTable.id, generatedTemplatesTable.rowId))
    .innerJoin(bulkImportJobsTable, eq(bulkImportJobsTable.id, bulkImportRowsTable.jobId))
    .where(and(eq(generatedTemplatesTable.id, templateId), eq(bulkImportJobsTable.userId, userId)))
    .limit(1);
  return Boolean(row);
}

function sequenceTouch(
  campaignId: number,
  recipientId: number,
  touchNumber: number,
  objective: string,
  subject: string,
  body: string,
  cta: string,
  delayDays: number,
) {
  return {
    campaignId,
    recipientId,
    touchNumber,
    sequenceType: "bulk_executive_outreach",
    objective,
    recommendedDelayDays: delayDays,
    toneUsed: "executive_consultative",
    ctaType: "strategic_review",
    ctaText: cta,
    personalizedSubject: subject,
    personalizedBody: body,
    personalizedText: body,
    deliverabilityRisk: "low",
    strategyReasoning: "Generated from approved bulk campaign intelligence template.",
    executionStatus: "pending",
  };
}
