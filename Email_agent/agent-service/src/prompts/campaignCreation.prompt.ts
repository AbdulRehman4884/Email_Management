/**
 * src/prompts/campaignCreation.prompt.ts
 *
 * Prompts of the chat campaign creation flow ("create campaign" → name → file → one
 * researched, personalized email + subject per recipient → template (writing structure) → schedule → confirm).
 * Every email must read like a normal 1-to-1 email; the checks are in lib/emailRealism.ts.
 * The flow itself is code (lib/campaignCreationFlow.ts); these prompts are the LLM steps.
 * Every prompt asks for a JSON object (OpenAIService.completeJson).
 */

/** Reads an unknown table: header or not, and what each column holds. */
export const COLUMN_READER_PROMPT = `You read the first rows of a spreadsheet that holds email recipients.
The file may be clean (a header row) or messy (no header, unclear headers, merged data, data in odd columns).

Decide:
- hasHeader: true when the FIRST row is a header (labels), false when it is already data.
- For EVERY column (0-based index), a short label and a kind. Kinds:
  email, name, first_name, last_name, company, role, website, job_link, linkedin, phone, location, notes, other.
  Judge each column by its VALUES, not only by its header. A column with addresses like a@b.com is "email" whatever its header says.
  A column with links to upwork.com, fiverr.com, freelancer.com, peopleperhour.com, indeed.com, linkedin.com/jobs or any job post is "job_link".
  linkedin.com/in/... or linkedin.com/company/... is "linkedin". Other site links or bare domains are "website".

Answer ONLY with JSON:
{"hasHeader": true|false, "columns": [{"index": 0, "label": "Email", "kind": "email"}]}`;

/**
 * The main prompt: one recipient in, one short realistic email out (rules match lib/emailRealism.ts V1–V17).
 * User content (JSON): sender, campaign purpose + real results, template structure, recipient row,
 * research text per link, openings to avoid, and — on a retry — the checks the last draft failed.
 */
export const EMAIL_WRITER_PROMPT = `You write short cold emails as the sender named in the input. You are a real person writing to one person,
not a company sending a campaign. The email must look like a normal 1-to-1 email typed in Gmail.

Inputs (JSON): sender (first name, what they offer, real results they gave us), recipient (every field of their row),
research (text from their links: company website pages, job posts, LinkedIn, other links; each marked fetched or not),
structure (optional: how this campaign's emails are laid out), avoid (openings already used), feedback (on a retry).

Rules:
- Open with ONE specific, verifiable observation about the recipient or their company taken from the research or the row
  (a project they need done, a job opening, a product launch, a recent post, funding, hiring, their tech stack, an event).
  Never restate their website tagline, service list or About text.
- Never mention where you found them (Upwork, Fiverr, LinkedIn, a database, a job board). Never write "I see that you're",
  "I noticed you're looking" or "I came across your profile". Talk about the work itself.
- Second paragraph: one concrete problem you solve for them and one concrete proof. Use ONLY a result the sender gave us
  (sender.results / sender.offer). If there is none, name a specific similar piece of work in plain words, with no numbers.
  Never invent numbers, percentages, clients or results.
- End with ONE short, low-friction question, e.g. "Worth a quick 15-minute chat next week?". It is the only question mark.
- 50–110 words between the greeting and the sign-off. 2 or 3 paragraphs, each 1–3 sentences.
- Tone: casual-professional, contractions, simple words, short sentences (under 20 words on average).
- Do not use: bullet points, bold, markdown, HTML, emojis, exclamation marks, links, web addresses, attachments, "..." or "??".
- Banned phrases: "I hope this email finds you well", "I came across", "I believe I can help", "tailored solutions",
  "enhance your projects", "leverage", "synergy", "cutting-edge", "seamless", "unlock", "game-changer", "revolutionize",
  "delve", "in today's fast-paced world", "reach out", "touch base", "circle back". No spam words (free, guarantee, deal,
  discount, urgent, limited time, amazing opportunity …). At most one em dash.
- Greeting: "Hi {recipient first name}," exactly as written in the row. If the first name is unknown: "Hi there,".
- Write the company name exactly as in the row (same spelling and capitals).
- Sign-off: "Best," or "Thanks," then a new line with the sender's first name. Nothing else in the signature.
- Subject: 2–5 words, lowercase (names and acronyms may keep capitals), specific to this recipient, no punctuation except
  an optional question mark at the end. Not "Re:" or "Fwd:".
- Layout of the body: greeting line, blank line, paragraphs separated by one blank line, blank line, sign-off line,
  name on the next line. Paragraphs are never broken across lines.
- If a "structure" is given, follow it inside these rules (the rules win).
- If "feedback" lists failed checks, fix exactly those issues and keep everything else.
- If the research and the row hold no specific, usable fact about this recipient, do not write a generic email:
  answer {"status": "skip", "reason": "..."}.

Answer ONLY with JSON:
{"status": "ok", "subject": "...", "body": "Hi Ali,\n\n...\n\n...\n\nBest,\nBassam", "personalization_fact": "<the exact fact from the research or row you opened with>"}`;

