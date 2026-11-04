/**
 * N-21: correctly spelled API fields next to the old misspelled ones.
 *   campaigns:  recipientCount = recieptCount
 *   recipients: deliveredAt    = delieveredAt
 * The old fields stay unchanged (the AI agent and other clients read them); see docs/API_FIELD_TYPOS.md.
 * Response-only: DB columns and Drizzle property names are not changed.
 */
function withAlias<T>(row: T, oldKey: string, newKey: string): T {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !(oldKey in row) || newKey in row) return row;
  // Rebuild so the new field sits right after the old one in the JSON.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = v;
    if (k === oldKey) out[newKey] = v;
  }
  return out as T;
}

export function withCampaignFieldAliases<T>(row: T): T {
  return withAlias(row, 'recieptCount', 'recipientCount');
}

export function withRecipientFieldAliases<T>(row: T): T {
  return withAlias(row, 'delieveredAt', 'deliveredAt');
}
