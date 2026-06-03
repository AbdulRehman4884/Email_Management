import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { RefreshCcw } from 'lucide-react';
import { bulkApi, type BulkStatusResponse } from '../lib/api';
import { Button, Card, CardContent, CardHeader } from '../components/ui';

export function BulkProgress() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const numericJobId = Number(jobId);
  const [status, setStatus] = React.useState<BulkStatusResponse | null>(null);
  const [error, setError] = React.useState('');
  const [isRetrying, setIsRetrying] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!numericJobId) return;
    try {
      setStatus(await bulkApi.getStatus(numericJobId));
      setError('');
    } catch {
      setError('Unable to load bulk progress.');
    }
  }, [numericJobId]);

  React.useEffect(() => {
    void load();
    const timer = window.setInterval(load, 2500);
    return () => window.clearInterval(timer);
  }, [load]);

  const percent = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Bulk Processing Progress</h1>
        <p className="mt-1 text-sm text-gray-600">Templates are generated in safe backend batches after template selection. No campaign is created or sent here.</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Job #{numericJobId}</h2>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium uppercase tracking-wide text-gray-700">
              {status?.status ?? 'loading'}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <div className="flex justify-between text-sm text-gray-600">
              <span>{status?.processed ?? 0} processed</span>
              <span>{percent}%</span>
            </div>
            <div className="mt-2 h-3 overflow-hidden rounded-full bg-gray-200">
              <div className="h-full rounded-full bg-gray-900 transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Metric label="Total valid" value={status?.total ?? 0} />
            <Metric label="Processed" value={status?.processed ?? 0} />
            <Metric label="Failed" value={status?.failed ?? 0} />
            <Metric label="Remaining" value={status?.remaining ?? 0} />
          </div>
          <div className="flex flex-wrap gap-3">
            {status?.status === 'awaiting_template_selection' && (
              <Button onClick={() => navigate('/bulk')}>Select template strategy</Button>
            )}
            <Button onClick={() => navigate(`/bulk/${numericJobId}/templates`)}>Review templates</Button>
            <Button
              variant="secondary"
              leftIcon={<RefreshCcw className="h-4 w-4" />}
              isLoading={isRetrying}
              onClick={async () => {
                setIsRetrying(true);
                try {
                  await bulkApi.retry(numericJobId);
                  await load();
                } finally {
                  setIsRetrying(false);
                }
              }}
            >
              Retry failed rows
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}
