/**
 * Normalize Message-ID for consistent storage and matching.
 * Trims whitespace and strips angle brackets so "<id@host>" and "id@host" match.
 */
export function normalizeMessageId(id: string | null | undefined): string | null {
  if (id == null || typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const withoutBrackets = trimmed.replace(/^<+|>+$/g, '').trim();
  return withoutBrackets || null;
}
