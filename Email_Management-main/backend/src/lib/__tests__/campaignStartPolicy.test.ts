import { describe, expect, it } from 'vitest';
import { buildCampaignConflictResponse, isSingleCampaignStartPolicy } from '../campaignStartPolicy.js';

describe('campaignStartPolicy', () => {
  it('defaults to single-campaign start policy', () => {
    expect(isSingleCampaignStartPolicy(undefined)).toBe(true);
    expect(isSingleCampaignStartPolicy('single')).toBe(true);
  });

  it('allows explicit multi-campaign start policy', () => {
    expect(isSingleCampaignStartPolicy('multi')).toBe(false);
  });

  it('builds a conflict response with all running blockers', () => {
    const response = buildCampaignConflictResponse([
      { id: 26, name: 'Live Test Campaign - AI SDR' },
      { id: 30, name: 'summer sale' },
    ]);

    expect(response).toMatchObject({
      error: 'Other campaigns are already running.',
      code: 'CAMPAIGN_CONFLICT',
      conflictCampaignId: 26,
      conflictCampaignName: 'Live Test Campaign - AI SDR',
      policy: 'single_campaign_mode',
      conflictCampaigns: [
        { id: 26, name: 'Live Test Campaign - AI SDR' },
        { id: 30, name: 'summer sale' },
      ],
    });
  });
});
