import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileSpreadsheet, MessageSquarePlus, Search, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, useToast } from '../components/ui';
import { formatBytes, libraryApi, type LibraryFile, type LibraryList } from '../lib/libraryApi';

type Filter = 'all' | 'csv' | 'excel';
const FILTERS: Array<{ value: Filter; name: string }> = [
  { value: 'all', name: 'All' },
  { value: 'csv', name: 'CSV' },
  { value: 'excel', name: 'Excel' },
];

const errorText = (e: unknown, fallback: string) => {
  const msg = (e as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof msg === 'string' && msg.trim() ? msg : fallback;
};

const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** Every file attached in the AI Agent chat (150 MB per user; the oldest are removed first). */
export function Library() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<LibraryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async (q: string, f: Filter) => {
    try {
      setData(await libraryApi.list({ search: q, ...(f === 'all' ? {} : { type: f }) }));
      setError(null);
    } catch (e) {
      setError(errorText(e, 'Could not load your Library'));
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => void load(search, filter), search ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [search, filter, load]);

  const download = async (f: LibraryFile) => {
    setBusyId(f.id);
    try {
      const blob = await libraryApi.blob(f.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(errorText(e, 'Could not download the file'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (f: LibraryFile) => {
    if (!window.confirm(`Delete "${f.fileName}" from your Library? This cannot be undone.`)) return;
    setBusyId(f.id);
    try {
      await libraryApi.remove(f.id);
      toast.success('File deleted');
      await load(search, filter);
    } catch (e) {
      toast.error(errorText(e, 'Could not delete the file'));
    } finally {
      setBusyId(null);
    }
  };

  const used = data ? Math.min(100, Math.round((data.usedBytes / data.limitBytes) * 100)) : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Library</h1>
        <p className="text-sm text-gray-500">Files you attached in the AI Agent chat. Use one again in a chat, download or delete it.</p>
      </div>

      <Card>
        <CardContent className="py-4 space-y-4">
          {data && (
            <div data-testid="library-usage">
              <div className="flex justify-between text-sm text-gray-700">
                <span>{formatBytes(data.usedBytes)} of {formatBytes(data.limitBytes)} used</span>
                <span className="text-gray-500">Over the limit, the oldest files are deleted first.</span>
              </div>
              <div className="h-2 mt-1 rounded bg-gray-200 overflow-hidden">
                <div className="h-full bg-gray-900" style={{ width: `${used}%` }} />
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
            <div className="flex gap-2" role="tablist" aria-label="File type">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={`px-3 py-1.5 rounded-full text-sm min-h-[36px] ${filter === f.value ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  {f.name}
                </button>
              ))}
            </div>
            <label className="relative sm:w-72">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
              <input
                type="search"
                aria-label="Search files"
                placeholder="Search files…"
                value={search}
                maxLength={100}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
            </label>
          </div>

          {error ? (
            <p className="text-sm text-red-600" role="alert">{error}</p>
          ) : !data ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : data.files.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="library-empty">
              {search.trim() || filter !== 'all' ? 'No files match.' : 'No files yet. Files you attach in the AI Agent chat (📎) appear here.'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {data.files.map((f) => (
                <li key={f.id} className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-3" data-testid="library-file">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <FileSpreadsheet className="w-5 h-5 text-green-700 flex-shrink-0" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate" title={f.fileName}>{f.fileName}</p>
                      <p className="text-xs text-gray-500">{formatBytes(f.sizeBytes)} · {dateText(f.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<MessageSquarePlus className="w-4 h-4" />}
                      onClick={() => navigate('/agent', { state: { libraryFile: { id: f.id, fileName: f.fileName } } })}
                    >
                      Use in chat
                    </Button>
                    <Button size="sm" variant="outline" aria-label={`Download ${f.fileName}`} leftIcon={<Download className="w-4 h-4" />} onClick={() => void download(f)} disabled={busyId === f.id}>
                      Download
                    </Button>
                    <Button size="sm" variant="outline" aria-label={`Delete ${f.fileName}`} leftIcon={<Trash2 className="w-4 h-4" />} onClick={() => void remove(f)} disabled={busyId === f.id}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
