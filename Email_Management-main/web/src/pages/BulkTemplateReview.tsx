import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, Download, RefreshCcw, Search, X } from 'lucide-react';
import { bulkApi, type BulkTemplate } from '../lib/api';
import { Button, Card, CardContent, CardHeader, TextArea, Input } from '../components/ui';

export function BulkTemplateReview() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const numericJobId = Number(jobId);
  const [templates, setTemplates] = React.useState<BulkTemplate[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [templateType, setTemplateType] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [approvingAll, setApprovingAll] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!numericJobId) return;
    setLoading(true);
    try {
      const response = await bulkApi.getTemplates(numericJobId, { page, limit: 10, search, status, templateType });
      setTemplates(response.templates);
      setTotal(response.total);
    } finally {
      setLoading(false);
    }
  }, [numericJobId, page, search, status, templateType]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bulk-templates-${numericJobId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Template Review</h1>
          <p className="mt-1 text-sm text-gray-600">Review, edit, approve, or reject generated executive templates before campaign creation.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" leftIcon={<Download className="h-4 w-4" />} onClick={exportJson}>Export page</Button>
          <Button
            variant="secondary"
            isLoading={approvingAll}
            onClick={async () => {
              setApprovingAll(true);
              try {
                await bulkApi.approveTemplates(numericJobId, { mode: 'all' });
                await load();
              } finally {
                setApprovingAll(false);
              }
            }}
          >
            Approve all
          </Button>
          <Button onClick={() => navigate(`/bulk/${numericJobId}/approve`)}>Create campaign draft</Button>
        </div>
      </div>

      <Card>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-[1fr_190px_220px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <Input className="pl-9" placeholder="Search company" value={search} onChange={(event) => {
                setPage(1);
                setSearch(event.target.value);
              }} />
            </div>
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={status}
              onChange={(event) => {
                setPage(1);
                setStatus(event.target.value);
              }}
            >
              <option value="">All statuses</option>
              <option value="pending_review">Pending review</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={templateType}
              onChange={(event) => {
                setPage(1);
                setTemplateType(event.target.value);
              }}
            >
              <option value="">All template types</option>
              <option value="executive_consultative">Executive Consultative</option>
              <option value="enterprise_transformation">Enterprise Transformation</option>
              <option value="fintech_compliance">Fintech Compliance</option>
              <option value="product_engineering_delivery">Product Engineering</option>
              <option value="cfo_finance_visibility">CFO Finance Visibility</option>
              <option value="ai_automation">AI Automation</option>
              <option value="operational_visibility">Operational Visibility</option>
              <option value="revops_pipeline">RevOps</option>
            </select>
            <Button variant="secondary" onClick={() => void load()} isLoading={loading}>Refresh</Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-5">
        {templates.map((template) => (
          <TemplateCard key={template.id} template={template} onSaved={load} />
        ))}
        {templates.length === 0 && (
          <Card>
            <CardContent>
              <p className="text-sm text-gray-600">No templates match this filter yet.</p>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">Showing page {page} of {Math.max(1, Math.ceil(total / 10))}</p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button variant="secondary" disabled={page >= Math.ceil(total / 10)} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ template, onSaved }: { template: BulkTemplate; onSaved: () => void | Promise<void> }) {
  const [draft, setDraft] = React.useState(template);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => setDraft(template), [template]);

  const save = async (status?: string) => {
    setSaving(true);
    try {
      await bulkApi.updateTemplate(template.id, {
        subject: draft.subject,
        body: draft.body,
        followup1: draft.followup1,
        followup2: draft.followup2,
        cta: draft.cta,
        status: status ?? draft.status,
      });
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="overflow-visible">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-lg font-semibold text-gray-900">{template.company || 'Company'}</h2>
            <p className="mt-1 break-words text-sm text-gray-600">{template.email} · {template.persona}</p>
            <p className="mt-1 break-words text-xs text-gray-500">
              {template.templateName || template.selectedTemplateId || 'Selected template'}
              {template.selectedTone ? ` • ${template.selectedTone}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">{Math.round(template.confidence * 100)}% confidence</span>
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">{template.status}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <LabeledInput label="Subject" value={draft.subject} onChange={(value) => setDraft({ ...draft, subject: value })} />
        <LabeledArea label="Email Body" value={draft.body} onChange={(value) => setDraft({ ...draft, body: value })} />
        <LabeledArea label="Follow-up 1" value={draft.followup1} onChange={(value) => setDraft({ ...draft, followup1: value })} />
        <LabeledArea label="Follow-up 2" value={draft.followup2} onChange={(value) => setDraft({ ...draft, followup2: value })} />
        <LabeledInput label="CTA" value={draft.cta} onChange={(value) => setDraft({ ...draft, cta: value })} />
        {template.rationale && (
          <details className="rounded-lg border border-gray-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-gray-900">Supporting rationale</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-600">{template.rationale}</p>
          </details>
        )}
        {template.missingDataWarnings && template.missingDataWarnings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Warnings: {template.missingDataWarnings.join(', ')}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button isLoading={saving} onClick={() => save()}>Save edits</Button>
          <Button variant="secondary" leftIcon={<Check className="h-4 w-4" />} onClick={() => save('approved')}>Approve</Button>
          <Button
            variant="secondary"
            leftIcon={<RefreshCcw className="h-4 w-4" />}
            onClick={async () => {
              setSaving(true);
              try {
                await bulkApi.regenerateTemplate(template.id);
                await onSaved();
              } finally {
                setSaving(false);
              }
            }}
          >
            Regenerate
          </Button>
          <Button variant="danger" leftIcon={<X className="h-4 w-4" />} onClick={() => save('rejected')}>Reject</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <Input className="mt-1 w-full" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function LabeledArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <TextArea className="mt-1 min-h-32 w-full whitespace-pre-wrap" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
