/**
 * src/pages/ScriptFileCompanies.tsx — /scripts/files/:fileId?page=N
 *
 * Companies in one uploaded file, 50 per page. Click a company to open its
 * script page.
 */

import React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { Button, Card, CardContent, PageLoader } from '../components/ui';
import { scriptsApi } from '../lib/api';
import { SCRIPT_TYPES, SCRIPT_TYPE_META, displayHost, type ScriptCompaniesPage } from '../lib/scripts';

export const COMPANIES_PAGE_SIZE = 50;

export function ScriptFileCompanies() {
  const { fileId: fileIdParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const fileId = Number(fileIdParam);
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const [data, setData] = React.useState<ScriptCompaniesPage | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    scriptsApi
      .listCompanies(fileId, page, COMPANIES_PAGE_SIZE)
      .then((res) => { if (!cancelled) { setData(res); setError(null); } })
      .catch(() => { if (!cancelled) setError('Could not load this file. It may have been deleted.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fileId, page]);

  const goTo = (p: number) => setSearchParams({ page: String(p) });

  if (loading && !data) return <PageLoader />;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link to="/scripts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft className="w-4 h-4" /> All files
        </Link>
        <p className="text-sm text-red-600">{error ?? 'File not found.'}</p>
      </div>
    );
  }

  const first = (data.page - 1) * data.limit + 1;
  const last = Math.min(data.page * data.limit, data.total);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/scripts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft className="w-4 h-4" /> All files
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">{data.file.filename}</h1>
        <p className="text-gray-500 mt-1">
          {data.total.toLocaleString()} companies · pick one to generate its scripts
        </p>
      </div>

      <Card>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="script-companies-table">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Row</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Company</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Website</th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wider">Scripts</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors" data-testid="script-company-row">
                    <td className="py-2.5 px-4 text-sm text-gray-400">{c.rowNumber}</td>
                    <td className="py-2.5 px-4">
                      <Link to={`/scripts/companies/${c.id}`} className="font-medium text-gray-900 text-sm hover:underline">
                        {c.companyName}
                      </Link>
                    </td>
                    <td className="py-2.5 px-4">
                      <a href={c.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline">
                        {displayHost(c.website)} <ExternalLink className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex gap-1">
                        {SCRIPT_TYPES.map((t) => {
                          const done = c.scriptTypes.includes(t);
                          return (
                            <span
                              key={t}
                              title={done ? `${SCRIPT_TYPE_META[t].label} ready` : `No ${SCRIPT_TYPE_META[t].label.toLowerCase()} yet`}
                              className={`text-xs px-2 py-0.5 rounded-full ${done ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}
                            >
                              {SCRIPT_TYPE_META[t].short}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between gap-3 pt-4">
            <span className="text-sm text-gray-500" data-testid="companies-range">
              {data.total === 0 ? 'No companies' : `${first.toLocaleString()}–${last.toLocaleString()} of ${data.total.toLocaleString()}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={data.page <= 1 || loading}
                onClick={() => goTo(data.page - 1)}
                leftIcon={<ChevronLeft className="w-4 h-4" />}
                data-testid="prev-page"
              >
                Previous
              </Button>
              <span className="text-sm text-gray-600">Page {data.page} of {data.totalPages}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page >= data.totalPages || loading}
                onClick={() => goTo(data.page + 1)}
                rightIcon={<ChevronRight className="w-4 h-4" />}
                data-testid="next-page"
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
