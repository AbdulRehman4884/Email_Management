import { describe, expect, it } from "vitest";
import { messageLanguage, replyLanguage } from "../replyLanguage.js";

const lang = (m: string) => {
  const l = messageLanguage(m);
  return l.lang === "other" ? l.name : l.lang;
};

describe("messageLanguage", () => {
  it("English commands and questions are English (never another language)", () => {
    for (const m of [
      "Create campaign", "Show all campaigns", "Check SMTP configuration", "Show inbox replies", "Generate personalized emails",
      "Pause a campaign", "Find new leads", "How many campaigns do I have?", "show stats for campaign 12", "Show me page 2",
      "What is the open rate of my last campaign?", "create a campaign called Promoción Verano",
    ]) {
      expect(lang(m), m).toBe("en");
    }
  });

  it("no clear signal: names, numbers, yes/ok-like words", () => {
    for (const m of ["Summer Sale 2026", "2", "#45", "Acme Corp", "Bisma", "👍"]) expect(lang(m), m).toBe("unknown");
  });

  it("Spanish, French, German, Portuguese", () => {
    expect(lang("Quiero crear una campaña para mis clientes")).toBe("Spanish");
    expect(lang("¿Cuántas campañas tengo?")).toBe("Spanish");
    expect(lang("muéstrame mis campañas")).toBe("Spanish");
    expect(lang("Je veux créer une campagne pour mes clients")).toBe("French");
    expect(lang("Zeige mir alle meine Kampagnen")).toBe("German");
    expect(lang("Quero criar uma campanha")).toBe("Portuguese");
  });

  it("Roman Urdu and Urdu script", () => {
    expect(lang("mujhe nayi campaign bana do")).toMatch(/Roman Urdu/);
    expect(lang("meri campaigns dikhao")).toMatch(/Roman Urdu/);
    expect(lang("kitne replies aaye hain?")).toMatch(/Roman Urdu/);
    expect(lang("میری کیمپینز دکھاؤ")).toMatch(/Urdu or Arabic/);
  });
});

describe("replyLanguage", () => {
  it("a message without signal keeps the conversation's latest clear language; default English", () => {
    const r = replyLanguage("Summer Sale 2026", ["Show my campaigns", "Quiero crear una campaña nueva"]);
    expect(r.lang === "other" && r.name).toBe("Spanish");
    expect(r.lang === "other" && r.sample).toBe("Quiero crear una campaña nueva");
    expect(replyLanguage("Summer Sale 2026", []).lang).toBe("en");
    expect(replyLanguage("2", ["Create campaign"]).lang).toBe("en");
  });

  it("a clear message wins over the history", () => {
    expect(replyLanguage("Create campaign", ["Quiero crear una campaña nueva"]).lang).toBe("en");
    const r = replyLanguage("meri campaigns dikhao", ["Create campaign"]);
    expect(r.lang).toBe("other");
  });
});
