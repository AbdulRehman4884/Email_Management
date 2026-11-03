/**
 * A saved search's focus: what the companies should be doing within the category
 * ("IT and software companies" + focus "AI automation, chatbots").
 *
 * Stored in saved_searches.keywords. OSM has no "AI automation" category, so discovery stays broad (the category)
 * and each lead is matched against what its website says it does (companies.name / description / site_topics).
 * A match adds FOCUS_POINTS to the fit score and a "Matches your focus" line (score.ts).
 * With a search engine source the focus words also go into the search queries.
 */
import { CATEGORIES, type Category } from './categories.js';

/** Filler around a focus: "working on", "that do", "specialising in", "focused on" ... */
const FILLER = /\b(that|which|who|are|is|working|work|works|on|in|into|with|for|the|a|an|and|doing|do|does|focused|focusing|focus|specializ\w*|specialis\w*|offering|offer|offers|providing|provide|provides|services?|based|companies|company|firms?|businesses|business|jo|pa|par|pe|per|kam|kaam|krti|karti|krte|karte|kar|kr|hon|hain|hai|wali|wale|ki|ke|ka|mein|me)\b/gi;
const STOP = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'with', 'to', 'by', 'at', 'services', 'service', 'solutions', 'solution', 'company', 'companies']);

/** "AI automation, chatbots; RPA" -> ["AI automation", "chatbots", "RPA"]. */
export function splitFocusList(input: string | null | undefined): string[] {
  return [...new Set((input ?? '').split(/[,;\n|]+|\s+\/\s+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 2 && s.length <= 60))].slice(0, 10);
}

/**
 * What is left of a category phrase once the category words are taken out:
 * "IT companies working on AI automation" (category it_company) -> "AI automation". Empty when nothing is left.
 */
export function focusFromPhrase(phrase: string, category: Category | null): string {
  if (!category) return '';
  let rest = ` ${phrase.toLowerCase()} `;
  // Take out only the category words that come FIRST ("IT companies"): a later alias is the focus itself
  // ("IT companies jo app development pa kam krti hon": "app development" is an IT alias too).
  const aliases = [category.label, category.key.replace(/_/g, ' '), ...category.aliases].map((a) => a.toLowerCase());
  let first: { index: number; length: number } | null = null;
  for (const a of aliases) {
    const m = new RegExp(`(?:^|\\W)(${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=\\W|$)`).exec(rest);
    if (!m) continue;
    const index = m.index + m[0].length - m[1]!.length;
    if (!first || index < first.index || (index === first.index && a.length > first.length)) first = { index, length: a.length };
  }
  if (first) rest = `${rest.slice(0, first.index)} ${rest.slice(first.index + first.length)}`;
  rest = rest.replace(FILLER, ' ').replace(/[^a-z0-9+#.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Keep the user's casing ("AI automation") by cutting the same words out of the original.
  const words = rest.split(' ').filter(Boolean);
  if (words.length === 0) return '';
  const original = phrase.split(/\s+/).filter((w) => words.includes(w.toLowerCase().replace(/[^a-z0-9+#.\-]+/g, '')));
  return (original.length ? original.join(' ') : rest).slice(0, 60);
}

/** Lowercase words with a tiny stem (automation / automate / automated -> autom...). */
function stems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w));
}

/**
 * The first focus phrase whose words all appear in the company text, or null.
 * "AI automation" matches "We build AI-powered automation for clinics" and "Intelligent Automation & AI".
 */
export function matchFocus(focus: string[], companyText: string): string | null {
  if (focus.length === 0) return null;
  const have = new Set(stems(companyText));
  for (const f of focus) {
    const need = stems(f);
    if (need.length > 0 && need.every((w) => have.has(w))) return f;
  }
  return null;
}

/** Category options for forms: key + label (the user picks one; free text is not needed any more). */
export function categoryOptions(): Array<{ key: string; label: string }> {
  return CATEGORIES.map((c) => ({ key: c.key, label: c.label }));
}
