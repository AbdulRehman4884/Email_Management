import { describe, expect, it } from "vitest";
import {
  analyzeOutreachQuality,
  buildFallbackOutreachEmail,
  htmlToPlainText,
} from "../outreachQuality.js";

describe("outreachQuality", () => {
  it("detects promotional keyword density", () => {
    const result = analyzeOutreachQuality({
      subject: "Latest campaign initiative",
      bodyText:
        "Hi there,\n\nWe are excited to share our latest AI-powered marketing campaign and innovative solution for your team.",
    });

    expect(result.promotionalKeywordScore).toBeGreaterThanOrEqual(6);
    expect(result.promotionalKeywords).toContain("campaign");
    expect(result.issues).toContain("Promotional wording detected");
  });

  it("detects a generic greeting", () => {
    const result = analyzeOutreachQuality({
      subject: "Quick question",
      bodyText: "Hi there,\n\nWould it help if I shared one idea?\n\nBest,\nAlex",
    });

    expect(result.genericGreeting).toBe(true);
    expect(result.issues).toContain("Generic greeting");
  });

  it("provides a low-promotional plaintext fallback rewrite", () => {
    const email = buildFallbackOutreachEmail({
      recipientName: "Morgan Lee",
      company: "Acme",
      industry: "logistics",
      senderName: "Taylor",
      mode: "low_promotional_plaintext",
    });

    expect(email.subject).toContain("Quick question");
    expect(email.text).toContain("Hi Morgan");
    expect(email.text.toLowerCase()).not.toContain("campaign");
    expect(email.text.toLowerCase()).not.toContain("marketing team");
    expect(htmlToPlainText(email.html)).toContain("Would it be worth sharing");
  });
});
