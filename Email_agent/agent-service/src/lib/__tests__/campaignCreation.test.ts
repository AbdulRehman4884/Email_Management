import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDispatch, mockCompleteJson } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  mockCompleteJson: vi.fn(),
}));

vi.mock("../redisClient.js", () => ({ getRedisClient: async () => undefined }));
vi.mock("../../services/mcpClient.service.js", () => ({ mcpClientService: { dispatch: mockDispatch } }));
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () => ({ completeJson: mockCompleteJson }),
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { classifyLink, guessLayout, layoutFromLlm, recipientsFromTable, type CampaignRecipient } from "../campaignCreationTable.js";
import { DEFAULT_TEMPLATES } from "../campaignTemplates.js";
import { bodyToHtml } from "../emailRealism.js";
import { handleCampaignCreation, startsCampaignCreation, zonedToIso } from "../campaignCreationFlow.js";
import { startPersonalize } from "../personalizeEmailsFlow.js";
import { isBlockedPage, jobKey, loadJob, writeEmail, type CreationJob } from "../../services/campaignCreationJob.service.js";
import {
  COLUMN_READER_PROMPT,
  EMAIL_REWRITE_PROMPT,
  EMAIL_WRITER_PROMPT,
  FOLLOWUP_WRITER_PROMPT,
  SCHEDULE_PARSE_PROMPT,
  TEMPLATE_SUGGEST_PROMPT,
} from "../../prompts/campaignCreation.prompt.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

describe("reading the file row by row", () => {
  it("structured file: header row, every column kept, links classified", () => {
    const table = [
      ["Name", "Email", "Company", "Website", "Job"],
      ["Ali Khan", "ali@acme.pk", "Acme", "acme.pk", "https://www.upwork.com/jobs/~01abc"],
      ["Sara", "sara@beta.io", "Beta", "https://beta.io", ""],
    ];
    const layout = guessLayout(table);
    expect(layout.hasHeader).toBe(true);
    const { recipients, skipped } = recipientsFromTable(table, layout);
    expect(skipped).toEqual([]);
    expect(recipients[0]).toMatchObject({ row: 2, email: "ali@acme.pk", name: "Ali Khan", firstName: "Ali", company: "Acme" });
    expect(recipients[0]!.fields).toEqual({ Name: "Ali Khan", Email: "ali@acme.pk", Company: "Acme", Website: "acme.pk", Job: "https://www.upwork.com/jobs/~01abc" });
    // Job post first: its research is mandatory.
    expect(recipients[0]!.links).toEqual([
      { url: "https://www.upwork.com/jobs/~01abc", kind: "job_post" },
      { url: "https://acme.pk", kind: "website" },
    ]);
  });

  it("unstructured file: no header, the email in any column, links inside notes, bad rows skipped with the reason", () => {
    const table = [
      ["Acme Corp", "needs a react dev see https://www.fiverr.com/x/y and www.acme.com", "ceo: ali@acme.com"],
      ["Beta", "linkedin https://linkedin.com/in/sara", "sara@beta.io"],
      ["Gamma", "no contact here", ""],
      ["Acme again", "", "ALI@acme.com"],
    ];
    const layout = guessLayout(table);
    expect(layout.hasHeader).toBe(false);
    const { recipients, skipped } = recipientsFromTable(table, layout);
    expect(recipients.map((r) => r.email)).toEqual(["ali@acme.com", "sara@beta.io"]);
    expect(recipients[0]!.links).toEqual([
      { url: "https://www.fiverr.com/x/y", kind: "job_post" },
      { url: "https://www.acme.com", kind: "website" },
    ]);
    expect(recipients[1]!.links).toEqual([{ url: "https://linkedin.com/in/sara", kind: "linkedin" }]);
    expect(skipped).toEqual([
      { row: 3, reason: "no email address" },
      { row: 4, reason: "duplicate email ALI@acme.com" },
    ]);
  });

  it("the LLM's column reading is used, but a column full of addresses stays the email column", () => {
    const table = [["x", "y"], ["a@b.com", "Acme"], ["c@d.com", "Beta"]];
    const layout = layoutFromLlm({ hasHeader: true, columns: [{ index: 0, label: "Contact", kind: "notes" }, { index: 1, label: "Company", kind: "company" }] }, table);
    expect(layout.columns).toEqual([
      { index: 0, label: "Contact", kind: "email" },
      { index: 1, label: "Company", kind: "company" },
    ]);
  });

  it("link kinds", () => {
    expect(classifyLink("https://www.linkedin.com/jobs/view/123")).toBe("job_post");
    expect(classifyLink("https://linkedin.com/company/acme")).toBe("linkedin");
    expect(classifyLink("https://acme.com/careers/frontend-dev")).toBe("job_post");
    expect(classifyLink("https://acme.com/about")).toBe("website");
  });
});

