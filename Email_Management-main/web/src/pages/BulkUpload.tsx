import React from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud, FileSpreadsheet } from 'lucide-react';
import { bulkApi, type BulkUploadResponse } from '../lib/api';
import { Button, Card, CardContent, CardHeader, Input, TextArea } from '../components/ui';

export function BulkUpload() {
  const navigate = useNavigate();
  const [file, setFile] = React.useState<File | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [isUploading, setIsUploading] = React.useState(false);
  const [result, setResult] = React.useState<BulkUploadResponse | null>(null);
  const [templateMode, setTemplateMode] = React.useState<'recommended' | 'global'>('recommended');
  const [globalTemplate, setGlobalTemplate] = React.useState('executive_consultative');
  const [tone, setTone] = React.useState('professional_soft');
  const [ctaStyle, setCtaStyle] = React.useState('strategic_review');
  const [customInstructions, setCustomInstructions] = React.useState('');
  const [isConfiguring, setIsConfiguring] = React.useState(false);
  const [error, setError] = React.useState('');

  const handleFile = (nextFile: File | undefined | null) => {
    if (!nextFile) return;
    const lower = nextFile.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      setError('Upload a CSV, XLSX, or XLS file.');
      return;
    }
    setError('');
    setFile(nextFile);
  };

  const upload = async () => {
    if (!file) return;
    setIsUploading(true);
    setError('');
    try {
      const response = await bulkApi.upload(file);
      setGlobalTemplate(response.detectedGroups?.[0]?.recommendedTemplate ?? 'executive_consultative');
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const startGeneration = async () => {
    if (!result) return;
    setIsConfiguring(true);
    setError('');
    try {
      const industryTemplateMap = templateMode === 'recommended'
        ? Object.fromEntries((result.detectedGroups ?? []).map((group) => [group.group, group.recommendedTemplate]))
        : {};
      await bulkApi.configureTemplateStrategy(result.jobId, {
        globalTemplate,
        globalTone: tone,
        globalCTAStyle: ctaStyle,
        industryTemplateMap,
        userCustomizationInstructions: customInstructions,
      });
      navigate(`/bulk/${result.jobId}/progress`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template strategy.');
    } finally {
      setIsConfiguring(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Bulk Campaign Intelligence</h1>
        <p className="mt-1 text-sm text-gray-600">
          Upload CSV/XLSX leads, validate records, and generate executive outreach templates before creating a draft campaign.
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Upload Leads</h2>
        </CardHeader>
        <CardContent>
          <div
            className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
              isDragging ? 'border-gray-900 bg-gray-50' : 'border-gray-300'
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              handleFile(event.dataTransfer.files[0]);
            }}
          >
            <UploadCloud className="mx-auto h-10 w-10 text-gray-500" />
            <p className="mt-3 text-sm font-medium text-gray-900">Drop a CSV/XLSX file here</p>
            <p className="mt-1 text-xs text-gray-500">Supported columns: name, email, company, website, role, industry</p>
            <label className="mt-4 inline-flex cursor-pointer">
              <input
                className="hidden"
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
              <span className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white">Choose file</span>
            </label>
          </div>

          {file && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <FileSpreadsheet className="h-5 w-5 flex-shrink-0 text-gray-500" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{file.name}</p>
                  <p className="text-xs text-gray-500">{Math.ceil(file.size / 1024)} KB</p>
                </div>
              </div>
              <Button onClick={upload} isLoading={isUploading}>Validate leads</Button>
            </div>
          )}

          {error && <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Validation Summary</h2>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-4">
              <Metric label="Total rows" value={result.summary.totalRows} />
              <Metric label="Valid" value={result.summary.valid} />
              <Metric label="Duplicates" value={result.summary.duplicates} />
              <Metric label="Invalid" value={result.summary.invalid} />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">Detected columns</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {result.columns.map((column) => (
                  <span key={column} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                    {column}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-900">First 10 rows</p>
              <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                    <tr>
                      {['name', 'email', 'company', 'website', 'role', 'industry'].map((column) => (
                        <th key={column} className="px-3 py-2">{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {result.previewRows.map((row, index) => (
                      <tr key={index}>
                        {['name', 'email', 'company', 'website', 'role', 'industry'].map((column) => (
                          <td key={column} className="max-w-xs break-words px-3 py-2 text-gray-700">
                            {String(row[column] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={startGeneration} isLoading={isConfiguring}>Save strategy and generate templates</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900">Template Strategy</h2>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              I found {result.summary.valid} valid leads. Before generating emails, select one strategy. This applies across rows, so you will not be asked template choices one row at a time.
            </div>
            {result.detectedGroups && result.detectedGroups.length > 0 && (
              <div>
                <p className="text-sm font-medium text-gray-900">Detected groups and recommendations</p>
                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  {result.detectedGroups.map((group) => (
                    <div key={group.group} className="rounded-lg border border-gray-200 p-3 text-sm">
                      <p className="font-medium text-gray-900">{group.group.replace(/_/g, ' ')}</p>
                      <p className="text-gray-600">{group.count} rows → {templateName(result, group.recommendedTemplate)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="radio" checked={templateMode === 'recommended'} onChange={() => setTemplateMode('recommended')} />
                Apply recommended templates by industry
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="radio" checked={templateMode === 'global'} onChange={() => setTemplateMode('global')} />
                Use one global template
              </label>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Global template</span>
                <select className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" value={globalTemplate} onChange={(event) => setGlobalTemplate(event.target.value)}>
                  {(result.templateOptions ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Tone</span>
                <Input className="mt-1" value={tone} onChange={(event) => setTone(event.target.value)} />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">CTA style</span>
                <Input className="mt-1" value={ctaStyle} onChange={(event) => setCtaStyle(event.target.value)} />
              </label>
            </div>
            <TextArea
              className="min-h-24"
              placeholder="Optional customization, e.g. make the tone softer, remove AI mentions, add finance angle..."
              value={customInstructions}
              onChange={(event) => setCustomInstructions(event.target.value)}
            />
            <div className="grid gap-3 md:grid-cols-2">
              {(result.templateOptions ?? []).map((option) => (
                <div key={option.id} className="rounded-lg border border-gray-200 p-3 text-sm">
                  <p className="font-medium text-gray-900">{option.name}</p>
                  <p className="mt-1 text-gray-600">Best for: {option.bestFor}</p>
                  <p className="text-gray-600">Buyer: {option.typicalBuyer}</p>
                  <p className="text-gray-600">CTA: {option.ctaStyle}</p>
                </div>
              ))}
            </div>
            <Button onClick={startGeneration} isLoading={isConfiguring}>Generate templates in batches</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function templateName(result: BulkUploadResponse, id: string) {
  return result.templateOptions?.find((option) => option.id === id)?.name ?? id;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}
