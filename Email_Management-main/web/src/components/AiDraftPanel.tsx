import { useEffect, useState } from 'react';
import { Bot, Clock, RefreshCw, Sparkles, X } from 'lucide-react';
import { Button } from './ui';
import { aiReplyApi, apiError, withoutSignOff, type AiReplyDraft } from '../lib/aiFeaturesApi';

const OBJECTION_NAME: Record<string, string> = {
  price: 'price worry',
  busy: 'busy',
  timing: 'wants to talk later',
  competitor: 'uses someone else',
  not_now: 'not now',
  info: 'wants more info',
};

const timeOf = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * Inbox: the AI's answer to the lead's newest reply, above the reply box.
 * "Use draft" puts it in the reply box (the normal Send reply sends it); "Discard" also cancels an auto send.
 */
export function AiDraftPanel(props: { threadRootId: number; hasSignature: boolean; onUse: (text: string) => void }) {
  const { threadRootId } = props;
  const [draft, setDraft] = useState<AiReplyDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<null | 'write' | 'use' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDraft(null);
    setError(null);
    setLoaded(false);
    if (threadRootId < 0) return;
    aiReplyApi
      .threadDraft(threadRootId)
      .then((d) => alive && setDraft(d))
      .catch(() => alive && setDraft(null)) // no AI drafts (old server / no plan): the Inbox works as before
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [threadRootId]);

  if (threadRootId < 0 || !loaded) return null;

  const write = async (regenerate: boolean) => {
    setBusy('write');
    setError(null);
    try {
      setDraft(await aiReplyApi.writeDraft(threadRootId, regenerate));
    } catch (e) {
      setError(apiError(e, 'The AI could not write a reply. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const use = async () => {
    if (!draft) return;
    setBusy('use');
    setError(null);
    try {
      await aiReplyApi.markUsed(draft.id);
    } catch {
      /* the text is still useful even when the status could not be saved */
    }
    props.onUse(props.hasSignature ? withoutSignOff(draft.body) : draft.body);
    setDraft(null);
    setBusy(null);
  };

  const discard = async () => {
    if (!draft) return;
    setBusy('discard');
    setError(null);
    try {
      await aiReplyApi.discard(draft.id);
      setDraft(null);
    } catch (e) {
      setError(apiError(e, 'Could not discard the draft'));
    } finally {
      setBusy(null);
    }
  };

  if (!draft) {
    return (
      <div className="flex-shrink-0 px-4 pt-2 bg-white" data-testid="ai-draft-panel">
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" leftIcon={<Sparkles className="w-3.5 h-3.5" />} onClick={() => void write(false)} isLoading={busy === 'write'} disabled={busy !== null}>
            Write with AI
          </Button>
          {error && <span className="text-sm text-red-600" role="alert">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-shrink-0 px-4 pt-3 bg-white" data-testid="ai-draft-panel">
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
        <div className="flex items-center justify-between gap-2 mb-2 text-xs text-indigo-900">
          <span className="inline-flex items-center gap-1 font-semibold">
            <Bot className="w-3.5 h-3.5" /> AI draft
            {draft.objection && OBJECTION_NAME[draft.objection] && <span className="font-normal">· lead: {OBJECTION_NAME[draft.objection]}</span>}
          </span>
          {draft.status === 'scheduled' && (
            <span className="inline-flex items-center gap-1" data-testid="ai-draft-scheduled">
              <Clock className="w-3.5 h-3.5" /> Sends by itself{draft.sendAfter ? ` at ${timeOf(draft.sendAfter)}` : ' soon'}
            </span>
          )}
        </div>
        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words max-h-40 overflow-y-auto" data-testid="ai-draft-body">{draft.body}</p>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Button size="sm" onClick={() => void use()} isLoading={busy === 'use'} disabled={busy !== null}>
            Use draft
          </Button>
          <Button size="sm" variant="outline" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => void write(true)} isLoading={busy === 'write'} disabled={busy !== null}>
            Write again
          </Button>
          <Button size="sm" variant="outline" leftIcon={<X className="w-3.5 h-3.5" />} onClick={() => void discard()} isLoading={busy === 'discard'} disabled={busy !== null}>
            {draft.status === 'scheduled' ? 'Cancel auto send' : 'Discard'}
          </Button>
        </div>
        {error && <p className="text-sm text-red-600 mt-2" role="alert">{error}</p>}
      </div>
    </div>
  );
}
