export interface RunningCampaignBlocker {
  id: number;
  name: string | null;
}

export function isSingleCampaignStartPolicy(policy = process.env.CAMPAIGN_START_POLICY): boolean {
  return String(policy ?? 'single').toLowerCase() !== 'multi';
}

export function buildCampaignConflictResponse(blockers: RunningCampaignBlocker[]) {
  return {
    error: blockers.length === 1
      ? 'Another campaign is already running.'
      : 'Other campaigns are already running.',
    code: 'CAMPAIGN_CONFLICT',
    conflictCampaignId: blockers[0]?.id,
    conflictCampaignName: blockers[0]?.name ?? undefined,
    conflictCampaigns: blockers,
    policy: 'single_campaign_mode',
  };
}