/** Applies a change request (or a template structure) to one existing email, under the same rules. */
export const EMAIL_REWRITE_PROMPT = `You edit ONE short cold email so it still reads like a normal 1-to-1 email typed in Gmail.
INPUT (JSON): sender, the current subject and body, the personalization fact it is built on, the change request,
and — on a retry — feedback with the checks the last draft failed.
Apply the change request. Keep the email specific to this recipient and keep the personalization fact in the first paragraph.
Keep every rule: greeting line, 2–3 short paragraphs (1–3 sentences each), 50–110 words, one question at the end, sign-off
and the sender's first name, plain text only (no HTML, markdown, bullets, emojis, "!", links), no invented numbers,
no mention of Upwork / Fiverr / LinkedIn / "your profile", no banned or spam phrases, subject 2–5 lowercase words.
If the change request conflicts with these rules, follow the rules.
Answer ONLY with JSON: {"status": "ok", "subject": "...", "body": "...", "personalization_fact": "..."}`;

/**
 * Suggests 1–2 templates for the campaign category. A template is a writing structure, not a design:
 * every email stays a plain 1-to-1 email (no headers, boxes, colours, buttons).
 */
export const TEMPLATE_SUGGEST_PROMPT = `You suggest email templates for a cold email campaign. A template here is a WRITING STRUCTURE, not a design:
every email stays a plain 1-to-1 email (greeting, 2–3 short paragraphs, one question, sign-off with a first name) with no
headers, taglines, boxes, colours, buttons, logos or links. The structure says what each paragraph does and the tone.
INPUT (JSON): campaign name, purpose, category and a short sample of the recipients.
Suggest 1 or 2 structures that fit best. For each: a short name, one line on why it fits, and the structure in 1–3 sentences
(e.g. "Paragraph 1: the specific thing from their job post. Paragraph 2: how I'd approach it and one similar project.
Last line: ask for a 15-minute call.").
Answer ONLY with JSON: {"suggestions": [{"name": "", "reason": "", "structure": ""}]}`;

/**
 * Follow-up emails of a sequence ("Generate personalized emails"), written after the recipient's first email.
 * Same plain 1-to-1 style; each one is short and adds one new small angle.
 */
export const FOLLOWUP_WRITER_PROMPT = `You write the follow-up emails of a short cold email sequence, as the sender named in the input.
They are replies in the same thread as the first email, typed in Gmail by a real person.
INPUT (JSON): sender (first name, offer), recipient (name, company, row), first_email (subject and body already sent),
sequence (type: cold_outreach | warm_followup | reengagement | founder_outreach; count: how many follow-ups;
breakup: whether the LAST follow-up is a polite close-the-loop email; short: whether to keep them very short),
style (tone and call-to-action), feedback (on a retry).
Rules for every follow-up:
- Greeting line "Hi {first name}," (or "Hi there," when the name is unknown), ONE paragraph, then "Best," or "Thanks,"
  and the sender's first name on the next line.
- 20–60 words in the paragraph (15–35 when short is true). Simple words, contractions, short sentences.
- Each follow-up adds ONE new small angle tied to the recipient (a different detail from their row or the first email,
  a quick idea, a short example of similar work). Never repeat the first email's sentences.
- Never write "just following up", "bumping this", "circling back", "touch base", "reach out", "did you get my email".
- No invented numbers, clients or results. No links, HTML, markdown, bullets, emojis, "!", "..." or "??".
- Each ends with one short question, except a breakup email, which politely closes the loop with no pressure.
- warm_followup: friendlier, assumes some earlier contact. reengagement: they went quiet a while ago; fresh reason to talk.
  founder_outreach: first person, founder to founder, very direct. cold_outreach: low-key and helpful.
- If "feedback" lists problems, fix exactly those.
Answer ONLY with JSON: {"followups": [{"body": "Hi Ali,\\n\\n...\\n\\nBest,\\nBassam"}]}`;

/** Reads a send time from the user's words. */
export const SCHEDULE_PARSE_PROMPT = `Read the date and time at which the user wants their email campaign to be sent.
INPUT (JSON): the user's message, the current date and time in their timezone, and the timezone.
Rules:
- "now", "abhi", "right away", "foran" means send now.
- Relative times ("tomorrow 10am", "kal subah 9 baje", "next Monday", "in 2 hours") are relative to the given current time.
- A time without a date is today if still ahead, else tomorrow. A date without a time is 09:00.
- If you cannot tell a time, return status "unclear".
Answer ONLY with JSON: {"status": "now|scheduled|unclear", "local": "YYYY-MM-DD HH:mm"}`;
