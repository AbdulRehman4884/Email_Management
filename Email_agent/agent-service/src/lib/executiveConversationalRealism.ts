import { polishCadence } from "./cadenceHumanizationEngine.js";
import { applyCommercialPsychology } from "./commercialPsychologyLayer.js";
import { cleanMicroPhrases, type MicroPhraseContext } from "./microPhraseRealism.js";

export function applyExecutiveConversationalRealism(
  value: string,
  context: MicroPhraseContext = {},
): string {
  return polishCadence(applyCommercialPsychology(cleanMicroPhrases(value, context), context), context)
    .replace(/\bWould a practical discussion\b/gi, "Would a short discussion")
    .replace(/\bShould I send\b/gi, "I can send")
    .replace(/\bOpen to a\b/gi, "Open to a")
    .replace(/\s+([.,;:?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
