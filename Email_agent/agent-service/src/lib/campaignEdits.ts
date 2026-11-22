/**
 * src/lib/campaignEdits.ts
 *
 * Changing a saved campaign from the chat, and writing text without saving anything (QA bugs, 15 Nov 2026):
 *   - "change the subject of campaign 466 to Hello C" saved "of campaign 466 to Hello C"; Roman Urdu
 *     "466 ka subject badal ke 'Hello C updated' kar do" saved "badal ke 'Hello C updated' kar do";
 *     "body: just a QA test, please ignore" lost everything after the comma — all with no confirmation.
 *   - "suggest a better subject line for campaign 466" / "rewrite the body friendlier" OVERWROTE the email
 *     with the request text instead of showing suggestions.
 *   - "write a quick email to announce our launch" created a campaign and offered to START it.
 *   - "change the sender name to QA Bot" said "updated successfully" but nothing changed: the sender
 *     comes from the campaign's email account (SMTP profile).
 *   - "schedule X for 31 December 2026 at 10:00" answered with a JSON stub and saved nothing.
 */

import { getOpenAIService } from "../services/openai.service.js";
import { mcpClientService } from "../services/mcpClient.service.js";
import { SCHEDULE_PARSE_PROMPT, WRITE_EMAIL_PROMPT } from "../prompts/campaignCreation.prompt.js";
import { authFromState, type CampaignRef } from "./campaignLookup.js";
import { bodyToHtml, htmlToBody, phraseHits } from "./emailRealism.js";
import { CLICHE_PHRASES, SPAM_PHRASES } from "../config/emailRealism.config.js";
import { wallClock, zonedToIso } from "./campaignCreationFlow.js";

export type EditField = "subject" | "body" | "name" | "fromName" | "fromEmail";

// ── Which field, which new value ──────────────────────────────────────────────

const FIELD_WORDS: Array<[EditField, RegExp]> = [
  ["fromName", /\b(sender|from)\s+name\b/i],
  ["fromEmail", /\b(sender|from|reply[\s-]?to)\s+(e-?mail|address)\b/i],
  ["subject", /\bsubject(\s+line)?\b/i],
  ["body", /\b(email\s+)?(body|content|email\s+text|message\s+text)\b/i],
  ["name", /\b(campaign\s+name|rename|title)\b|\bname\b/i],
];

export function editFieldIn(message: string): EditField | undefined {
  for (const [field, re] of FIELD_WORDS) if (re.test(message)) return field;
  return undefined;
}

/** The text in quotes: '…', "…", ‘…’, “…” (the last one when there are several). */
function quoted(message: string): string | undefined {
  const all = [...message.matchAll(/"([^"]+)"|“([^”]+)”|‘([^’]+)’|(?:^|[\s:(])'([^']+)'(?=[\s.!?,)]|$)/g)];
  const last = all[all.length - 1];
  const v = last ? (last[1] ?? last[2] ?? last[3] ?? last[4]) : undefined;
  return v?.trim() || undefined;
}

/**
 * The new value for `field`, exactly as the user wrote it (commas kept), or undefined when the
 * message gives none ("change the subject of campaign 466" → ask for it).
 *   "change the subject of campaign 466 to Hello C"        → "Hello C"
 *   "update campaign 466 body: just a QA test, please ignore" → "just a QA test, please ignore"
 *   "466 ka subject badal ke 'Hello C updated' kar do"       → "Hello C updated"
 *   "466 ka subject Hello C kar do"                          → "Hello C"
 */
