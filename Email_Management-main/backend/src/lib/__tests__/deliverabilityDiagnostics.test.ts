import { describe, expect, it } from "vitest";
import {
  buildDeliverabilityDiagnostics,
  predictGmailTab,
} from "../deliverabilityDiagnostics.js";

describe("deliverabilityDiagnostics", () => {
  it("predicts promotions_likely for marketing-heavy copy", () => {
    const tab = predictGmailTab(
      {
        subject: "Latest marketing campaign",
        html: "<p>Hi there, our latest campaign includes an exclusive offer.</p><a href=\"https://example.com\">Learn more</a>",
      },
      {
        promotionalKeywordScore: 6,
        linkCount: 1,
        imageCount: 0,
        htmlTextRatio: 1.9,
        unsubscribeHeaderPresence: true,
        genericGreeting: true,
        marketingToneScore: 3,
        senderReputationKnown: false,
      },
    );

    expect(tab).toBe("promotions_likely");
  });

  it("predicts primary_possible for short human-style email", () => {
    const tab = predictGmailTab(
      {
        subject: "Quick question, Sam",
        text: "Hi Sam,\n\nI noticed your team is still doing some manual follow-up. Would it help if I shared one idea?\n\nBest,\nTaylor",
      },
      {
        promotionalKeywordScore: 0,
        linkCount: 0,
        imageCount: 0,
        htmlTextRatio: 1.1,
        unsubscribeHeaderPresence: false,
        genericGreeting: false,
        marketingToneScore: 0,
      },
    );

    expect(tab).toBe("primary_possible");
  });

  it("does not expose SMTP password in diagnostics", () => {
    const diagnostics = buildDeliverabilityDiagnostics({
      subject: "Quick question",
      html: "<p>Hi Sam, would it help if I shared one idea?</p>",
      smtpProvider: "gmail",
      senderEmail: "sender@example.com",
      recipientEmail: "sam@example.net",
      trackingDomain: null,
      unsubscribeHeaderPresence: true,
    });

    expect("password" in diagnostics).toBe(false);
    expect(JSON.stringify(diagnostics).toLowerCase()).not.toContain("smtp_pass");
  });
});
