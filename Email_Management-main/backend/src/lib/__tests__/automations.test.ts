/**
 * Lead automations: step checks, placeholders and stop rules.
 * Run: npx tsx --test src/lib/__tests__/automations.test.ts   (no database)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSteps,
  campaignStopRule,
  cleanSteps,
  fillPlaceholders,
  replySubject,
  stopRule,
  usesEmail,
  validateAutomationInput,
  waitMs,
} from '../crm/automationSteps.js';
import { AUTOMATION_TEMPLATES, findTemplate, templateOutline, templateSteps } from '../crm/automationTemplates.js';

const email = (subject: string, body = 'Hello {{first_name}}') => ({ type: 'email', subject, body });
const wait = (amount: number, unit = 'days') => ({ type: 'wait', amount, unit });
const call = (outcomes: Record<string, unknown[]> = {}) => ({
  type: 'call',
  message: 'Ask about the budget',
  retries: 2,
  retryAmount: 1,
  retryUnit: 'days',
  outcomes: { interested: [], no_answer: [], not_interested: [], ...outcomes },
});

test('a welcome flow with a call and its results is valid', () => {
  const errors: string[] = [];
  const steps = cleanSteps(
    [
      email('Thanks {{first_name}}'),
      wait(1),
      email('', 'Just checking in'), // empty subject = reply in the same thread
      { type: 'remind', message: 'Call this lead' },
      call({ interested: [email('Book a time'), { type: 'stage', stageId: 4 }], not_interested: [{ type: 'stage', stageId: 8 }] }),
    ],
    errors
  );
  assert.deepEqual(errors, []);
  assert.equal(steps.length, 5);
  assert.ok(steps.every((s) => /^[A-Za-z0-9_-]{1,40}$/.test(s.id)), 'every step gets an id');
  assert.equal(allSteps(steps).length, 4 + 3, 'main steps without the call + 3 result steps');
  assert.equal(usesEmail(steps), true);
});

test('wrong steps are explained', () => {
  const check = (steps: unknown[]) => {
    const errors: string[] = [];
    cleanSteps(steps, errors);
    return errors;
  };
  assert.match(check([email('')])[0]!, /write a subject/);
  assert.match(check([email('Hi', '')])[0]!, /write the email message/);
  assert.match(check([call(), email('Hi')])[0]!, /call step must be the last step/);
  assert.match(check([call({ interested: [call()] })])[0]!, /cannot have another call step/);
  assert.match(check([wait(0)])[0]!, /whole number/);
  assert.match(check([wait(400, 'days')])[0]!, /at most one year/);
  assert.match(check([wait(2, 'weeks')])[0]!, /minutes, hours or days/);
  assert.match(check([{ type: 'sms' }])[0]!, /unknown step "sms"/);
  assert.match(check([{ type: 'tag' }])[0]!, /pick a tag/);
  assert.match(check([{ type: 'remind', message: ' ' }])[0]!, /write the reminder/);
  assert.match(check('nope' as unknown as unknown[])[0]!, /must be a list/);
  // A result may reply in the thread of an email sent before the call.
  assert.deepEqual(check([email('Hi'), call({ interested: [email('', 'Great!')] })]), []);
  assert.match(check([call({ interested: [email('', 'Great!')] })])[0]!, /write a subject/);
});

test('an automation can only be turned on with steps and an email account', () => {
  const off = validateAutomationInput({ name: 'Welcome', steps: [email('Hi')] });
  assert.equal(off.ok, true);
  assert.equal(off.ok && off.value.isActive, false, 'new automations start off');
  const noAccount = validateAutomationInput({ name: 'Welcome', isActive: true, steps: [email('Hi')] });
  assert.equal(noAccount.ok, false);
  assert.match(!noAccount.ok ? noAccount.errors.join() : '', /Email account/);
  const empty = validateAutomationInput({ name: 'Welcome', isActive: true, steps: [] });
  assert.match(!empty.ok ? empty.errors.join() : '', /at least one step/);
  const remindOnly = validateAutomationInput({ name: 'Call', isActive: true, steps: [{ type: 'remind', message: 'Call' }] });
  assert.equal(remindOnly.ok, true, 'no email step = no email account needed');
  const noName = validateAutomationInput({ name: '  ' });
  assert.match(!noName.ok ? noName.errors.join() : '', /Name/);
  // PATCH keeps what is not sent.
  const base = off.ok ? off.value : null;
  const renamed = validateAutomationInput({ name: 'Welcome 2' }, base!);
  assert.equal(renamed.ok && renamed.value.steps.length, 1);
});

test('placeholders, reply subjects and waits', () => {
  const lead = { email: 'ali@x.com', name: 'Ali Khan', company: 'X Ltd', phone: '0300 1234567', form: 'Contact' };
  assert.equal(
    fillPlaceholders('Hi {{first_name}} ({{ Name }}) from {{company}}, {{phone}}, {{email}}, {{form}} {{unknown}}', lead),
    'Hi Ali (Ali Khan) from X Ltd, 0300 1234567, ali@x.com, Contact {{unknown}}'
  );
  assert.equal(fillPlaceholders('Hi {{first_name}},', { ...lead, name: null }), 'Hi ,');
  assert.equal(replySubject('Thanks'), 'Re: Thanks');
  assert.equal(replySubject('RE: Thanks'), 'RE: Thanks');
  assert.equal(waitMs(1, 'days'), 86_400_000);
  assert.equal(waitMs(30, 'minutes'), 1_800_000);
});

test('unsubscribe, bounce and Won/Lost stop a run; a normal lead does not', () => {
  const lead = { suppressed: null, stage_type: 'normal', stage_name: 'New Lead' };
  assert.equal(stopRule(lead), null);
  assert.equal(stopRule({ ...lead, suppressed: 'unsubscribe' })?.code, 'unsubscribed');
  assert.equal(stopRule({ ...lead, suppressed: 'complaint' })?.code, 'unsubscribed');
  assert.equal(stopRule({ ...lead, suppressed: 'bounce' })?.code, 'bounced');
  assert.equal(stopRule({ ...lead, stage_type: 'lost', stage_name: 'Lost' })?.reason, 'The lead is in the Lost stage');
  assert.equal(stopRule({ ...lead, stage_type: 'won', stage_name: 'Won' })?.code, 'won_lost');
  assert.equal(stopRule({ ...lead, stage_type: 'won', stage_name: 'Contacted' })?.reason, 'The lead is in "Contacted", a Won stage');
});

test('every template is a valid automation; stage names become the user stage ids', () => {
  const stages = [
    { id: 11, name: 'New Lead', type: 'normal' },
    { id: 15, name: 'Interested', type: 'normal' },
    { id: 18, name: 'Lost', type: 'lost' },
  ];
  assert.equal(AUTOMATION_TEMPLATES.filter((t) => t.kind === 'form').length, 4);
  assert.equal(AUTOMATION_TEMPLATES.filter((t) => t.kind === 'campaign').length, 2);
  for (const t of AUTOMATION_TEMPLATES) {
    const steps = templateSteps(t, stages);
    const v = validateAutomationInput({ name: t.name, kind: t.kind, isActive: true, smtpSettingsId: 1, steps });
    assert.equal(v.ok, true, `${t.key}: ${!v.ok ? v.errors.join('; ') : ''}`);
    assert.equal(v.ok && v.value.steps.length, steps.length, `${t.key}: no step is dropped`);
    assert.equal(templateOutline(t).length, t.steps.length);
    if (t.kind === 'form') for (const s of steps) if (s.type === 'wait') assert.ok(s.amount === 1 || t.key === 're_engage', `${t.key}: waits are 1 day`);
  }
  const call = templateSteps(findTemplate('book_a_call')!, stages).at(-1);
  assert.equal(call?.type, 'call');
  if (call?.type === 'call') {
    assert.deepEqual(call.outcomes.interested.at(-1), { id: 'interested_stage', type: 'stage', stageId: 15 });
    assert.deepEqual(call.outcomes.not_interested.at(-1), { id: 'lost_stage', type: 'stage', stageId: 18 });
  }
  // No matching stage (no pipeline yet): the stage steps are left out, the rest stays.
  const bare = templateSteps(findTemplate('book_a_call')!, []).at(-1);
  assert.equal(bare?.type === 'call' && bare.outcomes.interested.length, 1);
  assert.equal(findTemplate('nope'), null);
});

test('campaign automations: only email and wait steps, every email is a reply in the campaign thread', () => {
  const errors: string[] = [];
  const steps = cleanSteps([wait(2), email('A subject that is ignored', 'Hi {{first_name}}'), { type: 'remind', message: 'x' }, call()], errors, 'campaign');
  assert.equal(steps.length, 2);
  assert.equal(steps[1]!.type === 'email' && steps[1]!.subject, '', 'the subject is always the campaign thread');
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /only Email and Wait/);
  // On without an email account: a campaign automation sends from each campaign's account.
  const on = validateAutomationInput({ name: '3 follow-ups', kind: 'campaign', isActive: true, smtpSettingsId: 5, steps: [wait(2), email('', 'Hi')] });
  assert.equal(on.ok, true);
  assert.equal(on.ok && on.value.smtpSettingsId, null);
  const noEmail = validateAutomationInput({ name: 'x', kind: 'campaign', isActive: true, steps: [wait(2)] });
  assert.match(!noEmail.ok ? noEmail.errors.join() : '', /at least one follow-up email/);
  // The kind never changes after the automation is made.
  const changed = validateAutomationInput({ kind: 'form' }, on.ok ? on.value : undefined);
  assert.match(!changed.ok ? changed.errors.join() : '', /cannot become/);
  assert.match((() => { const v = validateAutomationInput({ name: 'x', kind: 'sms' }); return !v.ok ? v.errors.join() : ''; })(), /form or campaign/);
});

test('campaign follow-ups stop on a reply, bounce, unsubscribe, CRM stop or a cancelled campaign', () => {
  const lead = { status: 'sent', suppressed: null, replied: false, crmBlocked: false, campaign_status: 'in_progress' };
  assert.equal(campaignStopRule(lead), null);
  assert.equal(campaignStopRule({ ...lead, campaign_status: 'paused' }), null, 'a paused campaign only waits');
  assert.equal(campaignStopRule({ ...lead, campaign_status: 'completed' }), null, 'follow-ups go on after all first emails are sent');
  assert.equal(campaignStopRule({ ...lead, replied: true })?.code, 'replied');
  assert.equal(campaignStopRule({ ...lead, status: 'bounced' })?.code, 'bounced');
  assert.equal(campaignStopRule({ ...lead, suppressed: 'bounce' })?.code, 'bounced');
  assert.equal(campaignStopRule({ ...lead, suppressed: 'unsubscribe' })?.code, 'unsubscribed');
  assert.equal(campaignStopRule({ ...lead, status: 'complained' })?.code, 'unsubscribed');
  assert.equal(campaignStopRule({ ...lead, crmBlocked: true })?.code, 'crm');
  assert.equal(campaignStopRule({ ...lead, campaign_status: 'cancelled' })?.code, 'campaign_cancelled');
});

test('AI follow-up: the prompt has the campaign email and earlier follow-ups; answers are checked', async () => {
  const { buildAiMessages, parseAiAnswer, writeFollowUpWithAi } = await import('../crm/automationAi.js');
  const msgs = buildAiMessages({ kind: 'campaign', followUpNumber: 2, context: 'Subject: Web design\n\nWe build fast websites.', previous: ['Just checking in'], instruction: 'short' });
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!.content, /empty subject/);
  assert.match(msgs[1]!.content, /follow-up number 2/);
  assert.match(msgs[1]!.content, /We build fast websites/);
  assert.match(msgs[1]!.content, /Just checking in/);
  assert.match(msgs[1]!.content, /wish: short/);
  assert.deepEqual(parseAiAnswer(JSON.stringify({ subject: 'Hi', body: 'Hi {{first_name}},\n\nQuick note.' }), 'campaign'), { subject: '', body: 'Hi {{first_name}},\n\nQuick note.' });
  assert.deepEqual(parseAiAnswer('{"subject":"Quick idea","body":"Hello"}', 'form'), { subject: 'Quick idea', body: 'Hello' });
  assert.equal(parseAiAnswer('not json', 'form'), null);
  assert.equal(parseAiAnswer('{"body":"  "}', 'form'), null);

  // Without a key nothing is called; with a key a fake AI answer comes back.
  const saved = { a: process.env.AI_LABELING_API_KEY, o: process.env.OPENAI_API_KEY };
  delete process.env.AI_LABELING_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const input = { kind: 'campaign' as const, followUpNumber: 1, context: '', previous: [], instruction: '' };
  assert.equal((await writeFollowUpWithAi(1, input)).ok, false);
  process.env.OPENAI_API_KEY = 'test-key';
  const fakeFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"subject":"","body":"Hi {{first_name}}, any thoughts?"}' } }] }), { status: 200 })) as unknown as typeof fetch;
  const ok = await writeFollowUpWithAi(1, input, fakeFetch);
  assert.deepEqual(ok, { ok: true, subject: '', body: 'Hi {{first_name}}, any thoughts?' });
  const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  assert.equal((await writeFollowUpWithAi(1, input, failing)).ok, false);
  if (saved.a === undefined) delete process.env.AI_LABELING_API_KEY; else process.env.AI_LABELING_API_KEY = saved.a;
  if (saved.o === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.o;
});
