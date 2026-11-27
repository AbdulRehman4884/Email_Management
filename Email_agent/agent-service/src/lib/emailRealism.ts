/**
 * src/lib/emailRealism.ts
 *
 * Every campaign email must read like a normal 1-to-1 email typed in Gmail.
 *   normalizeBody()  — fixes spacing: greeting line, 2–3 paragraphs, sign-off + name, clean characters.
 *   bodyToHtml()     — the HTML part: plain <p> per paragraph, <br> inside the signature, nothing else.
 *   validateEmail()  — checks V1–V17; an empty list means the email may be used.
 * Word lists live in config/emailRealism.config.ts.
 */

import {
  ALLOWED_ACRONYMS,
  BODY_WORDS,
  CLICHE_PHRASES,
  GREETING_WORDS,
  MAX_ABOUT_OVERLAP,
  MAX_AVG_SENTENCE_WORDS,
  MAX_SENTENCES_PER_PARAGRAPH,
  MAX_SIMILARITY,
  PARAGRAPHS,
  SIGNOFF_LINES,
  SOURCE_LEAK_PHRASES,
  SPAM_PHRASES,
  SUBJECT_WORDS,
  GENERIC_SUBJECTS,
} from "../config/emailRealism.config.js";

const ZERO_WIDTH_RE = /[​-‍⁠﻿]/g;
const NBSP_RE = /[   ]/g;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GREETING_RE = new RegExp(`^(?:${GREETING_WORDS.join("|")})\\b[^\\n]{0,60},$`, "i");
const SIGNOFF_RE = new RegExp(`^(?:${SIGNOFF_LINES.map(escapeRe).join("|")})[,.]?$`, "i");

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * Plain-text body in the house shape:
 *   "Hi Ali,\n\n<paragraph>\n\n<paragraph>\n\nBest,\nBassam"
 * Line endings, non-breaking spaces, zero-width characters, curly quotes and double spaces are cleaned,
 * hard-wrapped paragraphs are joined, and a blank line inside the signature is removed.
 */
export function normalizeBody(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(NBSP_RE, " ")
    .replace(ZERO_WIDTH_RE, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();

  let blocks = cleaned.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  // "Hi Ali,\nI saw ..." → greeting on its own line.
  const firstLines = blocks[0]?.split("\n") ?? [];
  if (firstLines.length > 1 && GREETING_RE.test(firstLines[0]!)) {
    blocks = [firstLines[0]!, firstLines.slice(1).join("\n"), ...blocks.slice(1)];
  }

  // "Best,\n\nBassam" → "Best,\nBassam"; "...question?\nBest,\nBassam" → its own block.
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i]!.split("\n");
    const signoffAt = lines.findIndex((l) => SIGNOFF_RE.test(l));
    if (signoffAt > 0) {
      out.push(lines.slice(0, signoffAt).join("\n"));
      blocks.splice(i + 1, 0, lines.slice(signoffAt).join("\n"));
      continue;
    }
    if (lines.length === 1 && SIGNOFF_RE.test(lines[0]!) && blocks[i + 1] && blocks[i + 1]!.split("\n").length <= 2) {
      out.push(`${lines[0]}\n${blocks[i + 1]}`);
      i++;
      continue;
    }
    out.push(blocks[i]!);
  }

  // Paragraphs are never hard-wrapped (the greeting and the signature keep their lines).
  return out
    .map((b, i) => (i === 0 && GREETING_RE.test(b)) || isSignature(b) ? b : b.replace(/\n/g, " "))
    .join("\n\n");
}

