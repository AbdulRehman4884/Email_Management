import { describe, expect, it } from "vitest";
import { buildMailPayload } from "../smtp.js";

describe("smtp payload builder", () => {
  const smtpConfig = {
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    user: "sender@example.com",
    pass: "super-secret",
    fromName: "Taylor",
    fromEmail: "sender@example.com",
    replyToEmail: "reply@example.com",
    provider: "gmail",
    trackingBaseUrl: "https://trk.example.com",
  };

  it("includes a plain-text fallback when only html is provided", () => {
    const payload = buildMailPayload(
      {
        to: "sam@example.com",
        subject: "Quick question",
        html: "<p>Hi Sam,</p><p>Would it help if I shared one idea?</p>",
      },
      smtpConfig,
    );

    expect(payload.text).toContain("Hi Sam");
    expect(payload.text).toContain("Would it help if I shared one idea?");
  });

  it("uses replyToEmail from SMTP settings", () => {
    const payload = buildMailPayload(
      {
        to: "sam@example.com",
        subject: "Quick question",
        html: "<p>Hi Sam</p>",
      },
      smtpConfig,
    );

    expect(payload.replyTo).toBe("reply@example.com");
  });

  it("adds List-Unsubscribe headers only when configured", () => {
    const payload = buildMailPayload(
      {
        to: "sam@example.com",
        subject: "Quick question",
        html: "<p>Hi Sam</p>",
        listUnsubscribeUrl: "https://trk.example.com/api/unsubscribe?email=sam@example.com",
      },
      smtpConfig,
    );

    expect(payload.headers?.["List-Unsubscribe"]).toContain("https://trk.example.com/api/unsubscribe");
    expect(payload.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const withoutUnsub = buildMailPayload(
      {
        to: "sam@example.com",
        subject: "Quick question",
        html: "<p>Hi Sam</p>",
      },
      smtpConfig,
    );
    expect(withoutUnsub.headers?.["List-Unsubscribe"]).toBeUndefined();
  });
});
