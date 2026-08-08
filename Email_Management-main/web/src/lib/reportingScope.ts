import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCampaignStore } from '../store';

export const REPORTING_SMTP_PROFILE_STORAGE_KEY = 'reportingSmtpProfileId';

/** Dispatched on same tab when scope changes (storage event does not fire locally). */
export const REPORTING_SCOPE_CHANGE_EVENT = 'reporting-scope-change';

/**
 * When an SMTP scope matches zero campaigns, omitting `campaignIds` on list/stats APIs means "all campaigns".
 * Passing this id makes the server resolve to an empty allowed set (not owned by the user).
 */
export const REPORTING_EMPTY_SCOPE_PLACEHOLDER_CAMPAIGN_ID = 2_147_483_646;

export function readReportingSmtpProfileId(): number | null {
  try {
    const raw = window.localStorage.getItem(REPORTING_SMTP_PROFILE_STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeReportingSmtpProfileId(id: number | null): void {
  try {
    if (id == null || id <= 0) {
      window.localStorage.removeItem(REPORTING_SMTP_PROFILE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(REPORTING_SMTP_PROFILE_STORAGE_KEY, String(id));
    }
    window.dispatchEvent(new Event(REPORTING_SCOPE_CHANGE_EVENT));
  } catch {
    // ignore quota / private mode
  }
}

export function filterCampaignsByReportingScope<T extends { smtpSettingsId?: number | null }>(
  campaigns: T[],
  scopeSmtpProfileId: number | null
): T[] {
  if (scopeSmtpProfileId == null) return campaigns;
  return campaigns.filter(
    (c) => c.smtpSettingsId != null && Number(c.smtpSettingsId) === scopeSmtpProfileId
  );
}

export function scopedCampaignIdsFromCampaigns(
  campaigns: Array<{ id: number; smtpSettingsId?: number | null }>,
  scopeSmtpProfileId: number | null
): number[] {
  const scoped = filterCampaignsByReportingScope(campaigns, scopeSmtpProfileId);
  return scoped
    .map((c) => Number(c.id))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

/** Inbox: user-selected campaigns ∩ reporting scope. Empty selection → full scoped set. */
export function effectiveInboxCampaignIds(selectedCampaignIds: number[], scopedCampaignIds: number[]): number[] {
  if (selectedCampaignIds.length === 0) return scopedCampaignIds;
  const allowed = new Set(scopedCampaignIds);
  return [...new Set(selectedCampaignIds.filter((id) => allowed.has(Number(id))))].sort((a, b) => a - b);
}

/** Build `/replies` and `/sent-emails` campaign filter; omits `campaignIds` only for global scope + no picker selection (legacy "all"). */
export function inboxApiCampaignFilter(
  selectedCampaignIds: number[],
  scopedCampaignIds: number[],
  scopeSmtpProfileId: number | null
): { campaignIds?: number[] } {
  if (scopeSmtpProfileId != null && scopedCampaignIds.length === 0) {
    return { campaignIds: [REPORTING_EMPTY_SCOPE_PLACEHOLDER_CAMPAIGN_ID] };
  }
  if (selectedCampaignIds.length === 0 && scopeSmtpProfileId == null) {
    return {};
  }
  const eff = effectiveInboxCampaignIds(selectedCampaignIds, scopedCampaignIds);
  if (eff.length === 0) {
    return {};
  }
  return { campaignIds: eff };
}

export function useReportingScope() {
  const campaigns = useCampaignStore((s) => s.campaigns);
  const [scopeSmtpProfileId, setScopeState] = useState<number | null>(() => readReportingSmtpProfileId());

  useEffect(() => {
    const sync = () => setScopeState(readReportingSmtpProfileId());
    window.addEventListener(REPORTING_SCOPE_CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(REPORTING_SCOPE_CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setScopeSmtpProfileId = useCallback((id: number | null) => {
    writeReportingSmtpProfileId(id);
    setScopeState(readReportingSmtpProfileId());
  }, []);

  const scopedCampaigns = useMemo(
    () => filterCampaignsByReportingScope(campaigns, scopeSmtpProfileId),
    [campaigns, scopeSmtpProfileId]
  );

  const scopedCampaignIds = useMemo(
    () => scopedCampaignIdsFromCampaigns(campaigns, scopeSmtpProfileId),
    [campaigns, scopeSmtpProfileId]
  );

  return {
    scopeSmtpProfileId,
    setScopeSmtpProfileId,
    scopedCampaigns,
    scopedCampaignIds,
  };
}
