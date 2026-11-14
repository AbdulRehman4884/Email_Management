/**
 * src/config/emailRealism.config.ts
 *
 * Word lists for the realistic-email checks (lib/emailRealism.ts). Extend them here.
 * Matching is case-insensitive and whole word / whole phrase.
 */

/** V4 — words that make an email look like spam. Checked in the subject and the body. */
export const SPAM_PHRASES = [
  "free", "100%", "guarantee", "guaranteed", "act now", "limited time", "urgent", "risk-free", "no obligation",
  "click here", "buy now", "order now", "special offer", "winner", "congratulations", "cash", "earn money",
  "double your", "best price", "cheap", "discount", "deal", "exclusive offer", "once in a lifetime", "apply now",
  "sign up free", "no cost", "call now", "don't miss", "offer expires", "incredible", "amazing opportunity",
];

/** V5 — phrases that read as AI-written or salesy. The writer prompt bans the same list. */
export const CLICHE_PHRASES = [
  "i hope this email finds you well", "i hope this finds you well", "i came across", "i believe i can help",
  "tailored solutions", "enhance your projects", "leverage", "synergy", "cutting-edge", "seamless", "unlock",
  "game-changer", "revolutionize", "delve", "in today's fast-paced world", "reach out", "touch base", "circle back",
];

/** V7 — how the recipient was found must never show. */
export const SOURCE_LEAK_PHRASES = [
  "upwork", "fiverr", "freelancer.com", "your profile", "i see that you", "i came across", "i noticed you're looking",
  "i noticed you are looking", "your job post", "your posting on",
];

/** V10 — all-caps words that are allowed. */
export const ALLOWED_ACRONYMS = ["AI", "API", "CRM", "ERP", "SaaS", "ML", "LLM", "B2B", "CTO", "CEO", "QA", "UI", "UX", "SEO", "MVP", "AWS", "iOS", "PHP", "SQL"];

/** Words of a greeting line and of a sign-off line. */
export const GREETING_WORDS = ["hi", "hello", "hey", "dear"];
export const SIGNOFF_LINES = ["best", "thanks", "thank you", "cheers", "regards", "best regards", "kind regards", "warm regards", "many thanks", "all the best"];

/** Body length (words, without greeting and signature) and paragraph shape. */
export const BODY_WORDS = { min: 50, max: 110 };
export const PARAGRAPHS = { min: 2, max: 3 };
export const MAX_SENTENCES_PER_PARAGRAPH = 3;
export const MAX_AVG_SENTENCE_WORDS = 20;
export const SUBJECT_WORDS = { min: 2, max: 5 };

/** V15 — two emails of one campaign may not be closer than this (word 3-gram Jaccard). */
export const MAX_SIMILARITY = 0.7;
/** V6 — the first paragraph may not copy the website's own words (tagline / About text). */
export const MAX_ABOUT_OVERLAP = 0.6;