export function editValueFrom(message: string, field: EditField): string | undefined {
  const q = quoted(message);
  if (q) return q;
  const fieldRe = FIELD_WORDS.find(([f]) => f === field)![1];
  const at = message.search(fieldRe);
  if (at < 0) return undefined;
  const fieldMatch = message.slice(at).match(fieldRe)!;
  const rest = message.slice(at + fieldMatch[0].length);
  // English: the first "to" / "as" / ":" / "=" after the field (skipping "of campaign 466").
  const sep = rest.match(/^[^:=]*?\s(?:to|as|into)\s+|^\s*[:=]\s*|^[^:=]*?[:=]\s*/i);
  if (sep) {
    const v = rest.slice(sep[0].length).trim().replace(/^["'“‘]|["'”’]$/g, "").trim();
    if (v && !/^(be|something|better|more)\b/i.test(v)) return v;
  }
  // Roman Urdu: "subject Hello C kar do", "subject badal ke Hello C kar do".
  const ur = rest.match(/^\s*(?:(?:badal|change|tabdeel)\s+(?:ke|kar\s*ke|kr\s*ke)\s+|ko\s+)?(.+?)\s+(?:kar\s*do|kardo|kr\s*do|krdo|rakh\s*do|kar\s+dein|kar\s+dain|set\s+kar\s+do)\s*[.!]*$/i);
  if (ur?.[1] && !/^(change|badal|update)$/i.test(ur[1].trim())) return ur[1].trim();
  return undefined;
}

// ── "Write / suggest" — text only, nothing saved ─────────────────────────────

/** "write me a quick email …", "give me 5 subject line ideas", "suggest a better subject for campaign 466", "rewrite the body friendlier". */
export function isWriteOnlyRequest(message: string): boolean {
  const m = message.toLowerCase();
  if (/\b(create|make|set\s+up|build|launch|start)\s+(a\s+|an\s+|the\s+|new\s+)*campaign\b|\bcampaign\s+(banao|bana\s+do|create\s+kar)/.test(m)) return false;
  // One email PER RECIPIENT is "Generate personalized emails" (its own flow), not a chat draft.
  if (/\bpersonali[sz]\w*\b|\b(each|every|all)\s+(recipient|contact|lead|person)s?\b|\bhar\s+(bande|banday|recipient|contact|shakhs)\b/.test(m)) return false;
  const suggest = /\b(suggest\w*|ideas?|options?|alternatives?|recommend\w*|behtar|acha|achi|improve|better|rewrite|re-write|reword|rephrase|polish|friendlier|shorter|more\s+\w+\s+tone|in\s+a\s+\w+(\s+\w+)?\s+tone)\b/.test(m) &&
    /\b(subject(\s+lines?)?|body|email|copy|text|wording|mail)\b/.test(m);
  const write = /\b(write|draft|compose|likh\w*)\b/.test(m) && /\b(e-?mail|mail|message|announcement|invite|invitation|newsletter|subject(\s+lines?)?|body|copy)\b/.test(m);
  // "change / update / set … to X" is an edit with a value, not a request for ideas.
  const explicitEdit = /\b(change|update|set|replace|badal\w*)\b[^.]*\b(to|:)\s+\S/.test(m) && !/\b(friendl\w*|better|tone|shorter|ideas?)\b/.test(m);
  return (suggest || write) && !explicitEdit;
}

export interface CampaignText {
  id: string;
  name: string;
  status: string;
  subject: string;
  body: string;
  smtpSettingsId?: number | undefined;
  fromName?: string | undefined;
  fromEmail?: string | undefined;
  recipientCount?: number | undefined;
}

/** A campaign with its texts, by id. */
export async function campaignText(state: { rawToken?: string | undefined; userId?: unknown }, campaignId: string): Promise<CampaignText | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  try {
    const r = await mcpClientService.dispatch("get_all_campaigns", {}, auth);
    const env = r.data as { success?: boolean; data?: unknown } | undefined;
    if (r.isToolError || env?.success === false || !Array.isArray(env?.data)) return undefined;
    const c = (env.data as Array<Record<string, unknown>>).find((x) => String(x.id) === campaignId);
    if (!c) return undefined;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      id: String(c.id),
      name: s(c.name),
      status: s(c.status),
      subject: s(c.subject),
      body: htmlToBody(s(c.body).replace(/<(?!\/?(p|br)\b)[^>]+>/gi, "")),
      ...(typeof c.smtpSettingsId === "number" ? { smtpSettingsId: c.smtpSettingsId } : {}),
      ...(s(c.fromName) ? { fromName: s(c.fromName) } : {}),
      ...(s(c.fromEmail) ? { fromEmail: s(c.fromEmail) } : {}),
      ...(typeof c.recipientCount === "number" ? { recipientCount: c.recipientCount } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Writes or suggests text in the chat and saves NOTHING. With a campaign, its subject / body are the
 * starting point. The answer says how to save a suggestion (an explicit edit, which is confirmed first).
 */
export async function writeEmailAnswer(
  message: string,
  campaign: CampaignText | undefined,
  senderName?: string,
): Promise<string> {
  const openai = getOpenAIService();
  const saveHint = campaign
    ? `Nothing was changed in **${campaign.name}** (#${campaign.id}). To use one, say for example: *change the subject of campaign ${campaign.id} to "…"* — I'll show it and ask before saving.`
    : "Nothing was saved. To send it, say **create campaign** — or copy it into a campaign on the Campaigns page.";
  if (!openai || typeof openai.completeJson !== "function") {
    return `I can't write text right now (the AI writer is not available). ${saveHint}`;
  }
  let feedback: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await openai.completeJson(
        WRITE_EMAIL_PROMPT,
        JSON.stringify({
          request: message,
          sender_name: senderName ?? "",
          ...(campaign ? { campaign: { name: campaign.name, subject: campaign.subject, body: campaign.body.slice(0, 3000) } } : {}),
          ...(feedback.length ? { feedback } : {}),
        }),
        0.7,
      );
      const subjects = Array.isArray(out.subjects) ? out.subjects.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 8) : [];
      const subject = typeof out.subject === "string" ? out.subject.trim() : "";
      const body = typeof out.body === "string" ? out.body.replace(/\r\n/g, "\n").trim() : "";
      const text = [subject, body, ...subjects].join("\n");
      feedback = [
        ...(!subjects.length && !body ? ["Give either subjects or a body."] : []),
        ...(/\{\{|\}\}/.test(text) ? ["Use {first_name} with ONE pair of braces, never {{…}}."] : []),
        ...(/\*\*|\[[^\]]+\]\(|<[a-z]/i.test(text) ? ["Plain text only: no markdown, links or HTML."] : []),
        ...phraseHits(text, [...SPAM_PHRASES, ...CLICHE_PHRASES]).map((p) => `Do not use "${p}".`),
      ];
      if (feedback.length && attempt < 2) continue;
      const lines: string[] = [];
      if (subjects.length) lines.push("**Subject line ideas:**", ...subjects.map((s, i) => `${i + 1}. ${s}`));
      if (body) {
        if (lines.length) lines.push("");
        if (subject) lines.push(`**Subject:** ${subject}`, "");
        lines.push("**Email:**", "", body);
      }
      return [...lines, "", saveHint].join("\n");
    } catch {
      break;
    }
  }
  return `I couldn't write that right now. Please try again. ${saveHint}`;
}

// ── Body for saving ──────────────────────────────────────────────────────────

/** A typed body as the campaign's HTML (one <p> per paragraph), placeholders kept. HTML typed by the user is kept. */
export function bodyForSave(body: string): string {
  if (/<(p|div|br|table|h[1-6])\b/i.test(body)) return body;
  return bodyToHtml(body)
    .replace(/&#123;&#123;\s*([a-z_][a-z0-9_]*)\s*&#125;&#125;/gi, "{$1}")
    .replace(/&#123;([a-z_][a-z0-9_]*)&#125;/gi, "{$1}");
}

// ── Sender = the email account ───────────────────────────────────────────────

export interface SmtpAccount { id: number; fromEmail: string; fromName: string }

export async function smtpAccounts(state: { rawToken?: string | undefined; userId?: unknown }): Promise<SmtpAccount[] | undefined> {
  const auth = authFromState(state);
  if (!auth) return undefined;
  try {
    const r = await mcpClientService.dispatch("get_smtp_settings", {}, auth);
    const env = r.data as { success?: boolean; data?: Record<string, unknown> } | undefined;
    if (r.isToolError || env?.success === false) return undefined;
    const d = (env?.data ?? env ?? {}) as Record<string, unknown>;
    const list = Array.isArray(d.accounts) ? (d.accounts as Array<Record<string, unknown>>) : [];
    return list
      .filter((a) => typeof a.id === "number" && typeof a.fromEmail === "string")
      .map((a) => ({ id: a.id as number, fromEmail: a.fromEmail as string, fromName: typeof a.fromName === "string" ? a.fromName : "" }));
  } catch {
    return undefined;
  }
}

// ── Schedule time ────────────────────────────────────────────────────────────

export type ScheduleTime =
  | { kind: "time"; local: string; iso: string }
  | { kind: "past"; local: string }
  | { kind: "unclear" };

/** "31 December 2026 at 10:00 AM", "tomorrow 9am", "kal subah 10 baje" → a future time in the user's zone. */
export async function scheduleTimeFrom(message: string, timeZone: string, now = new Date()): Promise<ScheduleTime> {
  let local = "";
  const direct = message.match(/\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\b/);
  if (direct) local = `${direct[1]} ${direct[2]}`;
  else {
    const openai = getOpenAIService();
    if (openai && typeof openai.completeJson === "function") {
      try {
        const answer = await openai.completeJson(
          SCHEDULE_PARSE_PROMPT,
          JSON.stringify({ message, now: `${wallClock(now, timeZone)} (${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(now)})`, timezone: timeZone }),
          0,
        );
        if (answer.status === "scheduled" && typeof answer.local === "string") local = answer.local.trim();
      } catch {
        /* unclear */
      }
    }
  }
  if (!local) return { kind: "unclear" };
  const iso = zonedToIso(local, timeZone);
  if (!iso) return { kind: "unclear" };
  if (new Date(iso).getTime() <= now.getTime() + 60_000) return { kind: "past", local };
  return { kind: "time", local, iso };
}

export type { CampaignRef };
