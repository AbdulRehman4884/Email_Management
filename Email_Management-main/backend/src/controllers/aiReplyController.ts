/**
 * AI reply agent API (mounted at /api, login + Inbox plan required):
 *   GET  /ai-reply/settings                       the user's settings (off by default)
 *   PUT  /ai-reply/settings                       save { mode, labels, delayMinutes, maxPerThread, dailyLimit, offer, meetingLink }
 *   GET  /ai-reply/drafts                         drafts waiting (pending + scheduled)
 *   GET  /ai-reply/threads/:threadRootId/draft    the open draft of a conversation ({ draft: null } when none)
 *   POST /ai-reply/threads/:threadRootId/draft    "Write with AI": a draft for the newest lead reply { regenerate? }
 *   POST /ai-reply/drafts/:id/discard             discard (also cancels a scheduled auto send)
 *   POST /ai-reply/drafts/:id/use                 the user copied it into the reply box (sends it themselves)
 *   GET  /replies/:id/suggestion                  for the agent's MCP tool draft_reply_suggestion
 */
import type { Request, Response } from 'express';
import {
  draftForThread,
  getAiReplySettings,
  isMissingTable,
  listOpenDrafts,
  openDraftForThread,
  saveAiReplySettings,
  setDraftStatus,
  suggestionForReply,
} from '../lib/aiReply/agent.js';
import { settingsProblems } from '../lib/aiReply/core.js';
import { aiConfigured } from '../lib/aiReply/ai.js';

const NOT_READY = 'The AI reply agent is not set up on the server yet (database migration 0043).';

function idParam(req: Request, name: string): number | null {
  const n = Number.parseInt(String(req.params[name] ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function handle(res: Response, what: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (isMissingTable(err)) return res.status(503).json({ error: NOT_READY });
    console.error(`[ai-reply] ${what} failed:`, err);
    return res.status(500).json({ error: `Could not ${what}` });
  }
}

export function getSettingsHandler(req: Request, res: Response) {
  const userId = req.user!.id;
  return handle(res, 'load the AI reply settings', async () => {
    res.json({ settings: await getAiReplySettings(userId), aiConfigured: aiConfigured() });
  });
}

export function saveSettingsHandler(req: Request, res: Response) {
  const userId = req.user!.id;
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const problems = settingsProblems(body);
  if (problems.length) return res.status(400).json({ error: problems.join(' ') });
  return handle(res, 'save the AI reply settings', async () => {
    const settings = await saveAiReplySettings(userId, body);
    res.json({ settings, aiConfigured: aiConfigured() });
  });
}

export function listDraftsHandler(req: Request, res: Response) {
  const userId = req.user!.id;
  return handle(res, 'load the AI drafts', async () => {
    res.json({ drafts: await listOpenDrafts(userId) });
  });
}

export function getThreadDraftHandler(req: Request, res: Response) {
  const userId = req.user!.id;
  const threadRootId = idParam(req, 'threadRootId');
  if (!threadRootId) return res.status(400).json({ error: 'Invalid conversation id' });
  return handle(res, 'load the AI draft', async () => {
    res.json({ draft: await openDraftForThread(userId, threadRootId) });
  });
}

export function createThreadDraftHandler(req: Request, res: Response) {
  const userId = req.user!.id;
  const threadRootId = idParam(req, 'threadRootId');
  if (!threadRootId) return res.status(400).json({ error: 'Invalid conversation id' });
  const regenerate = req.body?.regenerate === true;
  return handle(res, 'write the AI draft', async () => {
    const result = await draftForThread(userId, threadRootId, regenerate);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ draft: result.draft });
  });
}

function statusHandler(status: 'discarded' | 'used') {
  return (req: Request, res: Response) => {
    const userId = req.user!.id;
    const id = idParam(req, 'id');
    if (!id) return res.status(400).json({ error: 'Invalid draft id' });
    return handle(res, 'update the AI draft', async () => {
      const draft = await setDraftStatus(userId, id, status);
      if (!draft) return res.status(404).json({ error: 'Draft not found or already handled' });
      res.json({ draft });
    });
  };
}

export const discardDraftHandler = statusHandler('discarded');
export const useDraftHandler = statusHandler('used');

export function suggestionHandler(req: Request, res: Response) {
  const userId = req.user!.id;
  const id = idParam(req, 'id');
  if (!id) return res.status(400).json({ error: 'Invalid reply id' });
  return handle(res, 'write the reply suggestion', async () => {
    const result = await suggestionForReply(userId, id);
    if (!result) return res.status(404).json({ error: 'Reply not found' });
    res.json(result);
  });
}
