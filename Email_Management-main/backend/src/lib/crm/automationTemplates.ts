/**
 * Ready-made automations offered on "New automation". The user can change everything after picking one.
 * Waits are 1 day by default. A "stage" step names the stage ("Interested") or its type ("lost"); it gets the id of
 * that stage in the user's default pipeline when the automation is created, and is left out when there is none.
 */
import type { AutomationKind, AutomationStep, CallResult, ResultStep } from './automationSteps.js';

type StageRef = { stageName?: string; stageType?: 'won' | 'lost' };
type TemplateResultStep = Exclude<ResultStep, { type: 'stage' }> | ({ id: string; type: 'stage' } & StageRef);
type TemplateStep =
  | TemplateResultStep
  | (Omit<Extract<AutomationStep, { type: 'call' }>, 'outcomes'> & { outcomes: Record<CallResult, TemplateResultStep[]> });

export interface AutomationTemplate {
  key: string;
  /** 'form' templates are started by a form; 'campaign' templates are follow-ups of a campaign. */
  kind: AutomationKind;
  name: string;
  description: string;
  steps: TemplateStep[];
}

const day = (id: string) => ({ id, type: 'wait' as const, amount: 1, unit: 'days' as const });

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: 'welcome_follow_ups',
    kind: 'form',
    name: 'Welcome + follow-ups',
    description: 'A thank-you email right away, a follow-up the next day and a reminder the day after.',
    steps: [
      {
        id: 'welcome',
        type: 'email',
        subject: 'Thanks for reaching out, {{first_name}}!',
        body: 'Hi {{first_name}},\n\nThank you for contacting us. We got your message and will get back to you shortly.\n\nBest regards',
      },
      day('wait1'),
      {
        id: 'follow_up',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nJust following up on your request. Is there anything we can help you with right now?\n\nBest regards',
      },
      day('wait2'),
      {
        id: 'reminder',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nA quick reminder that we are here to help. Reply to this email and we will take it from there.\n\nBest regards',
      },
    ],
  },
  {
    key: 'book_a_call',
    kind: 'form',
    name: 'Book a call',
    description: 'A thank-you email, a call invite the next day, then a reminder for you to call. Each call result has its own next steps.',
    steps: [
      {
        id: 'welcome',
        type: 'email',
        subject: 'Thanks, {{first_name}}! Let us talk',
        body: 'Hi {{first_name}},\n\nThank you for your interest. We would love to learn more about what you need.\n\nBest regards',
      },
      day('wait1'),
      {
        id: 'invite',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nCan we have a quick 15 minute call this week? Reply with a time that suits you, or we will give you a call.\n\nBest regards',
      },
      day('wait2'),
      {
        id: 'call',
        type: 'call',
        message: 'Ask what they need and offer a meeting',
        retries: 2,
        retryAmount: 1,
        retryUnit: 'days',
        outcomes: {
          interested: [
            {
              id: 'interested_email',
              type: 'email',
              subject: 'Great talking to you, {{first_name}}',
              body: 'Hi {{first_name}},\n\nThank you for your time on the phone. As promised, here are the next steps. Reply with any questions.\n\nBest regards',
            },
            { id: 'interested_stage', type: 'stage', stageName: 'Interested' },
          ],
          no_answer: [
            {
              id: 'missed_email',
              type: 'email',
              subject: 'Sorry we missed you, {{first_name}}',
              body: 'Hi {{first_name}},\n\nWe tried to call you a few times but could not reach you. Reply with a good time and number, and we will call you back.\n\nBest regards',
            },
          ],
          not_interested: [
            {
              id: 'thanks_email',
              type: 'email',
              subject: 'Thank you for your time',
              body: 'Hi {{first_name}},\n\nThank you for talking to us. If anything changes, just reply to this email.\n\nBest regards',
            },
            { id: 'lost_stage', type: 'stage', stageType: 'lost' },
          ],
        },
      },
    ],
  },
  {
    key: 'inquiry',
    kind: 'form',
    name: 'Inquiry / quote',
    description: 'Confirms the request right away, reminds you to answer it, and follows up the next day.',
    steps: [
      {
        id: 'received',
        type: 'email',
        subject: 'We got your request, {{first_name}}',
        body: 'Hi {{first_name}},\n\nThank you for your request. Our team is looking at it and will send you an answer soon.\n\nBest regards',
      },
      { id: 'remind', type: 'remind', message: 'New request. Answer it within 1 hour.' },
      day('wait1'),
      {
        id: 'follow_up',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nDid you get our answer? Let us know if you have any questions or want to go ahead.\n\nBest regards',
      },
    ],
  },
  {
    key: 're_engage',
    kind: 'form',
    name: 'Re-engage',
    description: 'For leads that went quiet: a check-in after 1 day and a last email 3 days later.',
    steps: [
      day('wait1'),
      {
        id: 'check_in',
        type: 'email',
        subject: 'Still interested, {{first_name}}?',
        body: 'Hi {{first_name}},\n\nWe have not heard back from you. Are you still looking for help with this?\n\nBest regards',
      },
      { id: 'wait2', type: 'wait', amount: 3, unit: 'days' },
      {
        id: 'last_email',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nThis is our last note for now. If you would like to talk later, just reply to this email.\n\nBest regards',
      },
    ],
  },
  // ── Campaign follow-ups: each email is a reply in the campaign's thread, from the campaign's account. ──
  {
    key: 'campaign_three_follow_ups',
    kind: 'campaign',
    name: '3 follow-ups',
    description: 'For leads who did not reply: a follow-up 2 days after the first email, another 2 days later and a last one 3 days after that.',
    steps: [
      { id: 'wait1', type: 'wait', amount: 2, unit: 'days' },
      {
        id: 'follow_up_1',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nJust bringing my last email to the top of your inbox. Would this be useful for you?\n\nBest regards',
      },
      { id: 'wait2', type: 'wait', amount: 2, unit: 'days' },
      {
        id: 'follow_up_2',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nI know things get busy. Is this something you would like to talk about? A short reply is enough.\n\nBest regards',
      },
      { id: 'wait3', type: 'wait', amount: 3, unit: 'days' },
      {
        id: 'follow_up_3',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nThis is my last note for now. If the timing is not right, no problem. Just reply whenever it suits you.\n\nBest regards',
      },
    ],
  },
  {
    key: 'campaign_two_follow_ups',
    kind: 'campaign',
    name: '2 follow-ups',
    description: 'For leads who did not reply: a follow-up 1 day after the first email and a last one 2 days later.',
    steps: [
      day('wait1'),
      {
        id: 'follow_up_1',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nDid you get a chance to look at my last email?\n\nBest regards',
      },
      { id: 'wait2', type: 'wait', amount: 2, unit: 'days' },
      {
        id: 'follow_up_2',
        type: 'email',
        subject: '',
        body: 'Hi {{first_name}},\n\nOne last follow-up from me. Reply any time if you would like to know more.\n\nBest regards',
      },
    ],
  },
];

