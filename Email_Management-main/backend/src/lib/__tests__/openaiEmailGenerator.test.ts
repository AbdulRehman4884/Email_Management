import { describe, expect, it } from "vitest";
import { generatePersonalizedEmailBody } from "../openaiEmailGenerator.js";

describe("openaiEmailGenerator fallback", () => {
  it("uses low-promotional plaintext fallback when OPENAI_API_KEY is absent", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await generatePersonalizedEmailBody(
        {
          name: "Sam Carter",
          email: "sam@example.com",
          customFields: { company: "Acme", industry: "logistics" },
        },
        {
          name: "Outbound Test",
          subject: "Test Subject",
          senderName: "Taylor",
        },
      );

      expect(result).not.toBeNull();
      expect(result?.modeUsed).toBe("low_promotional_plaintext");
      expect(result?.subject).toContain("Quick question");
      expect(result?.text.toLowerCase()).not.toContain("campaign");
      expect(result?.text.toLowerCase()).not.toContain("marketing team");
    } finally {
      if (previous) process.env.OPENAI_API_KEY = previous;
    }
  });

  it("keeps sequence fallback short and with one CTA", async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const result = await generatePersonalizedEmailBody(
        {
          name: "Sam Carter",
          email: "sam@example.com",
          customFields: { company: "Acme", industry: "logistics" },
        },
        {
          name: "Outbound Test",
          subject: "Test Subject",
          senderName: "Taylor",
          toneUsed: "technical_advisor",
          ctaType: "value_cta",
          ctaText: "I can send over a few practical examples if useful.",
          sequenceType: "cold_outreach",
          touchNumber: 2,
          touchObjective: "gentle follow-up",
          shortenEmails: true,
        },
      );

      expect(result).not.toBeNull();
      expect(result?.ctaType).toBe("value_cta");
      expect(result?.text.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(result?.quality.wordCount ?? 999).toBeLessThanOrEqual(100);
    } finally {
      if (previous) process.env.OPENAI_API_KEY = previous;
    }
  });
});