describe("blocked pages are not research", () => {
  it("Upwork's Cloudflare CAPTCHA page (real Jina answer) counts as a failed link; a normal page does not", () => {
    const upwork = ["Cloudflare Ray ID: **a58bcb159e0d2419**", "", "Your IP: 34.34.225.251", "", "© 2015 - 2026 Upwork® Global Inc."].join("\n");
    expect(isBlockedPage("Just a moment...", upwork)).toBe(true);
    expect(isBlockedPage("", upwork)).toBe(true);
    expect(isBlockedPage("Acme — React development", "We build dashboards for logistics companies. ".repeat(10))).toBe(false);
  });
});

describe("templates and times", () => {
  it("templates are writing structures only: no HTML, no design", () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.structure.length).toBeGreaterThan(20);
      expect(t.structure).not.toMatch(/<[a-z]|style=|\{\{/i);
    }
  });

  it("a local time in the user's timezone becomes an ISO time", () => {
    expect(zonedToIso("2026-11-12 10:00", "Asia/Karachi")).toBe("2026-11-12T05:00:00.000Z");
    expect(zonedToIso("2026-11-12 10:00", "UTC")).toBe("2026-11-12T10:00:00.000Z");
    expect(zonedToIso("tomorrow", "UTC")).toBeUndefined();
  });
});

// ── The whole flow, steps 1–8 ───────────────────────────────────────────────

function state(over: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userId: "u1",
    sessionId: "s1",
    rawToken: "t",
    userMessage: "",
    intent: "create_campaign",
    llmExtractedArgs: undefined,
    senderDefaults: { fromName: "Bassam", fromEmail: "bassam@dev.io" },
    clientTimezone: "Asia/Karachi",
    ...over,
  } as unknown as AgentGraphStateType;
}

const message = (patch: Partial<AgentGraphStateType>) => JSON.parse(String(patch.formattedResponse)).message as string;

/** Writer answers that pass every realism check (different per recipient). */
const DRAFTS: Record<string, { subject: string; body: string; personalization_fact: string }> = {
  Ali: {
    subject: "your dashboard rebuild",
    personalization_fact: "need a React developer to rebuild our dashboard",
    body: [
      "Hi Ali,",
      "",
      "You need someone to rebuild your dashboard in React. Rebuilds like that usually stall when the old screens still have to work.",
      "",
      "I've moved three admin dashboards from jQuery to React without downtime. The trick is shipping one screen at a time behind a flag, so users never notice the switch.",
      "",
      "Worth a quick chat next week?",
      "",
      "Best,",
      "Bassam",
    ].join("\n"),
  },
  Sara: {
    subject: "react rebuild plan",
    personalization_fact: "need a React developer to rebuild our dashboard",
    body: [
      "Hi Sara,",
      "",
      "Your dashboard rebuild in React sounds like a big job for a small team. Most of the risk sits in moving the reports without breaking them.",
      "",
      "Last spring I rebuilt a booking dashboard in React for a clinic group. We moved it page by page and kept the old version live until the end.",
      "",
      "Would a short call this week help?",
      "",
      "Best,",
      "Bassam",
    ].join("\n"),
  },
};

