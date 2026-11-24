/**
 * Which language should the agent answer in? (QA: "Create campaign" was answered in Spanish.)
 *
 * The answer used to be translated by asking the AI to guess the language of the user's message. Short English
 * commands ("Create campaign", "Show stats") were sometimes guessed as Spanish. Now, like ChatGPT:
 *  - the language is read from the message itself with clear signals (script, accents, common words);
 *  - a message with no clear signal (a button, a name, "yes", "2") keeps the language of the conversation;
 *  - English needs no translation at all, so English users never get another language.
 * The AI is only asked to translate when the user clearly writes another language, and it is told which one.
 */

export type ReplyLanguage = { lang: "en" } | { lang: "other"; name: string; sample: string } | { lang: "unknown" };

const SCRIPTS: Array<[RegExp, string]> = [
  [/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g, "the language of the user's message (Urdu or Arabic script)"],
  [/[ऀ-ॿ]/g, "Hindi"],
  [/[Ѐ-ӿ]/g, "the language of the user's message (Cyrillic script)"],
  [/[一-鿿㐀-䶿]/g, "Chinese"],
  [/[぀-ヿ]/g, "Japanese"],
  [/[가-힯]/g, "Korean"],
  [/[֐-׿]/g, "Hebrew"],
  [/[฀-๿]/g, "Thai"],
  [/[Ͱ-Ͽ]/g, "Greek"],
  [/[ঀ-৿]/g, "Bengali"],
];

/** Common words that only appear in that language (not English, not product words). */
const WORDS: Array<[string, Set<string>]> = [
  ["Spanish", new Set(("el la los las que de del por para con una uno mis tus sus es son está estan están quiero puedes puede " +
    "crear crea muestra muéstrame mostrar dame hola gracias cuántas cuantas cuántos cuantos campaña campañas correo correos " +
    "enviar envía pausa pausar todas todos mi tu cómo como cuál cual qué donde dónde favor ver nueva nuevo").split(" "))],
  ["Portuguese", new Set(("você voce minha meu minhas meus não nao obrigado obrigada quero criar mostrar campanha campanhas " +
    "enviar todas todos olá ola uma para com está estão quantas quantos").split(" "))],
  ["French", new Set(("je tu il elle nous vous les des une est sont mes mon ma avec pour dans pas oui non merci bonjour " +
    "créer creer afficher montre montrez campagne campagnes envoyer toutes tous combien quelle quel").split(" "))],
  ["German", new Set(("ich du er sie wir ihr und die der das ein eine ist sind mein meine mit für fur nicht ja nein danke " +
    "hallo erstellen zeige zeigen kampagne kampagnen senden alle wie viele welche").split(" "))],
  ["Italian", new Set(("io il lo gli della delle sono mio mia miei con per non grazie ciao creare crea mostra mostrami " +
    "campagna campagne inviare tutte tutti quante quanti").split(" "))],
  ["Roman Urdu (Urdu written in Latin letters, like the user)", new Set(("kya kia hai hain ho hoga mujhe mujhay mujha mera meri mere " +
    "mein main karo kro krna karna kardo kr do bnao banao bana dikhao dikha batao btao btio bta nahi nhi bhai yar yaar " +
    "aur ka ki ke ko se wala wali sab sari sare abhi kaise kese kitne kitni kahan kab jo woh wo ye yeh chahiye chyia " +
    "nayi naya nai bana banado dena dein dain aaye aaya aayi aye gaye gaya hue hua hui saari tamam konsi konsa kaun").split(" "))],
];

/** English function words and command verbs: evidence of English. */
const ENGLISH = new Set(("the a an and or of to for in on at by with from is are was were be been do does did can could " +
  "would should will shall i me my mine you your we our it its this that these those what which who how why when where " +
  "please show list create make send start stop pause resume delete remove add update edit check find get give tell " +
  "generate personalized schedule all new yes no ok okay thanks thank help hi hello hey about many much " +
  "today yesterday last next first second more").split(" "));

/** Product words used in every language ("campaign", "SMTP"): no evidence either way. */
const PRODUCT = new Set(("campaign campaigns email emails mail stats statistics status reply replies inbox lead leads " +
  "recipient recipients smtp settings draft page open rate rates crm csv file").split(" "));

const ACCENTS = /[áéíóúñ¿¡àèìòùâêîôûäëïöüçãõßœæ]/i;

/** Quoted names, links, emails and numbers say nothing about the language. */
function textOnly(message: string): string {
  return message
    .replace(/https?:\/\/\S+|\S+@\S+\.\S+/g, " ")
    .replace(/["“”«»][^"“”«»]{0,80}["“”«»]|'[^']{1,60}'/g, " ")
    .replace(/\b(?:called|named)\s+\S+(?:\s+\S+)?/gi, " ")
    .replace(/[#\d]+/g, " ");
}

/** The language of one message. "unknown" when it gives no clear signal. */
export function messageLanguage(message: string): ReplyLanguage {
  const text = textOnly(message);
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (!letters) return { lang: "unknown" };
  for (const [re, name] of SCRIPTS) {
    const n = (text.match(re) ?? []).length;
    if (n >= 2 && n / letters >= 0.3) return { lang: "other", name, sample: message };
  }
  const words = (text.toLowerCase().match(/[\p{L}']+/gu) ?? []).filter((w) => !PRODUCT.has(w));
  if (!words.length) return { lang: "unknown" };
  const english = words.filter((w) => ENGLISH.has(w)).length;
  let best: { name: string; hits: number } | null = null;
  for (const [name, set] of WORDS) {
    const hits = words.filter((w) => set.has(w) && !ENGLISH.has(w)).length;
    if (hits && (!best || hits > best.hits)) best = { name, hits };
  }
  const accents = ACCENTS.test(text);
  // Clearly another language: its own words win over English words (accents count as one more signal).
  if (best && best.hits + (accents ? 1 : 0) >= 2 && best.hits + (accents ? 1 : 0) > english) {
    return { lang: "other", name: best.name, sample: message };
  }
  if (best && words.length <= 3 && best.hits >= 1 && english === 0) return { lang: "other", name: best.name, sample: message };
  if (english >= 1) return { lang: "en" };
  if (accents && words.length >= 3) return { lang: "other", name: "the language of the user's message", sample: message };
  return { lang: "unknown" };
}

/**
 * The language to answer in: the current message's, or (when it gives no signal) the conversation's latest clear
 * language. English when nothing is known.
 */
export function replyLanguage(current: string, earlierUserMessages: string[]): ReplyLanguage {
  const now = messageLanguage(current);
  if (now.lang !== "unknown") return now;
  for (const m of [...earlierUserMessages].reverse()) {
    const l = messageLanguage(m);
    if (l.lang !== "unknown") return l;
  }
  return { lang: "en" };
}
