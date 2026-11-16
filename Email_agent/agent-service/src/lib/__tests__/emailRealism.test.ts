import { describe, expect, it } from "vitest";
import { bodyToHtml, normalizeBody, validateEmail, type DraftEmail, type ValidationContext } from "../emailRealism.js";

const GOOD_BODY = [
  "Hi Ali,",
  "",
  "Your team is moving the Systems Limited reporting dashboard from PHP to React this quarter. That's a big switch while the old reports still have to run.",
  "",
  "I rebuild reporting dashboards in React for logistics teams. For one client I cut the weekly report time from 2 days to 2 hours.",
  "",
  "Worth a quick 15-minute chat next week?",
  "",
  "Best,",
  "Bassam",
].join("\n");

const good: DraftEmail = {
  subject: "your dashboard rebuild",
  body: GOOD_BODY,
  fact: "moving the reporting dashboard from PHP to React this quarter",
};

const ctx: ValidationContext = {
  recipientFirstName: "Ali",
  recipientCompany: "Systems Limited",
  senderFirstName: "Bassam",
  research: "Job post: We are moving the reporting dashboard from PHP to React this quarter and need help with the rebuild.",
  aboutText: "Systems Limited is a leading IT services company delivering digital transformation for global enterprises.",
  senderFacts: "React developer. I cut a logistics client's report time from 2 days to 2 hours; 40% fewer support tickets.",
  others: [],
};

const errorsOf = (patch: Partial<DraftEmail>, c: Partial<ValidationContext> = {}) => validateEmail({ ...good, ...patch }, { ...ctx, ...c });
const codes = (errors: string[]) => [...new Set(errors.map((e) => e.split(":")[0]))];
const withBody = (lines: string[]) => lines.join("\n");

describe("normalizeBody", () => {
  it("puts the greeting on its own line, joins hard-wrapped paragraphs and closes the signature", () => {
    const messy =
      "Hi Ali,\nYour team is moving the dashboard\nto React this quarter.  \n\n\n\nI rebuild dashboards​ for teams.\n\nWorth a chat?\nBest,\n\nBassam  ";
    expect(normalizeBody(messy)).toBe(
      "Hi Ali,\n\nYour team is moving the dashboard to React this quarter.\n\nI rebuild dashboards for teams.\n\nWorth a chat?\n\nBest,\nBassam",
    );
  });

  it("straightens curly quotes and keeps a two-line signature", () => {
    expect(normalizeBody("Hi Ali,\n\nIt’s “done”.\n\nThanks,\nBassam\nDeveloper at Bitsol")).toBe(
      "Hi Ali,\n\nIt's \"done\".\n\nThanks,\nBassam\nDeveloper at Bitsol",
    );
  });

  it("the HTML part is plain <p> and <br> only, braces cannot become placeholders", () => {
    expect(bodyToHtml("Hi Ali,\n\nA {x} & <b>.\n\nBest,\nBassam")).toBe("<p>Hi Ali,</p><p>A &#123;x&#125; &amp; &lt;b&gt;.</p><p>Best,<br>Bassam</p>");
  });
});

describe("validateEmail — a realistic email passes", () => {
  it("passes every check", () => {
    expect(validateEmail(good, ctx)).toEqual([]);
  });
});