describe("chat campaign creation flow", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockCompleteJson.mockReset();
  });

  it("'create campaign' starts the new flow; a message with subject and body keeps the old direct path", () => {
    expect(startsCampaignCreation(state({ userMessage: "create campaign" }))).toBe(true);
    expect(startsCampaignCreation(state({ userMessage: "create campaign called X, subject Hi, body Hello" }))).toBe(false);
  });

  it("name → file → purpose → one researched email per recipient → template → schedule → approval", async () => {
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "read_table_file") {
        return { data: { success: true, data: { totalRows: 3, table: [
          ["Name", "Email", "Job link"],
          ["Ali", "ali@acme.pk", "https://www.upwork.com/jobs/~01"],
          ["Sara", "sara@beta.io", "beta.io"],
        ] } } };
      }
      if (tool === "fetch_website_content") {
        return { data: { success: true, data: { content: `Page of ${String(args.url)}: we need a React developer to rebuild our dashboard, budget $2k. `.repeat(3) } } };
      }
      if (tool === "create_campaign") return { data: { success: true, data: { id: 77 } } };
      if (tool === "save_csv_recipients") return { data: { success: true, data: { added: 2, rejected: 0 } } };
      throw new Error(`unexpected tool ${tool}`);
    });
    mockCompleteJson.mockImplementation(async (system: string, user: string) => {
      if (system === COLUMN_READER_PROMPT) return { hasHeader: true, columns: [{ index: 0, label: "Name", kind: "name" }, { index: 1, label: "Email", kind: "email" }, { index: 2, label: "Job link", kind: "job_link" }] };
      if (system === EMAIL_WRITER_PROMPT) {
        const input = JSON.parse(user) as { recipient: { first_name: string } };
        return { status: "ok", ...DRAFTS[input.recipient.first_name]! };
      }
      if (system === EMAIL_REWRITE_PROMPT) {
        // Applying the template keeps the (already valid) email.
        const input = JSON.parse(user) as { subject: string; body: string; personalization_fact: string };
        return { status: "ok", subject: input.subject, body: input.body, personalization_fact: input.personalization_fact };
      }
      if (system === TEMPLATE_SUGGEST_PROMPT) {
        return { suggestions: [{ name: "Proposal", reason: "fits job replies", structure: "Paragraph 1: their project. Paragraph 2: one similar project of mine. Last line: ask for a short call." }] };
      }
      if (system === SCHEDULE_PARSE_PROMPT) return { status: "now" };
      return {};
    });

    let s = state({ userMessage: "create campaign" });
    let p = await handleCampaignCreation(s);
    expect(message(p)).toMatch(/What should the campaign be called/);

    s = state({ userMessage: "Upwork outreach", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("file");

    s = state({ userMessage: "", campaignCreation: p.campaignCreation, pendingCsvFile: { filename: "leads.csv", fileContent: "eA==" } });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("purpose");
    expect(message(p)).toMatch(/\*\*2\*\* recipients/);
    expect(message(p)).toMatch(/1 websites, 1 job posts/);
    expect(p).toHaveProperty("pendingCsvFile", undefined);

    s = state({ userMessage: "I'm a React developer offering to build their dashboard", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("generating");

    // Wait for the background run.
    const key = jobKey("u1", "s1");
    for (let i = 0; i < 50 && (await loadJob(key))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    const job = await loadJob(key);
    expect(Object.values(job!.results).map((e) => [e.subject, e.error, e.issues])).toEqual([
      ["your dashboard rebuild", undefined, undefined],
      ["react rebuild plan", undefined, undefined],
    ]);
    // Every link was fetched: the job post alone, the website with its subpages.
    expect(mockDispatch).toHaveBeenCalledWith("fetch_website_content", { url: "https://www.upwork.com/jobs/~01", includeSubpages: false }, expect.anything());
    expect(mockDispatch).toHaveBeenCalledWith("fetch_website_content", { url: "https://beta.io", includeSubpages: true }, expect.anything());

    s = state({ userMessage: "status", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("review");
    expect(message(p)).toMatch(/\*\*2\*\* emails written/);
    expect(message(p)).toMatch(/\*\*Subject:\*\* your dashboard rebuild/);
    // The preview is the plain email exactly as it is sent.
    expect(message(p)).toContain("> Hi Ali,\n> \n> You need someone to rebuild your dashboard in React.");

    s = state({ userMessage: "show 2", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(message(p)).toMatch(/#2 Sara — sara@beta.io/);

    s = state({ userMessage: "approve", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("template_category");
    expect(message(p)).toMatch(/1\. Job \/ Proposal ← my guess/);

    s = state({ userMessage: "1", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("template_pick");
    expect(message(p)).toMatch(/1\. \*\*Proposal\*\* — fits job replies \*\(suggested/);
    expect(message(p)).toMatch(/2\. \*\*Promotional\*\*/);

    s = state({ userMessage: "1", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    // As before: picking a template shows the preview in the same reply (the emails are rewritten to it meanwhile).
    expect(p.campaignCreation).toMatchObject({ step: "template_review", template: { name: "Proposal" } });
    expect(message(p)).toMatch(/plain text, no design/);
    expect(message(p)).toContain("> Hi Ali,");

    s = state({ userMessage: "approve", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p.campaignCreation?.step).toBe("schedule");
    expect(p.activeCampaignId).toBe("77");
    expect(mockDispatch).toHaveBeenCalledWith(
      "create_campaign",
      { name: "Upwork outreach", subject: "{{ai_subject}}", body: "{{ai_body}}", bodyFormat: "html" },
      expect.anything(),
    );
    const saveCall = mockDispatch.mock.calls.find((c) => c[0] === "save_csv_recipients")!;
    expect(saveCall[1]).toEqual({
      campaignId: "77",
      rows: [
        { email: "ali@acme.pk", name: "Ali", ai_subject: "your dashboard rebuild", ai_body: bodyToHtml(DRAFTS.Ali!.body) },
        { email: "sara@beta.io", name: "Sara", ai_subject: "react rebuild plan", ai_body: bodyToHtml(DRAFTS.Sara!.body) },
      ],
    });

    s = state({ userMessage: "now", campaignCreation: p.campaignCreation });
    p = await handleCampaignCreation(s);
    expect(p).toMatchObject({ toolName: "start_campaign", toolArgs: { campaignId: "77" }, intent: "start_campaign", campaignCreation: undefined });
    expect(p.crmAction?.requiresApproval).toBe(true);
    expect(p.crmAction?.confirmText).toMatch(/Recipients: \*\*2\*\* saved/);
    expect(p.crmAction?.confirmText).toMatch(/Template: \*\*Proposal\*\*/);
  });

  it("a draft that fails the checks is written again with the failed checks as feedback", async () => {
    mockDispatch.mockResolvedValue({ data: { success: true, data: { content: "We need a React developer to rebuild our dashboard before the busy season starts. ".repeat(2) } } });
    const bad = { status: "ok", ...DRAFTS.Ali!, body: DRAFTS.Ali!.body.replace("next week?", "next week!!") };
    mockCompleteJson.mockResolvedValueOnce(bad).mockResolvedValueOnce({ status: "ok", ...DRAFTS.Ali! });
    const recipient: CampaignRecipient = { row: 2, email: "ali@acme.pk", name: "Ali", firstName: "Ali", fields: { Name: "Ali" }, links: [{ url: "https://acme.pk", kind: "website" }] };
    const job: CreationJob = { status: "running", kind: "generate", recipients: [recipient], results: {}, doneInRun: [], updatedAt: "", brief: { name: "X", purpose: "React developer", senderName: "Bassam Ilyas", language: "English" } };

    const email = await writeEmail(recipient, job, { userId: "u1", rawToken: "t" } as never);
    expect(email.error).toBeUndefined();
    expect(email.body).toBe(DRAFTS.Ali!.body);
    expect(email.bodyHtml).toBe(bodyToHtml(DRAFTS.Ali!.body));
    const second = JSON.parse(mockCompleteJson.mock.calls[1]![1] as string) as { feedback: string };
    expect(second.feedback).toMatch(/^Your previous draft failed these checks: .*V10/);
  });

  it("no usable fact: the writer skips, the recipient needs review and is not saved", async () => {
    mockDispatch.mockResolvedValue({ data: { success: true, data: { content: "" } } });
    mockCompleteJson.mockResolvedValueOnce({ status: "skip", reason: "the row only has an email address" });
    const recipient: CampaignRecipient = { row: 3, email: "x@y.com", fields: { Email: "x@y.com" }, links: [] };
    const job: CreationJob = { status: "running", kind: "generate", recipients: [recipient], results: {}, doneInRun: [], updatedAt: "", brief: { name: "X", purpose: "React developer", senderName: "Bassam", language: "English" } };

    const email = await writeEmail(recipient, job, { userId: "u1", rawToken: "t" } as never);
    expect(email).toMatchObject({ error: "no usable fact (the row only has an email address)", body: "" });
    expect(mockCompleteJson).toHaveBeenCalledTimes(1);
  });

  it("cancel stops the flow and says what exists", async () => {
    const p = await handleCampaignCreation(state({ userMessage: "cancel", campaignCreation: { step: "file", name: "X", atIso: new Date().toISOString() } }));
    expect(p.campaignCreation).toBeUndefined();
    expect(JSON.parse(String(p.formattedResponse)).message).toMatch(/Nothing was created/);
  });
});

describe("generate personalized emails (existing campaign)", () => {
  beforeEach(() => {
    mockDispatch.mockReset();
    mockCompleteJson.mockReset();
  });

  const FOLLOW_UPS = [
    "Hi NAME,\n\nQuick thought on the dashboard: moving the reports first usually removes most of the risk. Want me to sketch the order I would use?\n\nBest,\nBassam",
    "Hi NAME,\n\nI'll leave this here so I don't crowd your inbox. If the React rebuild comes back on the list later, I'm happy to help with it.\n\nBest,\nBassam",
  ];

  it("asks the campaign (any status) and every choice, rewrites the existing emails + follow-ups, saves them to a new draft copy", async () => {
    const rewritten: string[][] = [];
    mockDispatch.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "get_all_campaigns") {
        return { data: { success: true, data: [{ id: "12", name: "Old draft", status: "draft" }, { id: "31", name: "Q4 outreach", status: "running" }] } };
      }
      if (tool === "get_campaign_recipients") {
        expect(args.campaignId).toBe("31");
        return { data: { success: true, data: {
          campaign: { id: "31", name: "Q4 outreach", status: "running", subject: "Dashboard help", body: "<p>Hi {{name}}, I'm a React developer and I rebuild old admin dashboards for small teams without downtime.</p>", smtpSettingsId: 5 },
          recipients: [
            { id: 1, email: "ali@acme.pk", name: "Ali", status: "sent", repliedAt: null, customFields: {
              job: "We need a React developer to rebuild our dashboard", website: "acme.pk",
              ai_subject: "old subject", ai_body: "<p>Hi Ali,</p><p>Old email about your React dashboard.</p><p>Best,<br>Bassam</p>",
            } },
            { id: 2, email: "sara@beta.io", name: "Sara", status: "pending", repliedAt: null, customFields: { job: "We need a React developer to rebuild our dashboard" } },
            { id: 3, email: "old@x.io", name: "Old", status: "sent", repliedAt: "2026-11-01T00:00:00Z", customFields: {} },
          ],
          total: 3,
        } } };
      }
      if (tool === "fetch_website_content") {
        return { data: { success: true, data: { content: `Page of ${String(args.url)}: we need a React developer to rebuild our dashboard, budget $2k. `.repeat(3) } } };
      }
      if (tool === "create_campaign") return { data: { success: true, data: { id: 88 } } };
      if (tool === "save_csv_recipients") return { data: { success: true, data: { added: 2, rejected: 0 } } };
      if (tool === "save_follow_up_templates") return { data: { success: true, data: { saved: 2 } } };
      throw new Error(`unexpected tool ${tool}`);
    });
    mockCompleteJson.mockImplementation(async (system: string, user: string) => {
      if (system === COLUMN_READER_PROMPT) {
        return { hasHeader: true, columns: [{ index: 0, label: "Email address", kind: "email" }, { index: 1, label: "Name", kind: "name" }, { index: 2, label: "Job", kind: "notes" }, { index: 3, label: "Site", kind: "website" }] };
      }
      if (system === EMAIL_REWRITE_PROMPT) {
        // Every recipient's existing email is rewritten to the settings (no new email is written).
        const input = JSON.parse(user) as { recipient: { first_name: string }; change_request: string; subject: string; body: string };
        expect(input.change_request).toMatch(/Tone: a founder/);
        rewritten.push([input.recipient.first_name, input.subject, input.body]);
        return { status: "ok", ...DRAFTS[input.recipient.first_name]! };
      }
      if (system === FOLLOWUP_WRITER_PROMPT) {
        const input = JSON.parse(user) as { recipient: { first_name: string }; sequence: { count: number; breakup: boolean } };
        expect(input.sequence).toMatchObject({ count: 2, breakup: true, type: "cold_outreach" });
        return { followups: FOLLOW_UPS.map((b) => ({ body: b.replace("NAME", input.recipient.first_name) })) };
      }
      if (system === SCHEDULE_PARSE_PROMPT) return { status: "now" };
      return {};
    });

    let p = await startPersonalize(state({ userMessage: "Generate personalized emails", intent: "generate_personalized_emails" }));
    expect(p.campaignCreation).toMatchObject({ step: "pick_campaign", kind: "personalize" });
    expect(message(p)).toMatch(/2\. \*\*Q4 outreach\*\* — running/);

    const answer = async (text: string) => {
      p = await handleCampaignCreation(state({ userMessage: text, campaignCreation: p.campaignCreation }));
    };
    await answer("2");
    expect(p.campaignCreation?.step).toBe("p_mode");
    expect(message(p)).toMatch(/\*\*2\*\* recipients to write to/);
    expect(message(p)).toMatch(/1 left out \(already replied/);
    expect(message(p)).toMatch(/not changed/);

    await answer("skip");
    expect(p.campaignCreation?.step).toBe("p_tone");
    await answer("founder style");
    expect(p.campaignCreation?.step).toBe("p_cta");
    await answer("2");
    expect(p.campaignCreation?.step).toBe("p_sequence");
    await answer("1");
    expect(p.campaignCreation?.step).toBe("p_length");
    await answer("3");
    expect(p.campaignCreation?.step).toBe("p_breakup");
    await answer("yes");
    expect(p.campaignCreation?.step).toBe("p_short");
    await answer("no");
    // No more questions: right after the last choice the existing emails are rewritten.
    expect(p.campaignCreation?.step).toBe("generating");
    expect(message(p)).toMatch(/Rewriting the existing email of \*\*2\*\* recipients/);
    expect(p.campaignCreation?.personalize).toEqual({
      mode: "low_promotional_plaintext", tone: "founder_style", cta: "soft_meeting_cta", sequenceType: "cold_outreach", length: 3, breakup: true, short: false,
    });

    const key = jobKey("u1", "s1");
    for (let i = 0; i < 50 && (await loadJob(key))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
    // Ali's own earlier email; Sara had none, so the campaign's email with her row filled in.
    expect(rewritten.sort()).toEqual([
      ["Ali", "old subject", "Hi Ali,\n\nOld email about your React dashboard.\n\nBest,\nBassam"],
      ["Sara", "Dashboard help", "Hi Sara, I'm a React developer and I rebuild old admin dashboards for small teams without downtime."],
    ]);

    await answer("status");
    expect(p.campaignCreation?.step).toBe("review");
    expect(message(p)).toContain("**Follow-up 2:**");
    expect(message(p)).toMatch(/approve\*\* — save these emails to a new draft campaign/);

    await answer("approve");
    expect(p.campaignCreation?.step).toBe("schedule");
    expect(mockDispatch).toHaveBeenCalledWith(
      "create_campaign",
      { name: "Q4 outreach (personalized)", subject: "{{ai_subject}}", body: "{{ai_body}}", bodyFormat: "html", smtpSettingsId: 5 },
      expect.anything(),
    );
    const rows = (mockDispatch.mock.calls.find((c) => c[0] === "save_csv_recipients")![1] as { rows: Array<Record<string, string>> }).rows;
    expect(rows[0]).toEqual({
      email: "ali@acme.pk",
      name: "Ali",
      job: "We need a React developer to rebuild our dashboard",
      website: "acme.pk",
      ai_subject: "your dashboard rebuild",
      ai_body: bodyToHtml(DRAFTS.Ali!.body),
      ai_followup_1: FOLLOW_UPS[0]!.replace("NAME", "Ali"),
      ai_followup_2: FOLLOW_UPS[1]!.replace("NAME", "Ali"),
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "save_follow_up_templates",
      { campaignId: "88", templates: [
        { id: "ai-followup-1", title: "AI follow-up 1", subject: "Re: {{ai_subject}}", body: "{{ai_followup_1}}" },
        { id: "ai-followup-2", title: "AI follow-up 2 (breakup)", subject: "Re: {{ai_subject}}", body: "{{ai_followup_2}}" },
      ] },
      expect.anything(),
    );
    // The chosen campaign is only read, never changed.
    expect(mockDispatch.mock.calls.some((c) => (c[1] as { campaignId?: string }).campaignId === "31" && c[0] !== "get_campaign_recipients")).toBe(false);

    await answer("now");
    expect(p).toMatchObject({ toolName: "start_campaign", toolArgs: { campaignId: "88" } });
    expect(p.crmAction?.confirmText).toMatch(/Settings: mode \*\*Plain text, low-promotional\*\*, tone \*\*Founder style\*\*/);
    expect(p.crmAction?.confirmText).toMatch(/Q4 outreach\*\* is still running/);
  });
});
