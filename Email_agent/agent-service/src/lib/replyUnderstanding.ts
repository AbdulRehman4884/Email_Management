/**
 * src/lib/replyUnderstanding.ts
 *
 * Every step of the chat flows (campaign creation, personalized emails, automations) asks one question.
 * The user may answer in any language and in their own words ("call book krni ha" instead of "2").
 * understandReply() gives the step's guide + the message to the LLM (REPLY_UNDERSTANDING_PROMPT) and gets back
 *   - the reply in the form the step already understands ("2", "approve", "3: shorter", "back", the free text), or
 *   - a message for the user (a question about the step, two options fit, or something the step cannot do).
 * Clear replies (a number, "approve", "back", "cancel", "keep") skip the LLM. Without the LLM, or when its answer
 * cannot be used, the message goes to the step unchanged — the step's own checks answer as before.
 */

import { z } from "zod";
import { getOpenAIService } from "../services/openai.service.js";
import { REPLY_UNDERSTANDING_PROMPT } from "../prompts/campaignCreation.prompt.js";
import { createLogger } from "./logger.js";

const log = createLogger("replyUnderstanding");

export interface StepGuide {
  /** "campaign creation", "personalized emails", "automation". */
  flow: string;
  step: string;
  /** What the step asked, in plain English. */
  question: string;
  /** The numbered options shown (1-based), when the step has options. */
  choices?: Array<{ label: string; description?: string }>;
  /** Every reply the step accepts: "<form> — <meaning>". */
  replies: string[];
  /** What the user may ask for that cannot be done here, and what to say instead. */
  notPossible?: string[];
  /** Messages that the step already reads well (no LLM call), on top of the common ones. */
  clear?: RegExp;
}

export type Understood = { kind: "reply"; text: string } | { kind: "say"; message: string };

/** A number first ("2", "#3", "2 but shorter") or one of the common commands: the step reads it as it is. */
const COMMON_CLEAR =
  /^#?\d{1,4}\b|^(cancel|back|go back|previous step|keep|approve|approved|ok|okay|yes|no|skip|now|regenerate\s*#?\d+|show\s+(all|#?\d+))$/i;

const answerSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), reply: z.string().trim().min(1).max(2000) }),
  z.object({ action: z.literal("say"), message: z.string().trim().min(1).max(2000) }),
]);

/**
 * The user's answer as the step understands it. undefined = use the message as it is (clear already, no LLM,
 * or an answer that could not be used).
 */
export async function understandReply(guide: StepGuide, message: string): Promise<Understood | undefined> {
  const msg = message.trim();
  if (!msg || msg.length > 2000) return undefined;
  if (COMMON_CLEAR.test(msg) || guide.clear?.test(msg)) return undefined;
  // "deflat", "aprove", "cancle": a misspelt one-word command of this step.
  const typo = typoCommand(msg, guide.replies);
  if (typo) return { kind: "reply", text: typo };
  const openai = getOpenAIService();
  if (!openai) return undefined;
  try {
    const raw = await openai.completeJson(
      REPLY_UNDERSTANDING_PROMPT,
      JSON.stringify({
        flow: guide.flow,
        step: guide.step,
        question: guide.question,
        ...(guide.choices?.length ? { choices: guide.choices.map((c, i) => ({ number: i + 1, ...c })) } : {}),
        replies: guide.replies,
        ...(guide.notPossible?.length ? { notPossible: guide.notPossible } : {}),
        message: msg,
      }),
      0,
    );
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    if (parsed.data.action === "say") return { kind: "say", message: parsed.data.message };
    const reply = stripMeaning(parsed.data.reply, guide.replies);
    // A number must be one of the options shown.
    const n = Number(reply.match(/^#?(\d{1,4})\b/)?.[1]);
    if (guide.choices?.length && n && (n < 1 || n > guide.choices.length)) return undefined;
    if (reply !== msg) log.info({ flow: guide.flow, step: guide.step }, "reply understood");
    return { kind: "reply", text: reply };
  } catch (err) {
    log.warn({ flow: guide.flow, step: guide.step, err: (err as Error).message }, "reply understanding failed — using the message as it is");
    return undefined;
  }
}

/** Edit distance (insert / delete / replace / swap two neighbours). */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * A one-word reply that is a misspelling of exactly one one-word command this step takes ("deflat" → "default").
 * Same first letter, up to 1–3 mistakes by length; words under 3 letters are never guessed.
 */
export function typoCommand(message: string, forms: string[]): string | undefined {
  const word = message.trim().toLowerCase();
  if (!/^[a-z]{3,12}$/.test(word)) return undefined;
  const commands = [...new Set(forms.map((f) => f.split(" — ")[0]!.trim().toLowerCase()).filter((c) => /^[a-z]{4,}$/.test(c)))];
  const close = commands.filter((c) => {
    // Same first letter; 1 mistake in short words, 2 in 6 letters, 3 in longer ones ("deflat" → "default").
    const allowed = c.length <= 5 ? 1 : c.length === 6 ? 2 : 3;
    return c[0] === word[0] && Math.abs(c.length - word.length) <= allowed && distance(word, c) <= allowed;
  });
  return close.length === 1 ? close[0] : undefined;
}

/**
 * The LLM sometimes copies the form's explanation after the reply ("approve — the emails are fine, go on",
 * "<their offer> — the purpose / offer in their own words"). Only the reply itself goes to the step.
 */
export function stripMeaning(reply: string, forms: string[]): string {
  let out = reply.trim();
  for (const form of forms) {
    const at = form.indexOf(" — ");
    if (at < 0) continue;
    const meaning = form.slice(at + 3).trim().toLowerCase();
    const i = out.toLowerCase().lastIndexOf(" — ");
    if (i > 0 && meaning.startsWith(out.slice(i + 3).trim().toLowerCase().slice(0, 25))) {
      out = out.slice(0, i).trim();
      break;
    }
  }
  return out;
}

// ── Reply forms shared by the flows ──────────────────────────────────────────

export const CANCEL_REPLY = "cancel — stop the whole flow";
export const BACK_REPLY = "back — go to the previous step";
export const KEEP_REPLY = "keep — keep the answer given before (shown as \"Now: ...\") and move on";
export const NUMBER_REPLY = "<number> — pick that option";
