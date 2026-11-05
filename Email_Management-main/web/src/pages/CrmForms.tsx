import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ClipboardList, Download, Pencil, Plus, Table2, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, EmptyState, Modal, useToast } from '../components/ui';
import { UpgradePrompt } from '../components/UpgradePrompt';
import { crmApi, apiErrorMessage, type CrmForm, type CrmFormSubmission } from '../lib/api';
import { useCrmEnabled } from '../lib/crmAccess';
import { iconButtonStyle } from '../components/crm/builderStyles';

const PAGE = 50;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Submissions of one form: table (answers as plain text) + CSV export. */
function SubmissionsModal({ form, onClose }: { form: CrmForm; onClose: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<CrmFormSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true);
    crmApi
      .listFormSubmissions(form.id, offset, PAGE)
      .then((r) => {
        setRows(r.submissions);
        setTotal(r.total);
      })
      .catch((e) => toast.error(apiErrorMessage(e, 'Could not load the submissions')))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.id, offset]);

  const columns = form.fields.map((f) => ({ id: f.id, label: f.label }));
  for (const r of rows) for (const a of r.answers) if (!columns.some((c) => c.id === a.fieldId)) columns.push({ id: a.fieldId, label: a.label });

  const exportCsv = async () => {
    setExporting(true);
    try {
      download(await crmApi.exportFormSubmissionsCsv(form.id), `${form.name.replace(/[^\w-]+/g, '-')}-submissions.csv`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not export the submissions'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Submissions · ${form.name}`} size="xl">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-sm text-gray-500">{total} submission{total === 1 ? '' : 's'}</span>
        <Button variant="secondary" size="sm" onClick={() => void exportCsv()} isLoading={exporting} disabled={total === 0} leftIcon={<Download className="w-4 h-4" />}>
          Export CSV
        </Button>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: '60vh' }}>
        <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr className="text-xs text-gray-500" style={{ textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>Submitted</th>
              <th style={{ padding: '6px 8px' }}>Lead</th>
              {columns.map((c) => (
                <th key={c.id} style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{c.label}</th>
              ))}
              <th style={{ padding: '6px 8px' }}>Page</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid #f3f4f6', verticalAlign: 'top' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }} className="text-gray-500">{fmt(r.createdAt)}</td>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                  {r.contactId ? <Link to={`/crm?lead=${r.contactId}`} className="text-indigo-600 hover:underline">{r.email}</Link> : r.email}
                  {r.newLead && <span className="text-xs" style={{ marginLeft: 6, color: '#15803d' }}>new</span>}
                </td>
                {columns.map((c) => (
                  <td key={c.id} style={{ padding: '6px 8px', maxWidth: 260, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {r.answers.find((a) => a.fieldId === c.id)?.value ?? ''}
                  </td>
                ))}
                <td style={{ padding: '6px 8px' }} className="text-gray-500">{r.pageUrl ? new URL(r.pageUrl).pathname : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <p className="text-sm text-gray-400" style={{ padding: 12 }}>No submissions yet.</p>}
      </div>
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
          <span className="text-xs text-gray-500">{offset + 1}–{Math.min(total, offset + PAGE)} of {total}</span>
          <Button variant="ghost" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
        </div>
      )}
    </Modal>
  );
}

/** Step 10: Forms page — every lead capture form with views, submissions, conversion and an on/off switch. */
export function CrmForms() {
  const crmEnabled = useCrmEnabled();
  const toast = useToast();
  const navigate = useNavigate();
  const [forms, setForms] = useState<CrmForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showSubs, setShowSubs] = useState<CrmForm | null>(null);

  const load = useCallback(() => {
    crmApi
      .listForms()
      .then(setForms)
      .catch((e) => setError(apiErrorMessage(e, 'Could not load the forms')));
  }, []);

  useEffect(() => {
    if (crmEnabled) load();
  }, [crmEnabled, load]);

  if (!crmEnabled) return <UpgradePrompt feature="Forms" />;

  const create = async () => {
    setCreating(true);
    try {
      const f = await crmApi.createForm({ name: 'New form', title: 'Get in touch' });
      navigate(`/crm/forms/${f.id}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not create the form'));
      setCreating(false);
    }
  };

  const toggle = async (f: CrmForm) => {
    try {
      const n = await crmApi.updateForm(f.id, { isActive: !f.isActive });
      setForms((list) => (list ?? []).map((x) => (x.id === n.id ? n : x)));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not change the form'));
    }
  };

  const remove = async (f: CrmForm) => {
    if (!window.confirm(`Delete "${f.name}"? Its ${f.submissions} submission(s) are deleted too. Leads stay in the CRM.`)) return;
    try {
      await crmApi.deleteForm(f.id);
      setForms((list) => (list ?? []).filter((x) => x.id !== f.id));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not delete the form'));
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Forms</h1>
          <p className="text-gray-500 mt-1 text-sm">Lead capture forms for your website. New submissions become CRM leads.</p>
        </div>
        <Button onClick={() => void create()} isLoading={creating} leftIcon={<Plus className="w-4 h-4" />}>New form</Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {forms && forms.length === 0 ? (
        <EmptyState
          icon={<ClipboardList className="w-8 h-8 text-gray-400" />}
          title="No forms yet"
          description="Create a form, then add it to your website, show it as a popup or share its link."
        />
      ) : (
        <Card>
          <CardContent className="py-2">
            <div style={{ overflowX: 'auto' }}>
              <table className="text-sm" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="text-xs text-gray-500" style={{ textAlign: 'left' }}>
                    <th style={{ padding: '10px 8px' }}>Form</th>
                    <th style={{ padding: '10px 8px' }}>On</th>
                    <th style={{ padding: '10px 8px', textAlign: 'right' }}>Views</th>
                    <th style={{ padding: '10px 8px', textAlign: 'right' }}>Submissions</th>
                    <th style={{ padding: '10px 8px', textAlign: 'right' }}>Conversion</th>
                    <th style={{ padding: '10px 8px' }}>Last submission</th>
                    <th style={{ padding: '10px 8px' }} />
                  </tr>
                </thead>
                <tbody>
                  {(forms ?? []).map((f) => (
                    <tr key={f.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 8px' }}>
                        <Link to={`/crm/forms/${f.id}`} className="font-medium text-gray-900 hover:underline">{f.name}</Link>
                        {!f.isActive && <span className="text-xs text-gray-400" style={{ marginLeft: 6 }}>closed</span>}
                      </td>
                      <td style={{ padding: '10px 8px' }}>
                        <input type="checkbox" aria-label={`${f.name} on`} checked={f.isActive} onChange={() => void toggle(f)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }}>{f.views.toLocaleString()}</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }}>{f.submissions.toLocaleString()}</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }}>{f.conversion == null ? '—' : `${f.conversion}%`}</td>
                      <td style={{ padding: '10px 8px' }} className="text-gray-500">{fmt(f.lastSubmissionAt)}</td>
                      <td style={{ padding: '10px 8px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button type="button" title="Submissions" aria-label="Submissions" onClick={() => setShowSubs(f)} style={iconButtonStyle}><Table2 size={15} /></button>{' '}
                        <Link to={`/crm/forms/${f.id}`} title="Edit" aria-label="Edit" style={iconButtonStyle}><Pencil size={15} /></Link>{' '}
                        <button type="button" title="Delete" aria-label="Delete" onClick={() => void remove(f)} style={iconButtonStyle}><Trash2 size={15} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {showSubs && <SubmissionsModal form={showSubs} onClose={() => setShowSubs(null)} />}
    </div>
  );
}
