import { analyzeOutreachQuality, htmlToPlainText } from "./outreachQuality.js";

export type MailAuthStatus = "pass" | "fail" | "unknown";
export type InboxRisk = "low" | "medium" | "high";
export type GmailTabPrediction = "primary_possible" | "promotions_likely" | "spam_risk";

export interface DeliverabilityDiagnostics {
  smtpProvider: string;
  senderEmail: string;
  fromDomain: string;
  recipientDomain: string;
  spfStatus: MailAuthStatus;
  dkimStatus: MailAuthStatus;
  dmarcStatus: MailAuthStatus;
  authenticationNote: string;
  trackingDomainPresence: boolean;
  unsubscribeHeaderPresence: boolean;
  emailHtmlTextRatio: number;
  promotionalKeywordScore: number;
  linkCount: number;
  imageCount: number;
  subjectSpamRiskScore: number;
  bodySpamRiskScore: number;
  inboxRisk: InboxRisk;
  likelyTab: GmailTabPrediction;
  reasons: string[];
  recommendations: string[];
}

export interface PredictTabMetadata {
  promotionalKeywordScore: number;
  linkCount: number;
  imageCount: number;
  htmlTextRatio: number;
  unsubscribeHeaderPresence: boolean;
  genericGreeting: boolean;
  marketingToneScore: number;
  senderReputationKnown?: boolean;
}

export function predictGmailTab(
  emailContent: { subject: string; html?: string; text?: string },
  metadata: PredictTabMetadata,
): GmailTabPrediction {
  const subject = (emailContent.subject || "").toLowerCase();
  const body = ((emailContent.text || "") + "\n" + (emailContent.html || "")).toLowerCase();
  const promoSignals =
    metadata.promotionalKeywordScore >= 4 ||
    metadata.marketingToneScore >= 2 ||
    metadata.linkCount > 1 ||
    metadata.imageCount > 0 ||
    metadata.htmlTextRatio > 1.7 ||
    metadata.unsubscribeHeaderPresence ||
    /\bcampaign\b|\bmarketing\b|\boffer\b|\bnewsletter\b/.test(subject + "\n" + body);

  const spamSignals =
    metadata.promotionalKeywordScore >= 7 ||
    metadata.linkCount >= 4 ||
    /free money|guarantee|act now|limited time/.test(subject + "\n" + body);

  if (spamSignals) return "spam_risk";
  if (promoSignals || metadata.genericGreeting || metadata.senderReputationKnown === false) {
    return "promotions_likely";
  }
  return "primary_possible";
}

function domainFromEmail(email: string): string {
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function countLinks(html: string, text: string): number {
  const hrefCount = (html.match(/<a\b[^>]*href=/gi) ?? []).length;
  const textUrlCount = (text.match(/\bhttps?:\/\/[^\s)]+/gi) ?? []).length;
  return Math.max(hrefCount, textUrlCount);
}

function countImages(html: string): number {
  return (html.match(/<img\b/gi) ?? []).length;
}

function scoreSubjectRisk(subject: string): number {
  let score = 0;
  const lower = subject.toLowerCase();
  if (/[!?]{2,}/.test(subject)) score += 12;
  if (subject === subject.toUpperCase() && /[A-Z]/.test(subject)) score += 18;
  if (/\bfree\b|\boffer\b|\bact now\b|\blimited time\b/.test(lower)) score += 24;
  if (/\bcampaign\b|\bnewsletter\b|\bmarketing\b/.test(lower)) score += 16;
  return Math.min(score, 100);
}

function scoreBodyRisk(params: {
  promoScore: number;
  linkCount: number;
  imageCount: number;
  htmlTextRatio: number;
  genericGreeting: boolean;
  marketingToneScore: number;
  longParagraphCount: number;
  claimCount: number;
}): number {
  let score = 0;
  score += Math.min(params.promoScore * 6, 30);
  score += Math.min(params.linkCount * 8, 24);
  score += Math.min(params.imageCount * 10, 20);
  score += params.htmlTextRatio > 1.7 ? 12 : 0;
  score += params.htmlTextRatio > 2.5 ? 10 : 0;
  score += params.genericGreeting ? 8 : 0;
  score += Math.min(params.marketingToneScore * 6, 18);
  score += Math.min(params.longParagraphCount * 4, 12);
  score += Math.min(params.claimCount * 5, 15);
  return Math.min(score, 100);
}

