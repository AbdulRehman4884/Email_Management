/**
 * src/mcp/tools/enrichment/saveEnrichedContacts.tool.ts
 *
 * Saves enriched contacts to a campaign as recipients via the bulk JSON endpoint.
 *
 * Normalizes the raw enriched contact shape (field name variants from different
 * enrichment sources) into the canonical recipient shape before calling the
 * backend, so validation never fails because of field naming inconsistencies.
 *
 * Must only be called after explicit user confirmation.
 * Must never be triggered automatically.
 */

import { TOOL_NAMES } from "../../../config/constants.js";
import { SaveEnrichedContactsSchema } from "../../../schemas/enrichment.schemas.js";
import { serializeError } from "../../../lib/errors.js";
import { toolSuccess, toolFailure } from "../../../types/common.js";
import type { McpToolDefinition } from "../../../types/tool.js";
import type { BulkSaveResult, BulkRejectedEntry } from "../../../types/mailflow.js";
import type { CampaignId } from "../../../types/common.js";

// ── Result type ───────────────────────────────────────────────────────────────

export interface SaveEnrichedContactsResult {
  saved: number;
  skipped: number;
  rejected: BulkRejectedEntry[];
}

// ── Normalization ─────────────────────────────────────────────────────────────

/** Returns the first truthy string value from the candidates list. */
function firstString(...candidates: unknown[]): string {
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * Normalizes a raw enriched contact record into the canonical bulk-save shape.
 *
 * Returns null when the contact has no usable email address — these are counted
 * as dropped before the backend call so they never cause a spurious 422.
 */
function normalizeContact(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  // ── Email (required) ──────────────────────────────────────────────────────
  const email = firstString(
    raw.email,
    raw.emailAddress,
    raw.email_address,
  ).toLowerCase();
  if (!email) return null;

  // ── Standard recipient fields ─────────────────────────────────────────────
  const name = firstString(
    raw.name,
    raw.fullName,
    raw.full_name,
    raw.firstName,
    raw.first_name,
  );

  // ── Enrichment custom fields ──────────────────────────────────────────────
  // Start with any pre-existing customFields object the tool chain may have set,
  // then layer in top-level enrichment fields so nothing is lost.
  const base =
    raw.customFields && typeof raw.customFields === "object"
      ? { ...(raw.customFields as Record<string, unknown>) }
      : {};

  const company = firstString(
    raw.company,
    raw.organization,
    raw.companyName,
    raw.company_name,
  );
  const role = firstString(
    raw.role,
    raw.title,
    raw.jobTitle,
    raw.job_title,
    raw.position,
  );
  const city = firstString(raw.city, raw.location, raw.locality);
  const domain           = firstString(raw.domain);
  const emailType        = firstString(raw.emailType, raw.email_type);
  const priority         = firstString(raw.priority);
  const enrichmentSource = firstString(raw.enrichmentSource, raw.enrichment_source);
  const industry         = firstString(raw.industry);
  const linkedinUrl      = firstString(raw.linkedinUrl, raw.linkedInUrl, raw.linkedin_url);

  const leadScore =
    raw.score      != null ? raw.score :
    raw.leadScore  != null ? raw.leadScore :
    raw.lead_score != null ? raw.lead_score :
    null;

  const customFields: Record<string, unknown> = { ...base };
  if (company)           customFields.company          = company;
  if (role)              customFields.role             = role;
  if (city)              customFields.city             = city;
  if (domain)            customFields.domain           = domain;
  if (emailType)         customFields.emailType        = emailType;
  if (leadScore != null) customFields.leadScore        = leadScore;
  if (priority)          customFields.priority         = priority;
  if (enrichmentSource)  customFields.enrichmentSource = enrichmentSource;
  if (industry)          customFields.industry         = industry;
  if (linkedinUrl)       customFields.linkedinUrl      = linkedinUrl;

  return {
    email,
    name,
    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
  };
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const saveEnrichedContactsTool: McpToolDefinition<
  typeof SaveEnrichedContactsSchema,
  SaveEnrichedContactsResult
> = {
  name: TOOL_NAMES.SAVE_ENRICHED_CONTACTS,

  description:
    "Saves enriched contacts to a campaign as recipients. " +
    "Must only be called after explicit user confirmation — never triggered automatically. " +
    "Enrichment fields (industry, score, confidence) are persisted alongside standard fields.",

  inputSchema: SaveEnrichedContactsSchema,

  handler: async (input, context) => {
    const campaignId = input.campaignId as CampaignId;
    const { contacts } = input;

    // ── Normalize ─────────────────────────────────────────────────────────────
    const normalized: Array<Record<string, unknown>> = [];
    const dropped: string[] = [];

    for (const raw of contacts as Array<Record<string, unknown>>) {
      const normalized_ = normalizeContact(raw);
      if (normalized_) {
        normalized.push(normalized_);
      } else {
        dropped.push(String(raw.email ?? raw.emailAddress ?? "(unknown)"));
      }
    }

    context.log.info(
      {
        campaignId,
        rawContactCount:        contacts.length,
        normalizedContactCount: normalized.length,
        droppedContactCount:    dropped.length,
        sampleContact:          normalized[0]
          ? { email: (normalized[0] as Record<string, unknown>).email, name: (normalized[0] as Record<string, unknown>).name }
          : null,
      },
      "saveEnrichedContacts: normalized",
    );

    if (normalized.length === 0) {
      // All contacts were dropped pre-normalization (no email field).
      return toolSuccess<SaveEnrichedContactsResult>({
        saved:    0,
        skipped:  0,
        rejected: dropped.map((email) => ({ email, reason: "missing_email" })),
      });
    }

    try {
      const result: BulkSaveResult = await context.mailflow.saveRecipientsBulk(
        campaignId,
        normalized,
      );
      context.log.info(
        { campaignId, saved: result.saved, skipped: result.skipped, rejectedCount: result.rejected?.length ?? 0 },
        "saveEnrichedContacts: done",
      );
      return toolSuccess<SaveEnrichedContactsResult>({
        saved:    result.saved,
        skipped:  result.skipped,
        rejected: result.rejected ?? [],
      });
    } catch (err) {
      const error = serializeError(err);
      context.log.error({ error }, "saveEnrichedContacts: failed");
      return toolFailure(error.code, error.message, error.details);
    }
  },
};
