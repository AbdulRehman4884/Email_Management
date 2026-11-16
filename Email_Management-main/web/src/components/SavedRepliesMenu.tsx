import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, MessageSquareText, Trash2 } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { loadSavedReplies, storeSavedReplies, SAVED_REPLIES_MAX, type SavedReply } from '../lib/composerStorage';

/** Inbox composer: pick a saved reply to put in the reply box, or add a new one (name + text). */
export function SavedRepliesMenu({ currentText, onInsert }: { currentText: string; onInsert: (body: string) => void }) {
  const userId = useAuthStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SavedReply[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !userId) return;
    setList(loadSavedReplies(userId));
    setBody(currentText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!userId) return null;

  const update = (next: SavedReply[]) => {
    if (storeSavedReplies(userId, next)) setList(next);
  };

  const canSave = Boolean(title.trim() && body.trim()) && list.length < SAVED_REPLIES_MAX;

  const saveCurrent = () => {
    if (!canSave) return;
    update([...list, { id: String(Date.now()), title: title.trim().slice(0, 100), body: body.trim() }]);
    setTitle('');
    setBody('');
  };

  return (
    <div ref={boxRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Saved replies"
        aria-label="Saved replies"
        aria-expanded={open}
        className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
      >
        <MessageSquareText className="w-4 h-4" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 mb-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-20" style={{ bottom: '100%' }}>
          <p className="px-3 pt-2 text-xs font-semibold text-gray-500">Saved replies</p>
          <div className="max-h-48 overflow-y-auto">
            {list.length === 0 && <p className="px-3 py-2 text-xs text-gray-400">None yet. Add one below.</p>}
            {list.map((r) => (
              <div key={r.id} className="group flex items-start gap-1 px-1">
                <button
                  type="button"
                  onClick={() => { onInsert(r.body); setOpen(false); }}
                  className="flex-1 min-w-0 text-left px-2 py-1.5 rounded hover:bg-gray-100"
                >
                  <span className="block text-sm text-gray-900 truncate">{r.title}</span>
                  <span className="block text-xs text-gray-500 truncate">{r.body}</span>
                </button>
                <button
                  type="button"
                  onClick={() => update(list.filter((x) => x.id !== r.id))}
                  title={`Delete "${r.title}"`}
                  aria-label={`Delete saved reply ${r.title}`}
                  className="p-1.5 mt-1 text-gray-300 hover:text-red-600"
                >
                  <Trash2 className="w-4 h-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <div className="p-2 space-y-1 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500">Add a saved reply</p>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="Name, e.g. Price list"
              aria-label="Saved reply name"
              className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              placeholder="Reply text"
              aria-label="Saved reply text"
              className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-gray-400 resize-none"
            />
            <button
              type="button"
              onClick={saveCurrent}
              disabled={!canSave}
              title={canSave ? 'Save this reply' : 'Fill in the name and the text'}
              className={`w-full inline-flex items-center justify-center gap-1 px-2 py-1 text-xs font-medium rounded bg-gray-900 text-white ${canSave ? '' : 'opacity-50'}`}
            >
              <BookmarkPlus className="w-4 h-4" aria-hidden />
              Save reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
