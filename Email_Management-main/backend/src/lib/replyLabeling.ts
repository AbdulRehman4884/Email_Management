/**
 * CRM step 2 — reply labeling.
 *
 * classifyReply() gives every inbound reply one label from constants/replyLabels.ts.
 * Order (first match wins):
 *   1. Auto-reply: email headers + out-of-office subject words (+ strong body phrases).
 *   2. Bounce / unsubscribe: mailer-daemon / postmaster senders, "unsubscribe", "remove me", ...
 *   3. Keyword rules in English + Roman Urdu: meeting_booked, not_interested, interested, question.
 *   4. Optional AI (crm_settings.ai_labeling_enabled + AI_LABELING_API_KEY). Any AI error falls
 *      back to the keyword result. Steps 1 and 2 are never sent to the AI.
 *
 * This file is pure (no database). Saving the label lives in lib/crm/labelReply.ts.
 */
import { isReplyLabel, type ReplyLabel, type ReplyLabelSource } from '../constants/replyLabels.js';

export interface ReplyToClassify {
  fromEmail: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** Lower-case header name -> value. Optional: webhooks do not always send headers. */
  headers?: Record<string, string> | null;
}

export interface ReplyClassification {
  label: ReplyLabel;
  source: ReplyLabelSource;
  /** 0..1 */
  confidence: number;
}

export interface ClassifyOptions {
  aiEnabled?: boolean;
}

// ─── Shared keyword lists (also used by campaignController reply counts) ──────────

/** Subject contains any of these (lower-case) = automatic reply. */
export const OUT_OF_OFFICE_SUBJECT_KEYWORDS = [
  'out of office',
  'auto-reply',
  'auto reply',
  'automatic reply',
  'autoreply',
  'vacation notice',
  'away from office',
] as const;

/** Subject starts with any of these (lower-case) = automatic reply. */
export const OUT_OF_OFFICE_SUBJECT_PREFIXES = ['ooo:'] as const;

/** Sender local parts that are never a real person (used to exclude replies from counts). */
export const SYSTEM_SENDER_LOCAL_PARTS = [
  'noreply', 'no-reply', 'no.reply', 'donotreply', 'do-not-reply', 'do.not.reply',
  'bounce', 'bounces', 'autoreply', 'auto-reply', 'auto.reply',
  'notifications', 'notification', 'alert', 'alerts',
] as const;

const AUTO_REPLY_LOCAL_PARTS = new Set(['autoreply', 'auto-reply', 'auto.reply']);

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
}

/**
 * SQL boolean: TRUE when the reply row (table alias `alias`) is a system message or an
 * automatic reply, so it should not count as a real reply. Built only from the constant lists
 * above (no user input). Same rules campaignController used before this step.
 */
export function nonHumanReplySql(alias = 'er'): string {
  const local = `LOWER(SPLIT_PART(${alias}.from_email, '@', 1))`;
  const subject = `LOWER(${alias}.subject)`;
  const parts = [
    `${local} = 'mailer-daemon'`,
    `${local} LIKE 'mailer-daemon-%'`,
    `${local} LIKE 'mailer-daemon+%'`,
    `${local} LIKE 'mailer-daemon.%'`,
    `POSITION('postmaster' IN ${local}) > 0`,
    `${local} IN (${sqlList(SYSTEM_SENDER_LOCAL_PARTS)})`,
    ...OUT_OF_OFFICE_SUBJECT_KEYWORDS.map((k) => `${subject} LIKE '%${k}%'`),
    ...OUT_OF_OFFICE_SUBJECT_PREFIXES.map((k) => `${subject} LIKE '${k}%'`),
  ];
  return `(\n  ${parts.join('\n  OR ')}\n)`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise headers from mailparser (Map), webhooks (object or raw text) into lower-case keys. */
export function normalizeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: unknown, v: unknown) => {
    const key = String(k ?? '').trim().toLowerCase();
    if (!key) return;
    let val: string;
    if (v == null) val = '';
    else if (typeof v === 'string') val = v;
    else if (typeof v === 'object' && v !== null && 'value' in v) val = String((v as { value: unknown }).value ?? '');
    else if (Array.isArray(v)) val = v.map(String).join(', ');
    else val = String(v);
    out[key] = val.trim();
  };
  if (!input) return out;
  if (input instanceof Map) {
    for (const [k, v] of input) put(k, v);
    return out;
  }
  if (typeof input === 'string') {
    // Raw header block: "Name: value" lines, folded lines start with whitespace.
    const unfolded = input.replace(/\r?\n[ \t]+/g, ' ');
    for (const line of unfolded.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) put(line.slice(0, i), line.slice(i + 1));
    }
    return out;
  }
  if (Array.isArray(input)) {
    // e.g. [["Auto-Submitted","auto-replied"], ...] or [{name, value}]
    for (const item of input) {
      if (Array.isArray(item)) put(item[0], item[1]);
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        put(o.name ?? o.key, o.value);
      }
    }
    return out;
  }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) put(k, v);
  }
  return out;
}

