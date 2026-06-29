export type CampaignActionCode =
  | 'PAUSED'
  | 'RESUMED'
  | 'RESUMED_OUTSIDE_SCHEDULE'
  | 'RESUMED_OUTSIDE_WINDOW'
  | 'RESUMED_LIMIT_REACHED';

export interface CampaignActionResult {
  message: string;
  code?: CampaignActionCode | string;
}

export function isResumeScheduleNotice(code?: string): boolean {
  return (
    code === 'RESUMED_OUTSIDE_SCHEDULE' ||
    code === 'RESUMED_OUTSIDE_WINDOW' ||
    code === 'RESUMED_LIMIT_REACHED'
  );
}

export function showCampaignActionToast(
  toast: { success: (message: string) => void; info: (message: string) => void },
  result: CampaignActionResult,
  action: 'pause' | 'resume'
): void {
  const { message, code } = result;
  if (action === 'pause') {
    toast.success(message);
    return;
  }
  if (isResumeScheduleNotice(code)) {
    toast.info(message);
  } else {
    toast.success(message);
  }
}
