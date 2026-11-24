/**
 * QA batch 15 Nov 2026 — editing a campaign from the chat, and write-only requests (lib/campaignEdits.ts).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../services/openai.service.js", () => ({ getOpenAIService: () => undefined }));

import { bodyForSave, editFieldIn, editValueFrom, isWriteOnlyRequest, scheduleTimeFrom } from "../campaignEdits.js";

describe("the new value, not the command words (QA bug 11)", () => {
  it.each([
    ["change the subject of campaign 466 to Hello C", "subject", "Hello C"],
    ["change the body of campaign 466 to: just a QA test, please ignore", "body", "just a QA test, please ignore"],
    ["update campaign 466 body: just a QA test, please ignore", "body", "just a QA test, please ignore"],
    ["update campaign 466 subject: Hello C", "subject", "Hello C"],
    ["466 ka subject badal ke 'Hello C updated' kar do", "subject", "Hello C updated"],
    ["466 ki body change kar do: 'This is the new QA body'", "body", "This is the new QA body"],
    ["466 ka subject Hello C kar do", "subject", "Hello C"],
    ["change subject to Welcome to our webinar", "subject", "Welcome to our webinar"],
    ["rename campaign 466 to Spring launch", "name", "Spring launch"],
  ])("%s", (msg, field, value) => {
    expect(editFieldIn(msg)).toBe(field);
    expect(editValueFrom(msg, field as never)).toBe(value);
  });

  it("no value given → undefined (the agent asks for it)", () => {
    expect(editValueFrom("change the subject of campaign 466", "subject")).toBeUndefined();
  });

  it("sender name / email are recognised as their own fields", () => {
    expect(editFieldIn("change the sender name of QA TEST AGENT DRAFT 2 to QA Bot")).toBe("fromName");
    expect(editFieldIn("update the sender email of QA TEST AGENT DRAFT 2")).toBe("fromEmail");
  });
});

describe("write / suggest only — nothing saved (QA bugs 13, 14)", () => {
  it.each([
    "Write a short friendly email inviting customers to our webinar next Friday",
    "can you write a quick email to announce our new product launch?",
    "Give me 5 subject line ideas for a Black Friday sale email",
    "meri campaign 466 ke liye 3 behtar subject lines likh do, thore friendly",
    "can you suggest a better subject line for campaign 466?",
    "rewrite the body of campaign 466 in a more friendly tone",
  ])("text only: %s", (msg) => {
    expect(isWriteOnlyRequest(msg)).toBe(true);
  });

  it.each([
    "change the subject of campaign 466 to Hello C",
    "create a campaign called Spring Sale",
    "465 ke har bande ko uske naam aur company ke hisaab se personalized email likh do",
    "generate personalized emails for campaign 465",
    "Show all campaigns",
  ])("not a write-only request: %s", (msg) => {
    expect(isWriteOnlyRequest(msg)).toBe(false);
  });
});

describe("saving a body and reading a time", () => {
  it("a typed body becomes paragraphs; {first_name} stays a placeholder", () => {
    expect(bodyForSave("Hi {first_name},\n\nThis is the new QA body.")).toBe("<p>Hi {first_name},</p><p>This is the new QA body.</p>");
  });

  it("a past time is refused; a future one is kept in the user's zone", async () => {
    const now = new Date("2026-11-16T07:00:00Z");
    expect(await scheduleTimeFrom("schedule it for 2026-11-15 10:00", "Asia/Karachi", now)).toEqual({ kind: "past", local: "2026-11-15 10:00" });
    expect(await scheduleTimeFrom("schedule it for 2026-12-31 10:00", "Asia/Karachi", now)).toEqual({
      kind: "time", local: "2026-12-31 10:00", iso: "2026-12-31T05:00:00.000Z",
    });
    expect(await scheduleTimeFrom("schedule it sometime", "Asia/Karachi", now)).toEqual({ kind: "unclear" });
  });
});
