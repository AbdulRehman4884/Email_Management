import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Copy, ExternalLink, Plus, Save, X } from 'lucide-react';
import { Button, Card, CardContent, useToast } from '../components/ui';
import { UpgradePrompt } from '../components/UpgradePrompt';
import {
  crmApi,
  settingsApi,
  apiErrorMessage,
  type CrmForm,
  type CrmFormField,
  type CrmFormFieldType,
  type CrmFormSettings,
  type CrmPipelineSummary,
  type CrmStage,
  type SmtpSettingsResponse,
} from '../lib/api';
import { useCrmEnabled } from '../lib/crmAccess';
import { useCrmTags } from '../lib/useCrmTags';
import { useCampaignStore } from '../store';
import { controlStyle, iconButtonStyle, smallControlStyle } from '../components/crm/builderStyles';

const TYPE_NAME: Record<CrmFormFieldType, string> = {
  email: 'Email',
  name: 'Name',
  company: 'Company',
  phone: 'Phone',
  message: 'Message',
  text: 'Text',
  number: 'Number',
  dropdown: 'Dropdown',
};
const BUILT_IN: CrmFormFieldType[] = ['name', 'company', 'phone', 'message'];
const CUSTOM: CrmFormFieldType[] = ['text', 'number', 'dropdown'];

const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', margin: '10px 0 4px' };
const full: React.CSSProperties = { ...controlStyle, width: '100%' };

function settingsOf(f: CrmForm): CrmFormSettings {
  return {
    name: f.name,
    isActive: f.isActive,
    title: f.title,
    description: f.description,
    fields: f.fields,
    design: f.design,
    successMessage: f.successMessage,
    consentEnabled: f.consentEnabled,
    consentText: f.consentText,
    pipelineId: f.pipelineId,
    stageId: f.stageId,
    tagIds: f.tagIds,
    thankYouEnabled: f.thankYouEnabled,
    thankYouSmtpSettingsId: f.thankYouSmtpSettingsId,
    thankYouSubject: f.thankYouSubject,
    thankYouBody: f.thankYouBody,
    notifyEnabled: f.notifyEnabled,
    notifyEmail: f.notifyEmail,
    captchaProvider: f.captchaProvider,
    captchaSiteKey: f.captchaSiteKey,
    addToCampaignId: f.addToCampaignId,
  };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="py-4">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {children}
      </CardContent>
    </Card>
  );
}

