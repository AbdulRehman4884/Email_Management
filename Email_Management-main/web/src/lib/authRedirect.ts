// F-12: remember where a logged-out user wanted to go, and send them there after sign-in.

/** "/login?redirect=<path>" for the page the user is on now (or plain "/login" for "/"). */
export function loginUrlFor(pathWithSearch: string): string {
  const target = safeRedirectTarget(pathWithSearch);
  return target && target !== '/' ? `/login?redirect=${encodeURIComponent(target)}` : '/login';
}

/** Only same-site app paths are allowed ("/x"), never "//evil.com", full URLs or the auth pages themselves. */
export function safeRedirectTarget(raw: string | null | undefined): string | null {
  const v = String(raw ?? '').trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  if (/^\/(login|signup|forgot-password|reset-password)(\/|\?|$)/.test(v)) return null;
  return v;
}
