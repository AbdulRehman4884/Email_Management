/**
 * Strips document-level CSS and scripts from stored HTML before API responses.
 * See web `lib/sanitizeEmailHtml.ts` (keep in sync when changing).
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
