/**
 * Mirrors `emailWorker.ts`: random delay between consecutive sends in one campaign.
 * First email is not delayed; each further email waits 60–120s after the previous.
 */
export const SEND_GAP_MIN_SEC = 60;
export const SEND_GAP_MAX_SEC = 120;

export function estimateSequentialSendDurationMs(recipientCount: number): {
  minMs: number;
  maxMs: number;
  avgMs: number;
} {
  const n = Math.max(0, Math.floor(recipientCount));
  if (n <= 1) {
    return { minMs: 0, maxMs: 0, avgMs: 0 };
  }
  const gaps = n - 1;
  const avgGapMs = ((SEND_GAP_MIN_SEC + SEND_GAP_MAX_SEC) / 2) * 1000;
  return {
    minMs: gaps * SEND_GAP_MIN_SEC * 1000,
    maxMs: gaps * SEND_GAP_MAX_SEC * 1000,
    avgMs: gaps * avgGapMs,
  };
}

function formatDurationPart(ms: number): string {
  if (ms < 60_000) {
    return 'under 1 min';
  }
  if (ms < 3_600_000) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} min`;
  }
  if (ms < 86_400_000) {
    const h = ms / 3_600_000;
    const rounded = h >= 10 ? Math.round(h) : Math.round(h * 10) / 10;
    return `${rounded} hr`;
  }
  const d = Math.floor(ms / 86_400_000);
  const remH = Math.round((ms % 86_400_000) / 3_600_000);
  if (remH <= 0) return `${d} day${d === 1 ? '' : 's'}`;
  return `${d}d ${remH}h`;
}

/** e.g. "12 min – 25 min" or "2.5 hr – 5 hr" */
export function formatSendDurationRange(minMs: number, maxMs: number): string {
  if (minMs <= 0 && maxMs <= 0) {
    return 'negligible';
  }
  if (minMs === maxMs) {
    return formatDurationPart(minMs);
  }
  return `${formatDurationPart(minMs)} – ${formatDurationPart(maxMs)}`;
}

export function getSendTimeEstimateDescription(recipientCount: number): {
  line: string;
  detail: string;
} {
  const n = Math.max(0, Math.floor(recipientCount));
  if (n <= 0) {
    return {
      line: 'Add recipients to see an estimated send duration.',
      detail: 'Sends are spaced about 1–2 minutes apart (per email in the campaign).',
    };
  }
  if (n === 1) {
    return {
      line: 'With one recipient, the first message usually goes out within a few seconds of start.',
      detail: 'Sends are spaced about 1–2 minutes apart when you have more than one recipient.',
    };
  }
  const { minMs, maxMs, avgMs } = estimateSequentialSendDurationMs(n);
  const range = formatSendDurationRange(minMs, maxMs);
  const avgStr = formatDurationPart(avgMs);
  return {
    line: `Rough total send time for all ${n.toLocaleString()} recipients: about ${range} (average ~${avgStr}), not counting pauses from daily limits.`,
    detail:
      'The system waits 1–2 minutes between each send in the same campaign. If you hit SMTP or campaign daily caps, sending continues on later days.',
  };
}
