/**
 * Lead automations: "Write with AI" for a follow-up email.
 *
 * Uses the AI the backend already has (OpenAI-compatible chat completions, like reply labeling):
 * AI_LABELING_API_KEY, or else OPENAI_API_KEY; AI_LABELING_BASE_URL and AI_LABELING_MODEL when set.
 * No new setting. Without a key the button answers "AI is not set up" and nothing else changes.
 *
 * The AI only writes text the user sees in the builder; nothing is sent until the user saves the automation.
 */

const AI_TIMEOUT_MS = 20_000;
const MAX_CONTEXT = 3000;
const MAX_SUBJECT = 255;
const MAX_BODY = 3000;
/** Per user, per hour (kept in memory; a restart resets it). */
const MAX_PER_HOUR = 30;

export interface AiWriteInput {
  kind: 'form' | 'campaign';
  /** 1 = first follow-up, 2 = second, ... */
  followUpNumber: number;
  /** The campaign's first email (campaign automations) or what the business offers (form automations). */
  context: string;
  /** Earlier emails of this automation, so the new one does not repeat them. */
  previous: string[];
  /** Optional wish of the user, e.g. "short, mention the free trial". */
  instruction: string;
}

export type AiWriteResult = { ok: true; subject: string; body: string } | { ok: false; status: number; error: string };

const clean = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);

/** The chat messages for the AI. Pure, unit tested. */
export function buildAiMessages(input: AiWriteInput): Array<{ role: 'system' | 'user'; content: string }> {
  const system = [
    'You write short, friendly, professional follow-up emails for a small business.',
    'Plain text only: no HTML, no markdown, no links unless the user gives one, no made-up facts, prices or names.',
    'Start with "Hi {{first_name}}," and end with "Best regards". Keep it under 90 words.',
    'Use the placeholder {{first_name}} exactly like that for the lead\'s first name. Do not use any other placeholder.',
    input.kind === 'campaign'
      ? 'The email is sent as a reply in the same thread as the first email, so it has no subject: return an empty subject.'
      : 'Also write a short subject line (under 60 characters).',
    'Answer with JSON only: {"subject": "<subject or empty>", "body": "<email text>"}',
  ].join('\n');
  const lines = [
    `Write follow-up number ${input.followUpNumber} for a lead who has not replied yet.`,
    input.context ? `${input.kind === 'campaign' ? 'The first email was' : 'About the business and the lead\'s request'}:\n"""${clean(input.context, MAX_CONTEXT)}"""` : '',
    ...input.previous.filter(Boolean).map((p, i) => `Earlier follow-up ${i + 1} (do not repeat it):\n"""${clean(p, 1000)}"""`),
    input.instruction ? `The user's wish: ${clean(input.instruction, 300)}` : '',
  ].filter(Boolean);
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n\n') },
  ];
}

/** Reads the AI answer. Pure, unit tested. Null when it is not usable. */
export function parseAiAnswer(content: string | undefined, kind: 'form' | 'campaign'): { subject: string; body: string } | null {
  if (!content) return null;
  try {
    const j = JSON.parse(content) as { subject?: unknown; body?: unknown };
    const body = clean(j.body, MAX_BODY).replace(/\r\n/g, '\n');
    if (!body) return null;
    return { subject: kind === 'campaign' ? '' : clean(j.subject, MAX_SUBJECT), body };
  } catch {
    return null;
  }
}

const usage = new Map<number, number[]>();

/** True when the user may ask the AI again (at most MAX_PER_HOUR per hour). */
function allow(userId: number): boolean {
  const now = Date.now();
  const recent = (usage.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= MAX_PER_HOUR) {
    usage.set(userId, recent);
    return false;
  }
  recent.push(now);
  usage.set(userId, recent);
  return true;
}

/** Asks the AI for one follow-up email. Never throws. */
export async function writeFollowUpWithAi(userId: number, input: AiWriteInput, fetchImpl: typeof fetch = fetch): Promise<AiWriteResult> {
  const apiKey = (process.env.AI_LABELING_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return { ok: false, status: 503, error: 'AI is not set up on this server. Write the follow-up yourself.' };
  if (!allow(userId)) return { ok: false, status: 429, error: `You can use AI ${MAX_PER_HOUR} times per hour. Try again later.` };
  const baseUrl = (process.env.AI_LABELING_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_LABELING_MODEL?.trim() || 'gpt-4o-mini';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.7, response_format: { type: 'json_object' }, messages: buildAiMessages(input) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[automations] AI request failed with status', res.status);
      return { ok: false, status: 502, error: 'The AI did not answer. Try again in a moment.' };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = parseAiAnswer(data.choices?.[0]?.message?.content, input.kind);
    if (!parsed) return { ok: false, status: 502, error: 'The AI answer could not be used. Try again.' };
    return { ok: true, ...parsed };
  } catch (err) {
    console.warn('[automations] AI error:', (err as Error)?.message ?? err);
    return { ok: false, status: 502, error: 'The AI did not answer. Try again in a moment.' };
  } finally {
    clearTimeout(timer);
  }
}