function htmlToText(html: string | null): string {
  if (!html) return '';
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

const QUOTE_START_PATTERNS: RegExp[] = [
  /^\s*on .{3,200}wrote:\s*$/i, // Gmail / Apple Mail: "On Tue, 1 Oct ... wrote:"
  /^\s*on .{3,200}$/i, // "On ... <x@y.com>" when "wrote:" wraps to the next line (checked with next line)
  /^\s*-{2,}\s*original message\s*-{2,}/i,
  /^\s*_{10,}\s*$/, // Outlook separator
  /^\s*from:\s.+$/i, // Outlook quoted header block
  /^\s*sent from my (iphone|android|ipad|samsung|phone)/i,
];

/** Remove quoted history and phone signatures so only the new text is classified. */
export function stripQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*>/.test(line)) break;
    const next = lines[i + 1] ?? '';
    if (QUOTE_START_PATTERNS[0]!.test(line)) break;
    if (QUOTE_START_PATTERNS[1]!.test(line) && /wrote:\s*$/i.test(next)) break;
    if (QUOTE_START_PATTERNS[2]!.test(line) || QUOTE_START_PATTERNS[3]!.test(line)) break;
    // Outlook block: "From: ..." followed soon by "Sent:" / "Date:" / "To:"
    if (QUOTE_START_PATTERNS[4]!.test(line) && i > 0 && /^\s*(sent|date|to|subject):/i.test(next)) break;
    if (QUOTE_START_PATTERNS[5]!.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').replace(/\s+/g, ' ').trim();
}

/** Plain new text of a reply, lower-case, quoted history removed. */
export function replyPlainText(reply: Pick<ReplyToClassify, 'bodyText' | 'bodyHtml'>): string {
  const raw = reply.bodyText && reply.bodyText.trim() ? reply.bodyText : htmlToText(reply.bodyHtml);
  return stripQuotedHistory(raw);
}

/** Build a regex that matches any phrase as whole words (phrases may contain spaces). */
function phrases(list: string[]): RegExp {
  const escaped = list.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`(?:^|[^a-z0-9])(?:${escaped.join('|')})(?=$|[^a-z0-9])`, 'i');
}

// ─── Step 1: automatic replies ───────────────────────────────────────────────

const OOO_BODY_RE = phrases([
  'i am out of the office', "i'm out of the office", 'i am currently out of the office',
  'i am out of office', "i'm out of office", 'currently out of office',
  'i am on vacation', "i'm on vacation", 'i am currently on leave', 'i am on leave', "i'm on leave",
  'on annual leave', 'on maternity leave', 'on paternity leave', 'on holiday until',
  'limited access to email', 'limited access to my email', 'will respond when i return',
  'will reply when i return', 'will get back to you when i return', 'back in the office on',
  'this is an automated response', 'this is an automatic reply', 'automatic reply',
  'chutti par hoon', 'chutti pe hoon', 'office se bahar hoon',
]);

function isAutoReplyByHeaders(h: Record<string, string>): boolean {
  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if ('x-autoreply' in h || 'x-autorespond' in h || 'x-autoresponder' in h) return true;
  const precedence = (h['precedence'] ?? '').toLowerCase();
  if (['auto_reply', 'auto-reply', 'bulk', 'junk'].includes(precedence)) return true;
  return false;
}

export function isOutOfOfficeSubject(subject: string | null | undefined): boolean {
  const s = String(subject ?? '').trim().toLowerCase();
  if (!s) return false;
  if (OUT_OF_OFFICE_SUBJECT_PREFIXES.some((p) => s.startsWith(p))) return true;
  return OUT_OF_OFFICE_SUBJECT_KEYWORDS.some((k) => s.includes(k));
}

// ─── Step 2: bounces and unsubscribe requests ────────────────────────────────

function senderLocalPart(fromEmail: string): string {
  const m = /<([^>]+)>/.exec(fromEmail);
  const addr = (m?.[1] ?? fromEmail).trim().toLowerCase();
  return addr.split('@')[0] ?? '';
}

