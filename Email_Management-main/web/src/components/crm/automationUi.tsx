import React, { useState } from 'react';
import { PhoneOff, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button, useToast } from '../ui';
import {
  crmAutomationsApi,
  apiErrorMessage,
  type AutomationCallResult,
  type AutomationStep,
  type CrmAutomationRun,
} from '../../lib/api';

/** Shared pieces of the Automations pages (list + builder). */

export const CALL_RESULT_LABEL: Record<AutomationCallResult, string> = {
  interested: 'Interested',
  no_answer: 'No answer',
  not_interested: 'Not interested',
};

export const CALL_RESULTS: AutomationCallResult[] = ['interested', 'no_answer', 'not_interested'];

const unitText = (amount: number, unit: string) => `${amount} ${amount === 1 ? unit.replace(/s$/, '') : unit}`;

/** One short line for a step ("Wait 1 day", "Email: Thanks!"). */
export function stepText(step: AutomationStep | undefined, names?: { tag?: (id: number) => string; stage?: (id: number) => string }): string {
  if (!step) return '—';
  switch (step.type) {
    case 'email':
      return step.subject ? `Email: ${step.subject}` : 'Email (reply in the same thread)';
    case 'wait':
      return `Wait ${unitText(step.amount, step.unit)}`;
    case 'remind':
      return `Remind me: ${step.message}`;
    case 'tag':
      return `Add tag ${names?.tag?.(step.tagId) ?? ''}`.trim();
    case 'stage':
      return `Move to ${names?.stage?.(step.stageId) ?? 'a stage'}`;
    case 'call':
      return 'Call the lead';
  }
}

/** Where a lead is in the automation, e.g. "Step 3 of 5: Wait 1 day" or "Interested › step 1 of 2: Email". */
export function runPositionText(run: CrmAutomationRun, steps: AutomationStep[]): string {
  if (run.status === 'completed') return 'All steps done';
  if (run.branch) {
    const call = steps[run.stepIndex];
    const list = call?.type === 'call' ? call.outcomes[run.branch] : [];
    const step = list[run.branchIndex];
    return `${CALL_RESULT_LABEL[run.branch]} › ${step ? `step ${run.branchIndex + 1} of ${list.length}: ${stepText(step)}` : 'done'}`;
  }
  const step = steps[run.stepIndex];
  if (run.status === 'waiting_call') return `Waiting for your call result${run.callAttempts > 1 ? ` (try ${run.callAttempts})` : ''}`;
  return step ? `Step ${run.stepIndex + 1} of ${steps.length}: ${stepText(step)}` : 'Done';
}

const STATUS: Record<CrmAutomationRun['status'], { label: string; color: string }> = {
  active: { label: 'Running', color: '#2563eb' },
  waiting_call: { label: 'Call', color: '#d97706' },
  completed: { label: 'Completed', color: '#16a34a' },
  stopped: { label: 'Stopped', color: '#6b7280' },
};

export function RunStatus({ status }: { status: CrmAutomationRun['status'] }) {
  const s = STATUS[status] ?? STATUS.active;
  return (
    <span
      className="text-xs"
      style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontWeight: 600, color: s.color, background: `${s.color}1a`, whiteSpace: 'nowrap' }}
    >
      {s.label}
    </span>
  );
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const ICON: Record<AutomationCallResult, React.ReactNode> = {
  interested: <ThumbsUp className="w-4 h-4" />,
  no_answer: <PhoneOff className="w-4 h-4" />,
  not_interested: <ThumbsDown className="w-4 h-4" />,
};

/** The three call result buttons. `onDone` runs after the result is saved. */
export function CallResultButtons({ runId, onDone }: { runId: number; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<AutomationCallResult | null>(null);
  const pick = async (result: AutomationCallResult) => {
    setBusy(result);
    try {
      const r = await crmAutomationsApi.callResult(runId, result);
      toast.success(r.message);
      onDone();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the call result'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      {CALL_RESULTS.map((r) => (
        <Button
          key={r}
          size="sm"
          variant={r === 'interested' ? 'primary' : 'secondary'}
          isLoading={busy === r}
          disabled={busy != null}
          onClick={() => void pick(r)}
          leftIcon={ICON[r]}
        >
          {CALL_RESULT_LABEL[r]}
        </Button>
      ))}
    </div>
  );
}
