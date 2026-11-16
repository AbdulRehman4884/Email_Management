/**
 * src/pages/ScriptFiles.tsx — /scripts
 *
 * Company lists the user shared with the AI agent for script generation.
 * Click a file to open its companies.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { Bot, FileSpreadsheet, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, EmptyState, Modal, PageLoader, useToast } from '../components/ui';
import { scriptsApi } from '../lib/api';
import type { ScriptFileSummary } from '../lib/scripts';

function formatDate(value: string): string {
  const d = new Date(value.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('en-CA');
}

export function ScriptFiles() {
  const toast = useToast();
  const [files, setFiles] = React.useState<ScriptFileSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [toDelete, setToDelete] = React.useState<ScriptFileSummary | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setFiles(await scriptsApi.listFiles());
      setError(null);
    } catch {
      setError('Could not load your files. Please try again.');
      setFiles([]);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await scriptsApi.deleteFile(toDelete.id);
      toast.success('File deleted');
      setToDelete(null);
      await load();
    } catch {
      toast.error('Could not delete the file. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  if (files === null) return <PageLoader />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Scripts</h1>
        <p className="text-gray-500 mt-1">
          Company lists you shared with the AI agent. Open a file, pick a company, and generate its scripts.
        </p>
      </div>

      <Card>
        <CardContent>
          {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
          {files.length === 0 ? (
            <EmptyState
              icon={<FileSpreadsheet className="w-8 h-8 text-gray-400" />}
              title="No files yet"
              description="In AI Agent, attach a CSV or Excel file with Company Name and Website columns and click “Script generation”."
              action={
                <Link to="/agent">
                  <Button leftIcon={<Bot className="w-4 h-4" />}>Go to AI Agent</Button>
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="script-files-table">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">File</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Companies</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Scripts generated</th>
                    <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Uploaded</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4">
                        <Link to={`/scripts/files/${f.id}`} className="flex items-center gap-2 font-medium text-gray-900 text-sm hover:text-black">
                          <FileSpreadsheet className="w-4 h-4 text-gray-400" />
                          {f.filename}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-700">{f.companyCount.toLocaleString()}</td>
                      <td className="py-3 px-4 text-sm text-gray-700">{f.scriptCount.toLocaleString()}</td>
                      <td className="py-3 px-4 text-sm text-gray-500">{formatDate(f.createdAt)}</td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => setToDelete(f)}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete file"
                          aria-label={`Delete ${f.filename}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal isOpen={!!toDelete} onClose={() => setToDelete(null)} title="Delete file">
        <p className="text-gray-600 mb-6">
          Delete <strong>{toDelete?.filename}</strong> with all its companies and generated scripts? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => setToDelete(null)}>Cancel</Button>
          <Button variant="danger" isLoading={deleting} onClick={() => void confirmDelete()}>Delete</Button>
        </div>
      </Modal>
    </div>
  );
}