export function isBounceSender(fromEmail: string): boolean {
  const local = senderLocalPart(fromEmail);
  if (!local) return false;
  return (
    local.startsWith('mailer-daemon') ||
    local === 'mailerdaemon' ||
    local === 'mail-daemon' ||
    local.includes('postmaster') ||
    local === 'bounce' ||
    local === 'bounces' ||
    local.startsWith('bounce-') ||
    local.startsWith('bounces+')
  );
}

const UNSUBSCRIBE_RE = phrases([
  'unsubscribe', 'unsubscribe me', 'remove me', 'please remove', 'remove my email', 'remove us',
  'take me off', 'take us off', 'stop emailing', 'stop sending', 'stop contacting', 'do not contact',
  "don't contact", 'dont contact', 'do not email', "don't email", 'dont email', 'opt out', 'opt-out',
  'no more emails', 'leave me alone',
  // Roman Urdu
  'email mat karein', 'email mat karo', 'email mat bhejein', 'email mat bhejo', 'mujhe email na karein',
  'list se nikal', 'list se hata', 'mera email hata', 'dobara email mat',
]);

// ─── Step 3: keyword rules ───────────────────────────────────────────────────

const MEETING_RE = phrases([
  'calendly', 'calendly.com', 'book a call', 'booked a call', 'book a meeting', 'booked a meeting',
  'schedule a meeting', 'scheduled a meeting', 'schedule a call', 'scheduled a call', 'set up a call',
  'set up a meeting', 'meeting booked', 'call booked', 'sent you an invite', 'sent an invite',
  'calendar invite', 'meeting invite', 'see you on', 'see you then', 'talk on monday', 'talk on tuesday',
  'talk on wednesday', 'talk on thursday', 'talk on friday', 'zoom link', 'meet.google.com', 'zoom.us',
  'teams.microsoft.com', 'hubspot.com/meetings', 'cal.com',
  // Roman Urdu
  'meeting rakh', 'meeting fix', 'meeting set', 'call rakh', 'call fix', 'call set', 'kal call',
  'kal meeting', 'kal baat karte', 'milte hain',
]);

const NOT_INTERESTED_RE = phrases([
  'not interested', 'no longer interested', 'not really interested', 'not a fit', 'not a good fit',
  'not the right fit', 'not right now', 'not at this time', 'no thanks', 'no thank you', 'no, thanks',
  "we're good", 'we are good', 'we are all set', "we're all set", 'pass on this', "we'll pass",
  'we will pass', 'not looking', 'no need', 'not needed', 'already have a', 'already using',
  'already work with', 'not for us', 'no budget',
  // Roman Urdu
  'interested nahi', 'interest nahi', 'dilchaspi nahi', 'nahi chahiye', 'zaroorat nahi', 'zarurat nahi',
  'abhi nahi', 'shukriya nahi', 'humein nahi chahiye', 'hamein nahi chahiye', 'mujhe nahi chahiye',
]);

const INTERESTED_RE = phrases([
  'interested', "i'm interested", 'i am interested', 'we are interested', 'sounds good', 'sounds great',
  'sounds interesting', "let's talk", 'lets talk', "let's chat", 'lets chat', 'tell me more',
  'send more info', 'send me more', 'more information', 'more details', 'send details', 'send the details',
  'send me the details', "i'd like to", 'i would like to', 'yes please', 'count me in', 'keen to',
  'love to', 'happy to chat', 'happy to talk', 'open to', 'would be great', 'go ahead', 'please proceed',
  "let's do it", 'lets do it', 'sign me up', 'please call me', 'call me', 'give me a call',
  // Roman Urdu
  'interested hoon', 'interested hain', 'dilchaspi hai', 'haan ji', 'ji haan', 'haan', 'bilkul',
  'zaroor', 'zarur', 'theek hai', 'thik hai', 'baat karte hain', 'baat karein', 'details bhejein',
  'details bhejo', 'detail bhej', 'mazeed maloomat', 'call karein', 'call karo', 'rabta karein',
]);

const QUESTION_RE = phrases([
  'how much', 'what is the price', "what's the price", 'pricing', 'what does it cost', 'how does it work',
  'how does this work', 'can you', 'could you', 'do you', 'does it', 'is it possible', 'what is',
  "what's", 'which', 'when can', 'where are',
  // Roman Urdu
  'kitna', 'kitne', 'kitni', 'kya aap', 'kya ye', 'kya yeh', 'kaise', 'kab tak', 'kahan', 'kyun',
  'price kya', 'qeemat kya', 'rate kya',
]);