export const findTemplate = (key: unknown) => AUTOMATION_TEMPLATES.find((t) => t.key === key) ?? null;

/** Stages of the user's default pipeline, used to fill the template's stage steps. */
export type StageLookup = Array<{ id: number; name: string; type: string }>;

function resolveStage(step: { id: string; type: 'stage' } & StageRef, stages: StageLookup): ResultStep | null {
  const s = step.stageType
    ? stages.find((x) => x.type === step.stageType)
    : stages.find((x) => x.name.trim().toLowerCase() === (step.stageName ?? '').trim().toLowerCase());
  return s ? { id: step.id, type: 'stage', stageId: s.id } : null;
}

function resolveList(list: TemplateResultStep[], stages: StageLookup): ResultStep[] {
  return list.flatMap((s) => {
    if (s.type !== 'stage') return [s];
    const r = resolveStage(s, stages);
    return r ? [r] : [];
  });
}

/** The template's steps with the user's stage ids (stage steps without a matching stage are left out). */
export function templateSteps(t: AutomationTemplate, stages: StageLookup): AutomationStep[] {
  return t.steps.flatMap((s): AutomationStep[] => {
    if (s.type === 'call') {
      return [{
        ...s,
        outcomes: {
          interested: resolveList(s.outcomes.interested, stages),
          no_answer: resolveList(s.outcomes.no_answer, stages),
          not_interested: resolveList(s.outcomes.not_interested, stages),
        },
      }];
    }
    return resolveList([s], stages);
  });
}

/** One line per step, for the template picker. */
export function templateOutline(t: AutomationTemplate): string[] {
  const line = (s: TemplateStep): string => {
    switch (s.type) {
      case 'email':
        if (t.kind === 'campaign') return 'Follow-up email (reply in the campaign thread)';
        return s.subject ? `Email: ${s.subject}` : 'Email (reply in the same thread)';
      case 'wait':
        return `Wait ${s.amount} ${s.amount === 1 ? s.unit.replace(/s$/, '') : s.unit}`;
      case 'remind':
        return `Remind me: ${s.message}`;
      case 'tag':
        return 'Add a tag';
      case 'stage':
        return `Move to ${s.stageName ?? (s.stageType === 'lost' ? 'Lost' : 'Won')}`;
      case 'call':
        return 'Call the lead (Interested / No answer / Not interested)';
    }
  };
  return t.steps.map(line);
}