function roundRatio(html: string, text: string): number {
  const plain = Math.max(text.trim().length, 1);
  return Number((html.length / plain).toFixed(2));
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

export function buildDeliverabilityDiagnostics(input: {
  subject: string;
  html: string;
  text?: string;
  smtpProvider?: string | null;
  senderEmail: string;
  recipientEmail: string;
  trackingDomain?: string | null;
  unsubscribeHeaderPresence: boolean;
  spfStatus?: MailAuthStatus;
  dkimStatus?: MailAuthStatus;
  dmarcStatus?: MailAuthStatus;
  senderReputationKnown?: boolean;
}): DeliverabilityDiagnostics {
  const text = (input.text?.trim() || htmlToPlainText(input.html)).trim();
  const quality = analyzeOutreachQuality({
    subject: input.subject,
    bodyText: text,
    bodyHtml: input.html,
  });

  const fromDomain = domainFromEmail(input.senderEmail);
  const recipientDomain = domainFromEmail(input.recipientEmail);
  const linkCount = countLinks(input.html, text);
  const imageCount = countImages(input.html);
  const htmlTextRatio = roundRatio(input.html, text);
  const subjectSpamRiskScore = scoreSubjectRisk(input.subject);
  const bodySpamRiskScore = scoreBodyRisk({
    promoScore: quality.promotionalKeywordScore,
    linkCount,
    imageCount,
    htmlTextRatio,
    genericGreeting: quality.genericGreeting,
    marketingToneScore: quality.marketingToneScore,
    longParagraphCount: quality.longParagraphCount,
    claimCount: quality.claimCount,
  });

  const likelyTab = predictGmailTab(
    { subject: input.subject, html: input.html, text },
    {
      promotionalKeywordScore: quality.promotionalKeywordScore,
      linkCount,
      imageCount,
      htmlTextRatio,
      unsubscribeHeaderPresence: input.unsubscribeHeaderPresence,
      genericGreeting: quality.genericGreeting,
      marketingToneScore: quality.marketingToneScore,
      senderReputationKnown: input.senderReputationKnown,
    },
  );

  const compositeRisk = subjectSpamRiskScore + bodySpamRiskScore;
  const inboxRisk: InboxRisk =
    compositeRisk >= 80 || likelyTab === "spam_risk"
      ? "high"
      : compositeRisk >= 35 || likelyTab === "promotions_likely"
        ? "medium"
        : "low";

  const reasons = dedupe([
    ...(quality.issues.length > 0 ? quality.issues : []),
    ...(quality.promotionalKeywordScore >= 3 ? ["Marketing-style campaign language"] : []),
    ...(input.unsubscribeHeaderPresence ? ["List-Unsubscribe header present (good for compliance, but also a marketing signal)"] : []),
    ...(linkCount > 1 ? ["Multiple links detected"] : []),
    ...(imageCount > 0 ? ["Image-heavy email HTML"] : []),
    ...(htmlTextRatio > 1.7 ? ["HTML-heavy body relative to plain text"] : []),
    ...(input.spfStatus !== "pass" || input.dkimStatus !== "pass" || input.dmarcStatus !== "pass"
      ? ["No custom domain authentication verified"]
      : []),
    ...(likelyTab === "spam_risk" ? ["Spam-like wording or density detected"] : []),
  ]);

  const recommendations = dedupe([
    ...(quality.suggestions.length > 0 ? quality.suggestions : []),
    "Use shorter plain-text email.",
    "Use one human-style CTA.",
    ...(linkCount > 1 ? ["Reduce the number of links."] : []),
    ...(imageCount > 0 ? ["Avoid images unless they are essential."] : []),
    ...((input.spfStatus !== "pass" || input.dkimStatus !== "pass" || input.dmarcStatus !== "pass")
      ? ["Configure SPF/DKIM/DMARC for a custom domain."]
      : []),
  ]);

  return {
    smtpProvider: input.smtpProvider?.trim() || "unknown",
    senderEmail: input.senderEmail,
    fromDomain,
    recipientDomain,
    spfStatus: input.spfStatus ?? "unknown",
    dkimStatus: input.dkimStatus ?? "unknown",
    dmarcStatus: input.dmarcStatus ?? "unknown",
    authenticationNote:
      "SPF/DKIM/DMARC are not verified locally in this environment. Status is reported as unknown unless an upstream checker populates it.",
    trackingDomainPresence: Boolean(input.trackingDomain),
    unsubscribeHeaderPresence: input.unsubscribeHeaderPresence,
    emailHtmlTextRatio: htmlTextRatio,
    promotionalKeywordScore: quality.promotionalKeywordScore,
    linkCount,
    imageCount,
    subjectSpamRiskScore,
    bodySpamRiskScore,
    inboxRisk,
    likelyTab,
    reasons,
    recommendations,
  };
}