function keywordLabel(text: string): ReplyClassification {
  if (!text) return { label: 'neutral', source: 'keyword', confidence: 0.5 };
  if (MEETING_RE.test(text)) return { label: 'meeting_booked', source: 'keyword', confidence: 0.8 };
  if (NOT_INTERESTED_RE.test(text)) return { label: 'not_interested', source: 'keyword', confidence: 0.8 };
  const hasQuestionMark = text.includes('?');
  if (INTERESTED_RE.test(text)) {
    return { label: 'interested', source: 'keyword', confidence: hasQuestionMark ? 0.65 : 0.75 };
  }
  if (hasQuestionMark || QUESTION_RE.test(text)) {
    return { label: 'question', source: 'keyword', confidence: hasQuestionMark ? 0.7 : 0.55 };
  }
  return { label: 'neutral', source: 'keyword', confidence: 0.5 };
}

/** Steps 1–3 only (no network). Exported for tests and for the AI fallback. */
export function classifyReplyByRules(reply: ReplyToClassify): { result: ReplyClassification; final: boolean; text: string } {
  const headers = reply.headers ?? {};
  const text = replyPlainText(reply);
  const bounceSender = isBounceSender(reply.fromEmail);

  // 1. Automatic replies (a bounce sender is handled by step 2 instead).
  if (!bounceSender) {
    if (isAutoReplyByHeaders(headers)) return { result: { label: 'out_of_office', source: 'keyword', confidence: 0.95 }, final: true, text };
    if (AUTO_REPLY_LOCAL_PARTS.has(senderLocalPart(reply.fromEmail))) {
      return { result: { label: 'out_of_office', source: 'keyword', confidence: 0.9 }, final: true, text };
    }
    if (isOutOfOfficeSubject(reply.subject)) return { result: { label: 'out_of_office', source: 'keyword', confidence: 0.9 }, final: true, text };
    if (OOO_BODY_RE.test(text)) return { result: { label: 'out_of_office', source: 'keyword', confidence: 0.8 }, final: true, text };
  }

  // 2. Bounces and unsubscribe requests.
  if (bounceSender) return { result: { label: 'bounce_unsubscribe', source: 'keyword', confidence: 0.98 }, final: true, text };
  if (UNSUBSCRIBE_RE.test(text)) return { result: { label: 'bounce_unsubscribe', source: 'keyword', confidence: 0.85 }, final: true, text };

  // 3. Keyword rules.
  return { result: keywordLabel(text), final: false, text };
}

// ─── Step 4: optional AI ─────────────────────────────────────────────────────

const AI_TIMEOUT_MS = 10_000;
const AI_MAX_CHARS = 4000;

const AI_SYSTEM_PROMPT = `You label replies to cold sales emails. The reply may be in English, Urdu or Roman Urdu.
Pick exactly one label:
- interested: wants to talk, learn more, or buy
- not_interested: declines or says no
- out_of_office: automatic away / vacation reply
- question: asks a question without clearly saying yes or no
- meeting_booked: a call or meeting is booked or a booking link / time is given
- neutral: none of the above
- bounce_unsubscribe: delivery failure, or asks to be removed / stop emailing
Answer with JSON only: {"label": "<one label>", "confidence": <number 0 to 1>}`;

/** OpenAI-compatible chat completions call (same provider style as the agent service). */
async function classifyWithAi(text: string): Promise<ReplyClassification | null> {
  const apiKey = process.env.AI_LABELING_API_KEY?.trim();
  if (!apiKey || !text) return null;
  const baseUrl = (process.env.AI_LABELING_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_LABELING_MODEL?.trim() || 'gpt-4o-mini';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, AI_MAX_CHARS) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[replyLabeling] AI request failed with status', res.status);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { label?: unknown; confidence?: unknown };
    if (!isReplyLabel(parsed.label)) return null;
    const conf = Number(parsed.confidence);
    return {
      label: parsed.label,
      source: 'ai',
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.7,
    };
  } catch (err) {
    console.warn('[replyLabeling] AI labeling error, using keyword label:', (err as Error)?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify one reply. Never throws: any AI problem returns the keyword result.
 */
export async function classifyReply(reply: ReplyToClassify, options: ClassifyOptions = {}): Promise<ReplyClassification> {
  const rules = classifyReplyByRules(reply);
  if (rules.final || !options.aiEnabled) return rules.result;
  const ai = await classifyWithAi(rules.text);
  return ai ?? rules.result;
}
