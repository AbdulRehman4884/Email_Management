import { type MicroPhraseContext } from "./microPhraseRealism.js";

export function polishCadence(value: string, _context: MicroPhraseContext = {}): string {
  return value
    .replace(/\bIt is whether\b/g, "The practical question is whether")
    .replace(/\bThat gives\b/g, "That gives")
    .replace(/\bA pattern worth testing\b/g, "One pattern worth looking at")
    .replace(/\bThe useful entry point may be\b/g, "A practical entry point may be")
    .replace(/\bIf AI is part of the agenda\b/g, "If AI is already on the agenda")
    .replace(/\bThe finance angle\b/g, "The finance angle")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
