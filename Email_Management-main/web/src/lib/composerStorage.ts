/**
 * Saved replies and the email signature. Kept in this browser only (localStorage, per user id):
 * nothing is stored on the server, so another browser or device will not have them.
 */
export type SavedReply = { id: string; title: string; body: string };

export const SAVED_REPLIES_MAX = 50;
export const SIGNATURE_MAX = 1000;

const repliesKey = (userId: number) => `mailflow_saved_replies_${userId}`;
const signatureKey = (userId: number) => `mailflow_signature_${userId}`;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Shown until the user saves or deletes anything (then their own list is used, even when empty). */
const STARTER_REPLIES: SavedReply[] = [
  { id: 'starter-1', title: 'Thanks for your interest', body: 'Thanks for getting back to me! I will share the details shortly.' },
  { id: 'starter-2', title: 'Book a call', body: 'Happy to discuss this further. Would you have 15 minutes for a quick call this week? Please share a time that suits you.' },
  { id: 'starter-3', title: 'Not the right time', body: 'Thanks for letting me know. I will not follow up for now. Feel free to reach out whenever the timing is better.' },
];

export function loadSavedReplies(userId: number): SavedReply[] {
  const raw = read(repliesKey(userId));
  if (raw == null) return STARTER_REPLIES;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((r) => r && typeof r.title === 'string' && typeof r.body === 'string') : [];
  } catch {
    return [];
  }
}

export function storeSavedReplies(userId: number, list: SavedReply[]): boolean {
  return write(repliesKey(userId), JSON.stringify(list.slice(0, SAVED_REPLIES_MAX)));
}

export function loadSignature(userId: number): string {
  return read(signatureKey(userId)) ?? '';
}

export function storeSignature(userId: number, signature: string): boolean {
  return write(signatureKey(userId), signature.slice(0, SIGNATURE_MAX));
}

/** Plain-text reply + signature, with the standard "-- " separator line. */
export function withTextSignature(body: string, signature: string): string {
  return signature.trim() ? `${body}\n\n-- \n${signature.trim()}` : body;
}

/** The signature as safe HTML (escaped, new lines as <br>), to append to a campaign email. */
export function signatureHtml(signature: string): string {
  const escaped = signature
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
  return `<p>-- <br>${escaped}</p>`;
}

/** Puts `fragment` before </body> when the HTML has one, otherwise at the end. */
export function appendHtml(html: string, fragment: string): string {
  return html.includes('</body>') ? html.replace('</body>', `${fragment}</body>`) : html + fragment;
}
