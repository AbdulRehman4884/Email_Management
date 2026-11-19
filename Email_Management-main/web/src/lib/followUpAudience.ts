import type { FollowUpEngagement } from '../types';

/**
 * The follow-up "Audience" filter. Same wording as the Inbox Sent filter so the two stay compatible:
 * what you target here reads the same as what you see in the Inbox.
 *  - sent:       everyone the primary email was sent to
 *  - opened:     opened the email (Inbox "Opened")
 *  - not_opened: sent but not opened yet — the classic "follow up with the people who ignored it" list
 *  - delivered:  confirmed delivered (Inbox "Delivered")
 */
export const FOLLOW_UP_AUDIENCE_OPTIONS: {
  value: FollowUpEngagement;
  label: string;
  hint: string;
}[] = [
  { value: 'sent', label: 'Everyone sent', hint: 'Everyone the first email went to' },
  { value: 'opened', label: 'Opened', hint: 'Only people who opened the email' },
  { value: 'not_opened', label: 'Not opened yet', hint: 'People who were sent it but have not opened' },
  { value: 'delivered', label: 'Delivered', hint: 'Only confirmed-delivered emails' },
];

export function followUpAudienceLabel(value: FollowUpEngagement): string {
  return FOLLOW_UP_AUDIENCE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
