/**
 * One JSON chat completion with the AI the backend already uses (reply labeling, "Write with AI"):
 * AI_LABELING_API_KEY or else OPENAI_API_KEY; AI_LABELING_BASE_URL and AI_LABELING_MODEL when set.
 * Never throws: null when AI is not set up or did not answer.
 */
const AI_TIMEOUT_MS = 30_000;

export function aiConfigured(): boolean {
  return Boolean((process.env.AI_LABELING_API_KEY || process.env.OPENAI_API_KEY || '').trim());
}

export async function completeJson(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  temperature: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const apiKey = (process.env.AI_LABELING_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.AI_LABELING_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_LABELING_MODEL?.trim() || 'gpt-4o-mini';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature, response_format: { type: 'json_object' }, messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('[ai] request failed with status', res.status);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn('[ai] error:', (err as Error)?.message ?? err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
