import { describe, expect, it } from "vitest";
import {
  analyzeReplyIntelligence,
  detectReplyIntent,
  scoreHotLead,
} from "../replyIntelligence.js";
import { generateReplySuggestion } from "../objectionHandling.js";

describe("replyIntelligence", () => {
  it("detects meeting intent", () => {
    const result = detectReplyIntent({ bodyText: "Can we talk tomorrow? Send your calendar." });
    expect(result.category).toBe("meeting_interest");
    expect(result.urgencyLevel).toBe("high");
    expect(result.meetingLikelihood).toBeGreaterThanOrEqual(80);
  });

  it("detects unsubscribe requests", () => {
    const result = detectReplyIntent({ bodyText: "Please remove me and stop emailing." });
    expect(result.category).toBe("unsubscribe_request");
  });

  it("detects pricing objections", () => {
    const result = detectReplyIntent({ bodyText: "Looks useful, but this is too expensive and we have no budget." });
    expect(result.category).toBe("objection_price");
  });

  it("detects competitor objections", () => {
    const result = detectReplyIntent({ bodyText: "We already use HubSpot for this." });
    expect(result.category).toBe("objection_competitor");
  });

  it("detects neutral questions", () => {
    const result = detectReplyIntent({ bodyText: "How does this work?" });
    expect(result.category).toBe("neutral_question");
  });

  it("scores meeting language and executive title as hot", () => {
    const result = scoreHotLead({
      category: "meeting_interest",
      sentiment: "positive",
      urgencyLevel: "high",
      meetingLikelihood: 95,
      priorReplyCount: 1,
      responseTimeMinutes: 30,
      recipientTitle: "Chief Revenue Officer",
      leadScore: 90,
      meetingReady: true,
    });
    expect(result.leadTemperature).toBe("meeting_ready");
    expect(result.hotLeadScore).toBeGreaterThanOrEqual(90);
    expect(result.reasons).toContain("Executive title");
  });

  it("never suggests auto-replies for unsubscribe or spam complaints", () => {
    const unsubscribe = analyzeReplyIntelligence({ bodyText: "Unsubscribe me now" });
    const spam = analyzeReplyIntelligence({ bodyText: "This is spam. I will report you." });
    expect(generateReplySuggestion({ analysis: unsubscribe, replySubject: "Re: hello" })).toBeNull();
    expect(generateReplySuggestion({ analysis: spam, replySubject: "Re: hello" })).toBeNull();
    expect(spam.requiresHumanReview).toBe(true);
  });

  it("generates safe objection replies", () => {
    const pricing = analyzeReplyIntelligence({ bodyText: "Too expensive, no budget." });
    const timing = analyzeReplyIntelligence({ bodyText: "Not right now, maybe next quarter." });
    const competitor = analyzeReplyIntelligence({ bodyText: "We already use Salesforce." });

    expect(generateReplySuggestion({ analysis: pricing, replySubject: "Re: pricing" })?.bodyText).toMatch(/start small/i);
    expect(generateReplySuggestion({ analysis: timing, replySubject: "Re: timing" })?.bodyText).toMatch(/next quarter/i);
    expect(generateReplySuggestion({ analysis: competitor, replySubject: "Re: vendor" })?.bodyText).toMatch(/manual work/i);
  });

  it("flags legal language for human review", () => {
    const result = analyzeReplyIntelligence({ bodyText: "Please cease contact or I will ask legal to report this." });
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reviewStatus).toBe("human_review");
  });
});
