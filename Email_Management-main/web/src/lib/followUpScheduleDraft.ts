import type { FollowUpEngagement } from '../types';

export const FOLLOW_UP_SCHEDULE_DRAFT_KEY = 'followUpScheduleDraft';

export type FollowUpScheduleDraft = {
  campaignId: number;
  priorFollowUpCount: number;
  engagement: FollowUpEngagement;
  templateId: string;
  scheduledLocal: string;
  maxRunDurationStr: string;
  maxRunDurationUnit: 'minutes' | 'hours';
  sendWeekdaysEnabled: boolean;
  selectedSendWeekdays: number[];
  addTplOpen: boolean;
  tplForm: { title: string; subject: string; body: string };
};

export type FollowUpScheduleInitialState = FollowUpScheduleDraft;

function parseEngagement(raw: unknown): FollowUpEngagement | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'sent' || s === 'opened' || s === 'delivered') return s;
  return null;
}

export function readFollowUpScheduleDraft(): FollowUpScheduleDraft | null {
  try {
    const raw = sessionStorage.getItem(FOLLOW_UP_SCHEDULE_DRAFT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const engagement = parseEngagement(o.engagement);
    if (!engagement) return null;
    const maxRunDurationUnit = o.maxRunDurationUnit === 'minutes' ? 'minutes' : 'hours';
    const selectedSendWeekdays = Array.isArray(o.selectedSendWeekdays)
      ? (o.selectedSendWeekdays as unknown[])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7)
      : [1, 2, 3, 4, 5];
    const tpl =
      o.tplForm && typeof o.tplForm === 'object' && o.tplForm !== null
        ? (o.tplForm as Record<string, unknown>)
        : {};
    return {
      campaignId: Math.max(0, Math.floor(Number(o.campaignId) || 0)),
      priorFollowUpCount: Math.max(0, Math.floor(Number(o.priorFollowUpCount) || 0)),
      engagement,
      templateId: String(o.templateId ?? ''),
      scheduledLocal: String(o.scheduledLocal ?? ''),
      maxRunDurationStr: String(o.maxRunDurationStr ?? ''),
      maxRunDurationUnit,
      sendWeekdaysEnabled: Boolean(o.sendWeekdaysEnabled),
      selectedSendWeekdays: selectedSendWeekdays.length ? selectedSendWeekdays : [1, 2, 3, 4, 5],
      addTplOpen: Boolean(o.addTplOpen),
      tplForm: {
        title: String(tpl.title ?? ''),
        subject: String(tpl.subject ?? ''),
        body: String(tpl.body ?? ''),
      },
    };
  } catch {
    return null;
  }
}

/** URL `campaignId` wins when present; otherwise draft `campaignId`; other fields from draft when valid. */
export function computeFollowUpScheduleInitialState(
  searchParams: URLSearchParams
): FollowUpScheduleInitialState {
  const draft = readFollowUpScheduleDraft();
  const url = Number(searchParams.get('campaignId'));
  const urlCampaign = Number.isFinite(url) && url > 0 ? url : null;
  const engagementRaw = draft?.engagement ?? 'sent';
  const maxRunDurationUnit = draft?.maxRunDurationUnit === 'minutes' ? 'minutes' : 'hours';
  return {
    campaignId: urlCampaign ?? draft?.campaignId ?? 0,
    priorFollowUpCount: draft?.priorFollowUpCount ?? 0,
    engagement: parseEngagement(engagementRaw) ?? 'sent',
    templateId: draft?.templateId ?? '',
    scheduledLocal: draft?.scheduledLocal ?? '',
    maxRunDurationStr: draft?.maxRunDurationStr ?? '',
    maxRunDurationUnit,
    sendWeekdaysEnabled: draft?.sendWeekdaysEnabled ?? false,
    selectedSendWeekdays:
      draft?.selectedSendWeekdays?.length && draft.selectedSendWeekdays.length > 0
        ? draft.selectedSendWeekdays
        : [1, 2, 3, 4, 5],
    addTplOpen: draft?.addTplOpen ?? false,
    tplForm: draft?.tplForm ?? { title: '', subject: '', body: '' },
  };
}

export function writeFollowUpScheduleDraft(draft: FollowUpScheduleDraft): void {
  try {
    sessionStorage.setItem(FOLLOW_UP_SCHEDULE_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* quota / private mode */
  }
}

export function clearFollowUpScheduleDraft(): void {
  try {
    sessionStorage.removeItem(FOLLOW_UP_SCHEDULE_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
