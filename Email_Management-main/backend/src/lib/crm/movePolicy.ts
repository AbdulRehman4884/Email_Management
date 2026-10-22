/**
 * Which automatic stage moves are allowed (CRM step 3). Pure, unit tested.
 *  - never into or out of a manual-only stage,
 *  - never out of a Won/Lost stage (those are final; move by hand),
 *  - forward_only rules move only to a later stage; Won/Lost are always allowed as targets.
 */
export interface StageInfo {
  id: number;
  name: string;
  position: number;
  type: string; // 'normal' | 'won' | 'lost'
  manualOnly: boolean;
  stopFollowUps: boolean;
}

export type MoveCheck = { ok: true } | { ok: false; reason: string };

const isFinal = (s: StageInfo) => s.type === 'won' || s.type === 'lost';

/** Pure move policy, unit tested. */
export function canAutoMove(current: StageInfo | null, target: StageInfo | null | undefined, forwardOnly: boolean): MoveCheck {
  if (!target) return { ok: false, reason: 'target stage not found in this pipeline' };
  if (current && current.id === target.id) return { ok: false, reason: 'already in this stage' };
  if (target.manualOnly) return { ok: false, reason: 'target stage is manual only' };
  if (current?.manualOnly) return { ok: false, reason: 'current stage is manual only' };
  if (current && isFinal(current)) return { ok: false, reason: 'lead is already Won/Lost (move it by hand)' };
  if (!forwardOnly || !current || isFinal(target)) return { ok: true };
  if (target.position > current.position) return { ok: true };
  return { ok: false, reason: 'forward only: target stage is before the current stage' };
}

