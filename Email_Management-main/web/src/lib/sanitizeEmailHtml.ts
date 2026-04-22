/**
 * Strip tags that apply document-wide or execute code when `dangerouslySetInnerHTML` is used.
 * Malformed marketing emails often ship `<style>` with broad selectors (e.g. `p { … }`) which
 * then affect the Inbox list and the rest of the app until that HTML is unmounted.
 */
export function sanitizeInboundEmailHtmlForDisplay(html: string): string {
  if (!html) return html;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(
      /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\/?>(?:\s*<\/link>)?/gi,
      '',
    );
}