function Snippet({ title, code, hint }: { title: string; code: string; hint?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <span style={label}>{title}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        <code className="text-xs" style={{ flex: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'pre', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px' }}>
          {code}
        </code>
        <button
          type="button"
          aria-label={`Copy ${title}`}
          style={iconButtonStyle}
          onClick={() =>
            navigator.clipboard.writeText(code).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => toast.error('Copy failed: select the code and copy it by hand')
            )
          }
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

function FieldRow({ field, first, last, onChange, onMove, onRemove }: {
  field: CrmFormField; first: boolean; last: boolean;
  onChange: (f: CrmFormField) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  const [options, setOptions] = useState((field.options ?? []).join(', '));
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="text-xs font-semibold text-gray-500" style={{ width: 70 }}>{TYPE_NAME[field.type]}</span>
        <input aria-label="Field label" value={field.label} onChange={(e) => onChange({ ...field, label: e.target.value })} style={{ ...smallControlStyle, flex: 1, minWidth: 120 }} />
        <label className="text-xs text-gray-600 flex items-center gap-1">
          <input type="checkbox" checked={field.required} disabled={field.type === 'email'} onChange={(e) => onChange({ ...field, required: e.target.checked })} />
          Required
        </label>
        <button type="button" aria-label="Move up" disabled={first} onClick={() => onMove(-1)} style={iconButtonStyle}><ArrowUp size={13} /></button>
        <button type="button" aria-label="Move down" disabled={last} onClick={() => onMove(1)} style={iconButtonStyle}><ArrowDown size={13} /></button>
        {field.type !== 'email' && <button type="button" aria-label="Remove field" onClick={onRemove} style={iconButtonStyle}><X size={13} /></button>}
      </div>
      <input
        aria-label="Placeholder"
        placeholder={field.type === 'dropdown' ? 'First choice text (optional), e.g. Choose…' : 'Placeholder (optional)'}
        value={field.placeholder ?? ''}
        onChange={(e) => onChange({ ...field, placeholder: e.target.value || undefined })}
        style={{ ...smallControlStyle, width: '100%', marginTop: 6 }}
      />
      {field.type === 'dropdown' && (
        <input
          aria-label="Options"
          placeholder="Options, separated by commas"
          value={options}
          onChange={(e) => {
            setOptions(e.target.value);
            onChange({ ...field, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) });
          }}
          style={{ ...smallControlStyle, width: '100%', marginTop: 6 }}
        />
      )}
    </div>
  );
}

/** Step 10: form builder with live preview, and the three ways to publish (embed, popup, hosted link). */
export function CrmFormBuilder() {
  const crmEnabled = useCrmEnabled();
  const toast = useToast();
  const id = Number(useParams().id);
  const [form, setForm] = useState<CrmForm | null>(null);
  const [s, setS] = useState<CrmFormSettings | null>(null);
  const [secret, setSecret] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<CrmPipelineSummary[]>([]);
  const [stages, setStages] = useState<CrmStage[]>([]);
  const [smtps, setSmtps] = useState<SmtpSettingsResponse[]>([]);
  const { tags } = useCrmTags(crmEnabled);
  const { campaigns, fetchCampaigns } = useCampaignStore();
  const previewRef = useRef<HTMLIFrameElement>(null);
  const [previewHeight, setPreviewHeight] = useState(480);

  useEffect(() => {
    if (!crmEnabled || !Number.isInteger(id)) return;
    crmApi
      .getForm(id)
      .then((f) => {
        setForm(f);
        setS(settingsOf(f));
      })
      .catch((e) => setError(apiErrorMessage(e, 'Could not load the form')));
    crmApi.getPipelines().then(setPipelines).catch(() => undefined);
    settingsApi.listSmtpProfiles().then((r) => setSmtps(r.profiles)).catch(() => undefined);
    void fetchCampaigns().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmEnabled, id]);

  const pipelineId = s?.pipelineId ?? pipelines.find((p) => p.isDefault)?.id ?? pipelines[0]?.id;
  useEffect(() => {
    if (!pipelineId) return;
    crmApi.getPipeline(pipelineId).then((p) => setStages(p.stages)).catch(() => setStages([]));
  }, [pipelineId]);

  const previewUrl = form ? form.urls.script.replace(/\/f\.js$/, '/f/preview') : '';
  const previewOrigin = previewUrl ? new URL(previewUrl).origin : '';
  const previewConfig = useMemo(
    () =>
      s && {
        title: s.title,
        description: s.description,
        fields: s.fields,
        design: s.design,
        consentEnabled: s.consentEnabled,
        consentText: s.consentText,
        captcha: null,
        closed: !s.isActive,
      },
    [s]
  );
  const sendPreview = useCallback(() => {
    if (previewConfig && previewOrigin) previewRef.current?.contentWindow?.postMessage({ mfPreview: previewConfig }, previewOrigin);
  }, [previewConfig, previewOrigin]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== previewOrigin || e.source !== previewRef.current?.contentWindow) return;
      if (e.data?.mfPreviewReady) sendPreview();
      if (e.data?.mfForm === 'preview' && typeof e.data.h === 'number') setPreviewHeight(Math.max(200, e.data.h));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [previewOrigin, sendPreview]);
  useEffect(sendPreview, [sendPreview]);

  if (!crmEnabled) return <UpgradePrompt feature="Forms" />;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!form || !s) return <p className="text-sm text-gray-400">Loading…</p>;

  const set = (patch: Partial<CrmFormSettings>) => {
    setS({ ...s, ...patch });
    setDirty(true);
  };
  const setField = (i: number, f: CrmFormField) => set({ fields: s.fields.map((x, j) => (j === i ? f : x)) });
  const moveField = (i: number, dir: -1 | 1) => {
    const list = [...s.fields];
    [list[i], list[i + dir]] = [list[i + dir]!, list[i]!];
    set({ fields: list });
  };
  const addField = (type: CrmFormFieldType) => {
    const fid = BUILT_IN.includes(type) ? type : `${type}_${Math.random().toString(36).slice(2, 8)}`;
    const field: CrmFormField = { id: fid, type, label: TYPE_NAME[type], required: false };
    if (type === 'dropdown') field.options = ['Option 1', 'Option 2'];
    set({ fields: [...s.fields, field] });
  };

  const save = async () => {
    setSaving(true);
    try {
      const f = await crmApi.updateForm(form.id, { ...s, ...(secret ? { captchaSecretKey: secret } : {}) });
      setForm(f);
      setS(settingsOf(f));
      setSecret('');
      setDirty(false);
      toast.success('Form saved');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the form'));
    } finally {
      setSaving(false);
    }
  };

  const delay = s.design.popupDelaySeconds;
  const embedCode = `<script src="${form.urls.script}" data-form="${form.formKey}" async></script>`;
  const popupCode =
    `<script src="${form.urls.script}" data-form="${form.formKey}" data-mode="popup"${delay != null ? ` data-delay="${delay}"` : ''} async></script>\n` +
    `<button data-mailflow-open="${form.formKey}">${s.design.buttonText}</button>`;
  const openCampaigns = campaigns.filter((c) => c.status !== 'completed' && c.status !== 'cancelled');

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/crm/forms" className="text-gray-500 hover:text-gray-900" aria-label="Back to forms"><ArrowLeft className="w-5 h-5" /></Link>
        <input aria-label="Form name" value={s.name} onChange={(e) => set({ name: e.target.value })} style={{ ...controlStyle, fontSize: 18, fontWeight: 700, flex: 1, minWidth: 200 }} />
        <label className="text-sm text-gray-700 flex items-center gap-2">
          <input type="checkbox" checked={s.isActive} onChange={(e) => set({ isActive: e.target.checked })} style={{ width: 16, height: 16 }} />
          Form on
        </label>
        <Button onClick={() => void save()} isLoading={saving} disabled={!dirty} leftIcon={<Save className="w-4 h-4" />}>Save</Button>
      </div>
      {dirty && <p className="text-xs" style={{ color: '#b45309' }}>Unsaved changes: the preview shows them, your website gets them after you save.</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="space-y-4">
          <Section title="Text">
            <span style={label}>Title</span>
            <input value={s.title ?? ''} onChange={(e) => set({ title: e.target.value || null })} style={full} />
            <span style={label}>Description</span>
            <textarea rows={2} value={s.description ?? ''} onChange={(e) => set({ description: e.target.value || null })} style={{ ...full, height: 'auto', padding: 8 }} />
            <span style={label}>Message after submit</span>
            <input value={s.successMessage ?? ''} placeholder="Thank you! We will be in touch soon." onChange={(e) => set({ successMessage: e.target.value || null })} style={full} />
          </Section>

          <Section title="Fields">
            {s.fields.map((f, i) => (
              <FieldRow
                key={f.id}
                field={f}
                first={i === 0}
                last={i === s.fields.length - 1}
                onChange={(n) => setField(i, n)}
                onMove={(dir) => moveField(i, dir)}
                onRemove={() => set({ fields: s.fields.filter((_, j) => j !== i) })}
              />
            ))}
            <div className="flex flex-wrap gap-2 mt-3">
              {BUILT_IN.filter((t) => !s.fields.some((f) => f.type === t)).map((t) => (
                <Button key={t} variant="secondary" size="sm" onClick={() => addField(t)} leftIcon={<Plus className="w-3 h-3" />}>{TYPE_NAME[t]}</Button>
              ))}
              {CUSTOM.map((t) => (
                <Button key={t} variant="ghost" size="sm" onClick={() => addField(t)} leftIcon={<Plus className="w-3 h-3" />}>{TYPE_NAME[t]}</Button>
              ))}
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-700 mt-4">
              <input type="checkbox" checked={s.consentEnabled} onChange={(e) => set({ consentEnabled: e.target.checked })} style={{ marginTop: 3 }} />
              Consent checkbox (the visitor must tick it)
            </label>
            {s.consentEnabled && (
              <input value={s.consentText ?? ''} placeholder="I agree to be contacted about my request." onChange={(e) => set({ consentText: e.target.value || null })} style={{ ...full, marginTop: 6 }} />
            )}
          </Section>

          <Section title="Design">
            <span style={label}>Button text</span>
            <input value={s.design.buttonText} onChange={(e) => set({ design: { ...s.design, buttonText: e.target.value } })} style={full} />
            <div className="flex flex-wrap gap-4 mt-2">
              {([['buttonColor', 'Button'], ['buttonTextColor', 'Button text'], ['textColor', 'Text'], ['backgroundColor', 'Background']] as const).map(([k, name]) => (
                <label key={k} className="text-xs text-gray-600 flex items-center gap-2">
                  <input type="color" value={s.design[k]} onChange={(e) => set({ design: { ...s.design, [k]: e.target.value } })} style={{ width: 32, height: 26, border: 0, padding: 0, background: 'none' }} />
                  {name}
                </label>
              ))}
            </div>
            <label className="text-sm text-gray-700 flex items-center gap-2 mt-3">
              <input type="checkbox" checked={s.design.rounded} onChange={(e) => set({ design: { ...s.design, rounded: e.target.checked } })} />
              Rounded corners
            </label>
            <span style={label}>Popup opens after (seconds, empty = only when the button is clicked)</span>
            <input
              type="number"
              min={0}
              max={600}
              value={delay ?? ''}
              onChange={(e) => set({ design: { ...s.design, popupDelaySeconds: e.target.value === '' ? null : Number(e.target.value) } })}
              style={{ ...controlStyle, width: 100 }}
            />
          </Section>

          <Section title="New leads">
            <span style={label}>Pipeline</span>
            <select value={s.pipelineId ?? ''} onChange={(e) => set({ pipelineId: e.target.value ? Number(e.target.value) : null, stageId: null })} style={full}>
              <option value="">Default pipeline</option>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span style={label}>Stage</span>
            <select value={s.stageId ?? ''} onChange={(e) => set({ stageId: e.target.value ? Number(e.target.value) : null })} style={full}>
              <option value="">First stage</option>
              {stages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select>
            <p className="text-xs text-gray-400 mt-1">A lead that already exists only moves forward, like with your pipeline rules.</p>
            <span style={label}>Tags</span>
            <div className="flex flex-wrap gap-2">
              {tags.filter((t) => t.scope !== 'campaign').map((t) => (
                <label key={t.id} className="text-xs text-gray-700 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={s.tagIds.includes(t.id)}
                    onChange={(e) => set({ tagIds: e.target.checked ? [...s.tagIds, t.id] : s.tagIds.filter((x) => x !== t.id) })}
                  />
                  {t.name}
                </label>
              ))}
              {tags.length === 0 && <span className="text-xs text-gray-400">No tags yet</span>}
            </div>
            <span style={label}>Also add new leads to this campaign (optional)</span>
            <select value={s.addToCampaignId ?? ''} onChange={(e) => set({ addToCampaignId: e.target.value ? Number(e.target.value) : null })} style={full}>
              <option value="">Don't add</option>
              {openCampaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Section>

          <Section title="Emails">
            <label className="text-sm text-gray-700 flex items-center gap-2 mt-2">
              <input type="checkbox" checked={s.notifyEnabled} onChange={(e) => set({ notifyEnabled: e.target.checked })} />
              Notify me in MailFlow (bell)
            </label>
            {s.notifyEnabled && (
              <input value={s.notifyEmail ?? ''} placeholder="Also email me at (optional)" onChange={(e) => set({ notifyEmail: e.target.value || null })} style={{ ...full, marginTop: 6 }} />
            )}
            <label className="text-sm text-gray-700 flex items-center gap-2 mt-3">
              <input type="checkbox" checked={s.thankYouEnabled} onChange={(e) => set({ thankYouEnabled: e.target.checked })} />
              Send a thank-you email from my email account
            </label>
            {s.thankYouEnabled && (
              <>
                <select value={s.thankYouSmtpSettingsId ?? ''} onChange={(e) => set({ thankYouSmtpSettingsId: e.target.value ? Number(e.target.value) : null })} style={{ ...full, marginTop: 6 }}>
                  <option value="">Pick an email account</option>
                  {smtps.map((p) => <option key={p.id} value={p.id}>{p.fromEmail}</option>)}
                </select>
                <input value={s.thankYouSubject ?? ''} placeholder="Subject, e.g. Thanks {{name}}!" onChange={(e) => set({ thankYouSubject: e.target.value || null })} style={{ ...full, marginTop: 6 }} />
                <textarea
                  rows={4}
                  value={s.thankYouBody ?? ''}
                  placeholder={'Hi {{name}},\n\nThanks for your request. We will reply soon.'}
                  onChange={(e) => set({ thankYouBody: e.target.value || null })}
                  style={{ ...full, height: 'auto', padding: 8, marginTop: 6 }}
                />
                <p className="text-xs text-gray-400 mt-1">You can use {'{{name}}'}, {'{{email}}'} and {'{{form}}'}. Sent only while the account has sends left today.</p>
              </>
            )}
          </Section>

          <Section title="Spam check (optional)">
            <p className="text-xs text-gray-500 mt-1">Every form already has a hidden trap field and a limit per visitor. Add Turnstile or reCAPTCHA for more.</p>
            <select value={s.captchaProvider ?? ''} onChange={(e) => set({ captchaProvider: (e.target.value || null) as CrmFormSettings['captchaProvider'] })} style={{ ...full, marginTop: 6 }}>
              <option value="">None</option>
              <option value="turnstile">Cloudflare Turnstile</option>
              <option value="recaptcha">Google reCAPTCHA (v2 checkbox)</option>
            </select>
            {s.captchaProvider && (
              <>
                <input value={s.captchaSiteKey ?? ''} placeholder="Site key" onChange={(e) => set({ captchaSiteKey: e.target.value || null })} style={{ ...full, marginTop: 6 }} />
                <input
                  type="password"
                  value={secret}
                  placeholder={form.captchaSecretKeySet ? 'Secret key (saved, type to change)' : 'Secret key'}
                  onChange={(e) => {
                    setSecret(e.target.value);
                    setDirty(true);
                  }}
                  style={{ ...full, marginTop: 6 }}
                  autoComplete="off"
                />
              </>
            )}
          </Section>
        </div>

        <div className="space-y-4 lg:sticky lg:top-4">
          <Card>
            <CardContent className="py-4">
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Live preview</h2>
              <div style={{ background: '#f3f4f6', borderRadius: 10, padding: 12 }}>
                <iframe ref={previewRef} src={`${previewUrl}?embed=1`} title="Form preview" onLoad={sendPreview} style={{ width: '100%', height: previewHeight, border: 0, display: 'block' }} />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <h2 className="text-sm font-semibold text-gray-900">Publish</h2>
              <Snippet title="1. Embed on a page" code={embedCode} hint="The form shows where you paste this line." />
              <Snippet title="2. Popup" code={popupCode} hint="Opens after the delay above, or when the button is clicked. Paste the button anywhere (or add data-mailflow-open to your own button)." />
              <div style={{ marginTop: 10 }}>
                <span style={label}>3. Hosted link</span>
                <div className="flex items-center gap-2">
                  <code className="text-xs" style={{ flex: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px' }}>
                    {form.urls.hosted}
                  </code>
                  <a href={form.urls.hosted} target="_blank" rel="noreferrer" aria-label="Open hosted form" style={iconButtonStyle}><ExternalLink size={14} /></a>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-3">
                Add the Website tracking script (Settings) to the same website to join earlier visits of a visitor to the new lead.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