function isSignature(block: string): boolean {
  return SIGNOFF_RE.test(block.split("\n")[0] ?? "");
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // The backend fills {x} and {{x}} when sending: braces in the text must not become placeholders.
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");

/** The HTML part: one plain <p> per paragraph, <br> for line breaks (signature). No styles, no other tags. */
export function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** The body back as plain text (from bodyToHtml's output). */
export function htmlToBody(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<\/?p>/gi, "")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

// ── Reading a body ───────────────────────────────────────────────────────────

export interface BodyParts {
  greeting: string;
  paragraphs: string[];
  signature: string[];
}

export function splitBody(body: string): BodyParts {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const greeting = blocks[0] && GREETING_RE.test(blocks[0]) ? blocks.shift()! : "";
  const last = blocks[blocks.length - 1];
  const signature = last && isSignature(last) ? blocks.pop()!.split("\n") : [];
  return { greeting, paragraphs: blocks, signature };
}

const wordsOf = (s: string) => s.match(/[A-Za-z0-9][A-Za-z0-9'%$.-]*/g) ?? [];
const sentencesOf = (s: string) => s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => wordsOf(x).length > 0);
const tokens = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));

const STOP = new Set([
  "the", "and", "for", "with", "you", "your", "our", "are", "was", "that", "this", "have", "has", "from", "but", "not",
  "can", "will", "all", "any", "how", "who", "what", "its", "it's", "they", "their", "them", "out", "about", "into",
]);

export function phraseHits(text: string, phrases: string[]): string[] {
  const lower = text.toLowerCase();
  return phrases.filter((p) => {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(p.toLowerCase())}($|[^a-z0-9])`, "i");
    return re.test(lower);
  });
}

function trigrams(s: string): Set<string> {
  const w = (s.toLowerCase().match(/[a-z0-9']+/g) ?? []);
  const out = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** Word 3-gram Jaccard similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let both = 0;
  for (const g of A) if (B.has(g)) both++;
  return both / (A.size + B.size - both);
}

/** Share of `part`'s content words that also appear in `whole`, 0..1. */
function coverage(part: string, whole: string): number {
  const P = tokens(part);
  if (P.size === 0) return 0;
  const W = tokens(whole);
  let hit = 0;
  for (const t of P) if (W.has(t)) hit++;
  return hit / P.size;
}

export const firstSentence = (paragraph: string) => sentencesOf(paragraph)[0] ?? paragraph;

// ── Validation ───────────────────────────────────────────────────────────────

export interface DraftEmail {
  subject: string;
  body: string;
  /** The research fact the opening is built on (writer's personalization_fact). */
  fact: string;
}

export interface ValidationContext {
  recipientFirstName?: string;
  recipientCompany?: string;
  senderFirstName: string;
  /** Everything known about the recipient: row fields + fetched link text. */
  research: string;
  /** The website's own words (tagline / About text), if a site was read. */
  aboutText?: string;
  /** What the sender told us (purpose, real results): numbers may come only from here or the research. */
  senderFacts: string;
  /** Other emails of this campaign (uniqueness). */
  others: Array<{ body: string; subject?: string }>;
  /** The sign-off the user's instructions ask for ("Regards,"): every email ends with it. */
  signoff?: string;
  /** The user asked for KPIs / percentages as proposed targets: numbers are allowed (framed as targets by the writer). */
  targetNumbers?: boolean;
  /** The user gave their own subject-line instructions: only basic subject checks apply. */
  subjectFree?: boolean;
  /** The user's master instruction: paragraphs and words (default PARAGRAPHS / BODY_WORDS). */
  format?: { paragraphs?: { min: number; max: number }; words?: { min: number; max: number } };
}

/** Words of a company name that identify it ("Moore Recovery Ltd" → moore, recovery). */
const COMPANY_FILLER = new Set(["the", "and", "ltd", "limited", "inc", "llc", "llp", "plc", "co", "corp", "company", "group", "gmbh", "pvt", "private"]);
/** The sign-off line in the user's instructions ("Regards," / "Kind regards"), if it is one of the usual ones. */
export function signoffIn(instructions: string | undefined): string | undefined {
  for (const line of (instructions ?? "").split(/\r?\n/)) {
    const t = line.trim().replace(/[,.!]+$/, "");
    if (t && SIGNOFF_LINES.includes(t.toLowerCase())) return `${t.charAt(0).toUpperCase()}${t.slice(1)},`;
  }
  return undefined;
}

/** The email with this sign-off line (greeting, paragraphs and the name below it unchanged). */
export function withSignoff(body: string, signoff: string): string {
  const { greeting, paragraphs, signature } = splitBody(body);
  if (signature.length < 2) return body;
  return [greeting, ...paragraphs, [signoff, ...signature.slice(1)].join("\n")].filter(Boolean).join("\n\n");
}

export function companyWords(company: string | undefined): string[] {
  return (company ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !COMPANY_FILLER.has(w));
}

/**
 * A problem that makes the email unusable (markup, spam words, source leaks, placeholders, wrong names,
 * links, wrong sender, broken characters, invented numbers, missing greeting / sign-off, fake "Re:" / emoji).
 * Everything else (length a little off, a phrase, same KPIs as another prospect …) is a style issue:
 * after the retries such an email is still saved, so no recipient is lost.
 */
export function isHardIssue(issue: string): boolean {
  if (/^V(3|4|7|8|9|11|14|16|17):/.test(issue)) return true;
  if (/^V1:/.test(issue) && /greeting|sign-off/.test(issue)) return true;
  if (/^V12:/.test(issue) && /Re: or Fwd|emoji/.test(issue)) return true;
  return !/^V\d+:/.test(issue);
}

/** All problems of a draft (V1–V17). Empty = the email can be used. */
export function validateEmail(email: DraftEmail, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const { greeting, paragraphs, signature } = splitBody(email.body);
  const text = paragraphs.join("\n\n");
  const bodyWords = wordsOf(text).length;
  const subjectWords = wordsOf(email.subject);

  // V1 structure
  if (!greeting) errors.push("V1: the body must start with a greeting line on its own, e.g. \"Hi Ali,\"");
  const paraLimit = ctx.format?.paragraphs ?? PARAGRAPHS;
  const wordLimit = ctx.format?.words ?? BODY_WORDS;
  if (paragraphs.length < paraLimit.min || paragraphs.length > paraLimit.max) {
    errors.push(`V1: the body must have ${paraLimit.min}–${paraLimit.max} paragraph${paraLimit.max === 1 ? "" : "s"} between greeting and sign-off (it has ${paragraphs.length})`);
  }
  if (signature.length < 2) errors.push("V1: end with a sign-off line (e.g. \"Best,\") and the sender's name on the next line");

  // V2 length
  if (bodyWords < wordLimit.min || bodyWords > wordLimit.max) {
    errors.push(`V2: the body has ${bodyWords} words; it must have ${wordLimit.min}–${wordLimit.max} (without greeting and signature)`);
  }
  // A one-paragraph email holds the whole message, so it may have more sentences.
  const maxSentences = paraLimit.max === 1 ? 7 : MAX_SENTENCES_PER_PARAGRAPH;
  paragraphs.forEach((p, i) => {
    const n = sentencesOf(p).length;
    if (n > maxSentences) errors.push(`V2: paragraph ${i + 1} has ${n} sentences; use at most ${maxSentences}`);
  });
  const sentences = paragraphs.flatMap(sentencesOf);
  // The user's own format (e.g. one dense paragraph) gets more room per sentence than the default style.
  const maxAvg = ctx.format ? 25 : MAX_AVG_SENTENCE_WORDS;
  if (sentences.length > 0 && bodyWords / sentences.length > maxAvg) {
    errors.push(`V2: sentences are too long (average ${Math.round(bodyWords / sentences.length)} words); keep them under ${maxAvg}`);
  }

  // V3 markup
  if (/<\s*(div|table|style|button|img|hr|span|p|br|a|b|strong|h[1-6])\b|style\s*=|class\s*=/i.test(email.body)) errors.push("V3: no HTML in the body; write plain text");
  if (/\*\*|__|##|^\s*([-*•]|\d+[.)])\s/m.test(email.body)) errors.push("V3: no markdown, bold or bullet points");

  // V4 spam words
  const spam = phraseHits(`${email.subject}\n${email.body}`, SPAM_PHRASES);
  if (spam.length) errors.push(`V4: remove spam words: ${spam.join(", ")}`);

  // V5 clichés
  const cliches = phraseHits(email.body, CLICHE_PHRASES);
  if (cliches.length) errors.push(`V5: remove these phrases: ${cliches.join(", ")}`);
  if ((email.body.match(/—/g) ?? []).length > 1) errors.push("V5: use at most one em dash (—)");

  // V6 personalization
  const first = paragraphs[0] ?? "";
  if (!email.fact.trim()) {
    errors.push("V6: personalization_fact is missing");
  } else {
    // A fact from the row / research, or (little known) the company itself with its industry.
    const names = companyWords(ctx.recipientCompany);
    const aboutCompany = names.length > 0 && names.some((w) => email.fact.toLowerCase().includes(w));
    if (coverage(email.fact, ctx.research) < 0.6 && !aboutCompany) errors.push("V6: personalization_fact must be a fact from the research, not invented");
    // Notes in another language ("parathay") come back in English ("parathas"): the company named in the opening is enough.
    const opensWithCompany = aboutCompany && names.some((w) => first.toLowerCase().includes(w));
    if (coverage(email.fact, first) < 0.3 && !opensWithCompany) errors.push("V6: the first paragraph must open with the personalization fact");
  }
  if (ctx.aboutText && coverage(first, ctx.aboutText) > MAX_ABOUT_OVERLAP) {
    errors.push("V6: the first paragraph repeats the website's own tagline / About text; use a specific observation instead");
  }

  // V7 source leaks
  const leaks = phraseHits(`${email.subject}\n${email.body}`, SOURCE_LEAK_PHRASES);
  if (leaks.length) errors.push(`V7: never say where the recipient was found: ${leaks.join(", ")}`);

  // V8 placeholder leaks
  if (/[{}[\]]|\{\{/.test(`${email.subject}${email.body}`)) errors.push("V8: brackets / placeholders left in the text");
  if (/\b(undefined|null|N\/A|first_name|company_name)\b|(^|[\s,:])None([\s,.]|$)/.test(`${email.subject}\n${email.body}`)) {
    errors.push("V8: a placeholder value (undefined, null, None, N/A, first_name …) is left in the text");
  }

  // V9 names
  if (greeting) {
    const name = ctx.recipientFirstName?.trim();
    const greetName = greeting.replace(/,$/, "").split(/\s+/).slice(1).join(" ");
    if (name && greetName.toLowerCase() !== name.toLowerCase()) errors.push(`V9: greet the recipient exactly as "${name}" (found "${greetName || "no name"}")`);
    if (!name && greetName && !/^there$/i.test(greetName)) errors.push("V9: the recipient's name is unknown; greet with \"Hi there,\"");
  }
  const company = ctx.recipientCompany?.trim();
  if (company && company.length > 2) {
    const re = new RegExp(`\\b${escapeRe(company)}\\b`, "gi");
    for (const m of email.body.match(re) ?? []) {
      if (m !== company) errors.push(`V9: write the company name exactly as "${company}" (found "${m}")`);
    }
  }

  // V10 capitals and punctuation
  // Acronyms, and the company's own name as written ("ABC Holdings").
  const allowed = new Set([
    ...ALLOWED_ACRONYMS.map((a) => a.toUpperCase()),
    ...(ctx.recipientCompany ?? "").split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9]/g, "").toUpperCase()).filter(Boolean),
    // Capitals the row or research itself uses ("export to the UK and UAE").
    ...(ctx.research.match(/[A-Z]{2,}/g) ?? []),
  ]);
  const shouting = [...new Set((email.body.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !allowed.has(w)))];
  if (shouting.length) errors.push(`V10: no all-caps words: ${shouting.join(", ")}`);
  if (/!/.test(email.body)) errors.push("V10: no exclamation marks");
  if (/\?\?|\.\.\.|…/.test(email.body)) errors.push("V10: no \"??\" or \"...\"");

  // V11 links
  if (/https?:\/\/|www\.|\b(bit\.ly|tinyurl|t\.co|goo\.gl|ow\.ly)\b|\b[a-z0-9-]+\.(com|io|net|org|co|ai|dev|pk|app)(\/|\b)/i.test(email.body)) {
    errors.push("V11: no links or web addresses in a first email");
  }

  // V12 subject
  if (subjectWords.length < SUBJECT_WORDS.min || subjectWords.length > SUBJECT_WORDS.max) {
    errors.push(`V12: the subject must have ${SUBJECT_WORDS.min}–${SUBJECT_WORDS.max} words (it has ${subjectWords.length})`);
  }
  if (EMOJI_RE.test(email.subject) || /!/.test(email.subject)) errors.push("V12: no emoji or \"!\" in the subject");
  if (/^\s*(re|fwd?)\s*:/i.test(email.subject)) errors.push("V12: the subject must not start with Re: or Fwd:");
  const keepCase = new Set([
    ...allowed,
    ...(ctx.recipientFirstName ? [ctx.recipientFirstName.toUpperCase()] : []),
    ...(company ? company.toUpperCase().split(/\s+/) : []),
  ]);
  // Properly capitalised, like a real business email (Title Case or sentence case): never all lowercase or ALL CAPS.
  const firstChar = email.subject.trim().charAt(0);
  if (firstChar && firstChar !== firstChar.toUpperCase()) errors.push("V12: start the subject with a capital letter");
  const shout = subjectWords.filter((w) => /^[A-Z]{3,}$/.test(w) && !keepCase.has(w));
  if (shout.length >= 2) errors.push("V12: no words in capitals in the subject (except acronyms)");
  // The company name (when known) is in the subject, so it is clearly about this prospect.
  const names = companyWords(ctx.recipientCompany);
  if (names.length && !names.some((w) => email.subject.toLowerCase().includes(w))) {
    errors.push(`V12: put the company name "${ctx.recipientCompany}" in the subject`);
  }
  if (/\?/.test(email.subject)) errors.push("V12: the subject is a short statement, not a question (no question mark)");
  if (/[^A-Za-z0-9\s'&:-]/.test(email.subject) || (email.subject.match(/:/g) ?? []).length > 1 || /^\s*:/.test(email.subject)) {
    errors.push("V12: no punctuation in the subject (one colon after the company name is fine)");
  }
  const plainSubject = email.subject.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\b(your|for you|you)\b/g, " ").replace(/\s+/g, " ").trim();
  // Without the company and filler words, "Streamlining Operations at Greenfields Farm" is still only "streamlining operations".
  const coreSubject = plainSubject
    .split(" ")
    .filter((w) => !companyWords(ctx.recipientCompany).includes(w) && !["at", "for", "with", "in", "of", "the", "and", "ai", "automation", "to"].includes(w))
    .join(" ");
  const VAGUE_SUBJECT =
    /^(improving|improve|streamlining|streamline|optimizing|optimising|optimize|enhancing|enhance|boosting|boost|better|smarter|simplifying)( (customer|client|business|team|daily|overall))? (operations|efficiency|engagement|communication|processes|workflows?|management|growth|productivity)$/;
  if (GENERIC_SUBJECTS.includes(plainSubject) || GENERIC_SUBJECTS.includes(coreSubject) || VAGUE_SUBJECT.test(coreSubject)) {
    errors.push("V12: the subject is generic; name what is specific to this recipient (their company, project, role or the fact you open with)");
  }

  // The user's own subject instructions win over the default subject style (length, company name, statement form …);
  // only a broken subject (fake Re:, emoji, "!", empty, far too long) still fails.
  if (ctx.subjectFree) {
    for (let k = errors.length - 1; k >= 0; k--) {
      if (errors[k]!.startsWith("V12:") && !/Re: or Fwd|emoji/.test(errors[k]!)) errors.splice(k, 1);
    }
    if (subjectWords.length < 1 || subjectWords.length > 15) errors.push("V12: the subject must have 1–15 words");
  }

  // V13 one question, at the end
  const questions = (text.match(/\?/g) ?? []).length;
  if (questions !== 1 || !(paragraphs[paragraphs.length - 1] ?? "").includes("?")) {
    errors.push("V13: ask exactly one question, in the last paragraph");
  }

  // V14 sender
  const sender = ctx.senderFirstName.trim();
  if (sender && !signature.slice(1).some((l) => new RegExp(`\\b${escapeRe(sender)}\\b`, "i").test(l))) {
    errors.push(`V14: sign with the sender's first name "${sender}" under the sign-off`);
  }

  // V15 uniqueness
  // The same KPI percentages as another prospect (the user asked for different ones per company).
  const pcts = (s: string) => (s.match(/\d+(?:\.\d+)?\s?%/g) ?? []).map((x) => x.replace(/\s/g, ""));
  const mine = pcts(text);
  if (mine.length >= 2) {
    // In any order: 30/25/20 and 20/25/30 are the same numbers.
    const key = (list: string[]) => [...list].sort().join(",");
    const same = ctx.others.find((o) => key(pcts(o.body)) === key(mine));
    if (same) errors.push(`V15: another prospect already got exactly these percentages (${mine.join(", ")}); choose KPIs and realistic percentages that fit THIS company`);
  }
  // The same problem sentence as another prospect: name a challenge specific to this company.
  const problem = sentencesOf(first)[1] ?? "";
  if (problem && ctx.others.some((o) => {
    const theirs = sentencesOf(splitBody(o.body).paragraphs[0] ?? "")[1] ?? "";
    return theirs && coverage(problem, theirs) > 0.7;
  })) {
    errors.push("V15: the problem sentence is almost the same as in another prospect's email; name a challenge specific to this company");
  }
  const subjectKey = email.subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (subjectKey && ctx.others.some((o) => (o.subject ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === subjectKey)) {
    errors.push("V15: another recipient already got this exact subject; make it specific to this recipient");
  }
  const opening = firstSentence(first).toLowerCase().replace(/\s+/g, " ").trim();
  for (const other of ctx.others) {
    const o = splitBody(other.body);
    if (opening && firstSentence(o.paragraphs[0] ?? "").toLowerCase().replace(/\s+/g, " ").trim() === opening) {
      errors.push("V15: another recipient already got this exact opening sentence");
      break;
    }
    if (similarity(text, o.paragraphs.join("\n\n")) > MAX_SIMILARITY) {
      errors.push("V15: too similar to another recipient's email; write it differently");
      break;
    }
  }

  // V16 characters
  if (EMOJI_RE.test(email.body)) errors.push("V16: no emojis");
  if (NBSP_RE.test(email.body) || /[​-‍⁠﻿]/.test(email.body)) errors.push("V16: invisible characters in the text");
  if (/ {2,}/.test(email.body) || /â€|Ã/.test(email.body)) errors.push("V16: double spaces or broken characters");

  // V17 no invented numbers: a number or result must come from the research or from what the sender told us.
  const known = `${ctx.research}\n${ctx.senderFacts}`;
  // A call length or a day ("a 15-minute chat", "next 2 weeks") is not a claimed result.
  const claims = text.replace(/\b\d+[\s-]?(minutes?|mins?|hours?|days?|weeks?|months?)\b/gi, " ");
  const numbers = [...new Set(claims.match(/\$?\d[\d,.]*\s?(%|k|x|\+)?/gi) ?? [])].map((n) => n.trim().replace(/[.,]$/, ""));
  const invented = numbers.filter((n) => !known.includes(n.replace(/\s/g, "")) && !known.includes(n));
  if (invented.length && !ctx.targetNumbers) errors.push(`V17: these numbers are not in the research or the sender's facts (do not invent results): ${invented.join(", ")}`);

  return [...new Set(errors)];
}
