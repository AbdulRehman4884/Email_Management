/**
 * AI Agent Library: files attached in the AI Agent chat (150 MB per user; the oldest go first).
 */
import api from './api';

export interface LibraryFile {
  id: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sessionId: string | null;
  createdAt: string;
}

export interface LibraryList {
  files: LibraryFile[];
  usedBytes: number;
  limitBytes: number;
}

export const libraryApi = {
  list: async (opts: { search?: string; type?: 'csv' | 'excel' } = {}): Promise<LibraryList> => {
    const params: Record<string, string> = {};
    if (opts.search?.trim()) params.search = opts.search.trim();
    if (opts.type) params.type = opts.type;
    return (await api.get<LibraryList>('/agent-library', { params })).data;
  },
  /** Saves a file attached in the chat. Never throws: the chat works the same when this fails. */
  save: async (file: File, sessionId?: string): Promise<{ removed: string[] } | null> => {
    try {
      const form = new FormData();
      form.append('file', file);
      if (sessionId) form.append('sessionId', sessionId);
      // Override the instance's JSON default (the browser fills in the multipart boundary).
      const { data } = await api.post<{ removed: string[] }>('/agent-library', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      return { removed: Array.isArray(data?.removed) ? data.removed : [] };
    } catch {
      return null;
    }
  },
  /** The file itself (for Download and "Use in chat"). */
  blob: async (id: number): Promise<Blob> => (await api.get(`/agent-library/${id}/download`, { responseType: 'blob' })).data as Blob,
  remove: async (id: number): Promise<void> => {
    await api.delete(`/agent-library/${id}`);
  },
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
