import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCompleteJson } = vi.hoisted(() => ({ mockCompleteJson: vi.fn() }));
vi.mock("../../services/openai.service.js", () => ({
  getOpenAIService: () => ({ completeJson: mockCompleteJson }),
  OpenAIServiceError: class OpenAIServiceError extends Error {},
}));

import { CANCEL_REPLY, NUMBER_REPLY, understandReply, type StepGuide } from "../replyUnderstanding.js";
import { REPLY_UNDERSTANDING_PROMPT } from "../../prompts/campaignCreation.prompt.js";

const guide: StepGuide = {
  flow: "automation",
  step: "template",
  question: "Start from a ready-made plan, or your own?",
  choices: [{ label: "Welcome + follow-ups" }, { label: "Book a call" }, { label: "My own plan" }],
  replies: [NUMBER_REPLY, CANCEL_REPLY],
};

describe("understandReply", () => {
  beforeEach(() => mockCompleteJson.mockReset());

  it("a clear reply (number, approve, back …) goes to the step as it is, without the LLM", async () => {
    for (const m of ["2", "#3", "2 but shorter", "approve", "back", "cancel", "show 4", "regenerate 2"]) {
      expect(await understandReply(guide, m)).toBeUndefined();
    }
    expect(mockCompleteJson).not.toHaveBeenCalled();
  });

  it("the user's own words become the step's reply; the LLM gets the step's guide", async () => {
    mockCompleteJson.mockResolvedValueOnce({ action: "reply", reply: "2" });
    expect(await understandReply(guide, "call book krni ha")).toEqual({ kind: "reply", text: "2" });
    const [system, user] = mockCompleteJson.mock.calls[0]! as [string, string];
    expect(system).toBe(REPLY_UNDERSTANDING_PROMPT);
    expect(JSON.parse(user)).toMatchObject({
      step: "template",
      choices: [{ number: 1, label: "Welcome + follow-ups" }, { number: 2, label: "Book a call" }, { number: 3, label: "My own plan" }],
      message: "call book krni ha",
    });
  });

  it("something the step cannot do / a question: a message for the user", async () => {
    mockCompleteJson.mockResolvedValueOnce({ action: "say", message: "Forms are made on the Forms page. Pick 3 (No form yet) for now?" });
    expect(await understandReply(guide, "naya form bnana ha")).toEqual({ kind: "say", message: "Forms are made on the Forms page. Pick 3 (No form yet) for now?" });
  });

  it("an option that does not exist, a broken answer or no LLM: the message stays as it is", async () => {
    mockCompleteJson.mockResolvedValueOnce({ action: "reply", reply: "7" });
    expect(await understandReply(guide, "saatwa wala")).toBeUndefined();
    mockCompleteJson.mockResolvedValueOnce({ something: "else" });
    expect(await understandReply(guide, "kuch bhi")).toBeUndefined();
    mockCompleteJson.mockRejectedValueOnce(new Error("timeout"));
    expect(await understandReply(guide, "pata nahi")).toBeUndefined();
  });
});

describe("stripMeaning / properCase", () => {
  it("keeps only the reply when the LLM copies the form's explanation", async () => {
    const { stripMeaning } = await import("../replyUnderstanding.js");
    const forms = ["approve — the emails are fine, go on (agreement or praise counts)", "<their answer, unchanged> — the purpose / offer in their own words"];
    expect(stripMeaning("approve — the emails are fine, go on", forms)).toBe("approve");
    expect(stripMeaning("we sell AI automation — the purpose / offer in their own words", forms)).toBe("we sell AI automation");
    expect(stripMeaning("we build dashboards — fast", forms)).toBe("we build dashboards — fast");
  });

  it("names and companies in capitals get normal capitals; acronyms stay", async () => {
    const { properCase } = await import("../campaignCreationTable.js");
    expect(properCase("MIA")).toBe("Mia");
    expect(properCase("GLOW BEAUTY CO")).toBe("Glow Beauty Co");
    expect(properCase("IBM", true)).toBe("IBM");
    expect(properCase("ABC Holdings")).toBe("ABC Holdings");
  });
});

describe("typoCommand", () => {
  it("a misspelt command of this step is read as that command, without the LLM", async () => {
    const { typoCommand } = await import("../replyUnderstanding.js");
    const forms = ["<their instructions, unchanged> — how the emails should be built", "default — use the standard style", "keep — keep the answer", "back — go to the previous step", "cancel — stop the whole flow"];
    expect(typoCommand("deflat", forms)).toBe("default");
    expect(typoCommand("defualt", forms)).toBe("default");
    expect(typoCommand("cancle", forms)).toBe("cancel");
    expect(typoCommand("kep", forms)).toBe("keep");
    expect(typoCommand("ok", forms)).toBeUndefined(); // under 3 letters: never guessed
    expect(typoCommand("shorter", forms)).toBeUndefined(); // not a command
    expect(typoCommand("aprove", forms)).toBeUndefined(); // approve is not a command of this step
  });
});