describe("validateEmail — each check fails on a bad example", () => {
  it("V1 structure: no greeting / one paragraph / no signature name", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Hi Ali,\n\n", "") }))).toContain("V1");
    expect(codes(errorsOf({ body: withBody(["Hi Ali,", "", "One paragraph only about the dashboard move to React this quarter?", "", "Best,", "Bassam"]) }))).toContain("V1");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Best,\nBassam", "Best,") }))).toContain("V1");
  });

  it("V2 length: too short, too many sentences in a paragraph, long sentences", () => {
    expect(codes(errorsOf({ body: withBody(["Hi Ali,", "", "Your team is moving the reporting dashboard from PHP to React.", "", "Worth a chat?", "", "Best,", "Bassam"]) }))).toContain("V2");
    const four = "One thing here. Two things here. Three things here. Four things here.";
    expect(errorsOf({ body: GOOD_BODY.replace("That's a big switch while the old reports still have to run.", four) }).some((e) => e.includes("sentences; use at most"))).toBe(true);
  });

  it("V3 no HTML or markdown", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("I rebuild", "<div style=\"color:red\">I rebuild</div>") }))).toContain("V3");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("I rebuild", "**I rebuild**") }))).toContain("V3");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("I rebuild", "- I rebuild") }))).toContain("V3");
  });

  it("V4 spam words, whole words only", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Worth a quick", "Free and worth a quick") }))).toContain("V4");
    expect(codes(errorsOf({ subject: "a great deal" }))).toContain("V4");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("dashboards", "ideals") }))).not.toContain("V4");
  });

  it("V5 clichés and more than one em dash", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("I rebuild", "I leverage cutting-edge tools and rebuild") }))).toContain("V5");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("That's a big switch", "That's big — really — a switch") }))).toContain("V5");
  });

  it("V6 personalization: fact not in the research, not in the opening, opening copies the About text", () => {
    expect(codes(errorsOf({ fact: "won an award for logistics innovation in 2024" }))).toContain("V6");
    expect(codes(errorsOf({ fact: "" }))).toContain("V6");
    const aboutOpening = GOOD_BODY.replace(
      "Your team is moving the Systems Limited reporting dashboard from PHP to React this quarter. That's a big switch while the old reports still have to run.",
      "Systems Limited is a leading IT services company delivering digital transformation for global enterprises.",
    );
    expect(codes(errorsOf({ body: aboutOpening }))).toContain("V6");
  });

  it("V7 never says where the recipient was found", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Your team is moving", "I saw on Upwork your team is moving") }))).toContain("V7");
  });

  it("V8 placeholders and empty values", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Hi Ali,", "Hi {{first_name}},") }))).toContain("V8");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("for logistics teams", "for undefined teams") }))).toContain("V8");
  });

  it("V9 greeting name and company spelling", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Hi Ali,", "Hi Alee,") }))).toContain("V9");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Systems Limited", "systems limited") }))).toContain("V9");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Hi Ali,", "Hi there,") }, { recipientFirstName: undefined }))).not.toContain("V9");
  });

  it("V10 all caps, exclamation marks, ?? and ...", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("big switch", "HUGE switch") }))).toContain("V10");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("still have to run.", "still have to run!") }))).toContain("V10");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("still have to run.", "still have to run...") }))).toContain("V10");
    expect(codes(errorsOf({}))).not.toContain("V10"); // PHP is an allowed acronym
  });

  it("V11 no links", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("for logistics teams", "for logistics teams (bitsol.com/work)") }))).toContain("V11");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("for logistics teams", "for logistics teams, see bit.ly x") }))).toContain("V11");
  });

  it("V12 subject: length, case, punctuation, fake Re:", () => {
    expect(codes(errorsOf({ subject: "dashboard" }))).toContain("V12");
    expect(codes(errorsOf({ subject: "Your Dashboard Rebuild" }))).toContain("V12");
    expect(codes(errorsOf({ subject: "re: dashboard rebuild" }))).toContain("V12");
    expect(codes(errorsOf({ subject: "dashboard rebuild, quick" }))).toContain("V12");
    expect(codes(errorsOf({ subject: "Ali, quick question?" }))).toContain("V12"); // the comma
    expect(codes(errorsOf({ subject: "quick question for Ali?" }))).not.toContain("V12");
  });

  it("V13 exactly one question, in the last paragraph", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("still have to run.", "still have to run, right?") }))).toContain("V13");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Worth a quick 15-minute chat next week?", "Happy to share how it went.") }))).toContain("V13");
  });

  it("V14 signed by a person, not only the company", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("Best,\nBassam", "Best,\nBitsol Team") }))).toContain("V14");
  });

  it("V15 not the same opening or a near copy of another recipient's email", () => {
    expect(codes(errorsOf({}, { others: [{ body: GOOD_BODY.replace("Hi Ali,", "Hi Sara,") }] }))).toContain("V15");
    const different = withBody(["Hi Sara,", "", "Your clinic opened a second branch in Lahore last month.", "", "Worth a call?", "", "Best,", "Bassam"]);
    expect(codes(errorsOf({}, { others: [{ body: different }] }))).not.toContain("V15");
  });

  it("V16 emojis, invisible characters, double spaces", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("next week?", "next week? \u{1F642}") }))).toContain("V16");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("big switch", "big switch") }))).toContain("V16");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("big switch", "big  switch") }))).toContain("V16");
  });

  it("V17 numbers must come from the research or the sender: no invented results", () => {
    expect(codes(errorsOf({ body: GOOD_BODY.replace("from 2 days to 2 hours", "by 70%") }))).toContain("V17");
    expect(codes(errorsOf({ body: GOOD_BODY.replace("from 2 days to 2 hours", "and saw 40% fewer tickets") }))).not.toContain("V17");
  });
});

describe("the old template email (Hello Ali / Systems Limited / Upwork / signed Vertech) fails", () => {
  it("fails V6, V7, V14 and the cliché check", () => {
    const bad: DraftEmail = {
      subject: "Enhance Your Projects with Vertech!",
      body: withBody([
        "Hello Ali,",
        "",
        "I came across your profile on Upwork and I see that you're looking for a developer. Systems Limited is a leading IT services company delivering digital transformation for global enterprises.",
        "",
        "At Vertech we offer tailored solutions to enhance your projects and leverage cutting-edge technology. We have helped 100+ clients.",
        "",
        "Contact us today!",
        "",
        "Best regards,",
        "Vertech",
      ]),
      fact: "",
    };
    const found = codes(validateEmail(bad, ctx));
    for (const code of ["V6", "V7", "V14", "V5"]) expect(found).toContain(code);
  });
});
