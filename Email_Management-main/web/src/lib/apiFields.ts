// N-21: read the correctly spelled API field, falling back to the old misspelled one (still sent by the API).
import type { Campaign } from '../types';

export function campaignRecipientCount(c: Pick<Campaign, 'recieptCount' | 'recipientCount'> | null | undefined): number | undefined {
  if (!c) return undefined;
  return c.recipientCount ?? c.recieptCount;
}
