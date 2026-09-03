import { cleanMicroPhrases, type MicroPhraseContext } from "./microPhraseRealism.js";

export function applyCommercialPsychology(value: string, context: MicroPhraseContext = {}): string {
  return cleanMicroPhrases(value, context)
    .replace(/\bmarket story\b/gi, "company story")
    .replace(/\boutreach angle I would test\b/gi, "message I would lead with")
    .replace(/\bThe strongest angle I see is\b/gi, "The strongest opening is")
    .replace(/\bwithout overstating what public data can prove\b/gi, "without stretching the public context")
    .replace(/\bwhere personalization should avoid unsupported claims\b/gi, "where the message should stay grounded")
    .replace(/\btool pitch\b/gi, "platform pitch")
    .replace(/\bgeneric automation pitch\b/gi, "generic technology pitch")
    .trim();
}
