import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, GitBranch, Loader2, Tags } from 'lucide-react';
import { crmApi, apiErrorMessage, type CrmCampaignSettings, type CrmCampaignSummary, type CrmPipelineSummary, type CrmTag } from '../../lib/api';
import { REPLY_LABELS, REPLY_LABEL_META, type ReplyLabel } from '../../lib/replyLabels';
import { useCrmTags } from '../../lib/useCrmTags';
import { useToast } from '../ui';
import { TagChip, TagPicker } from './TagChip';
import { controlStyle, labelStyle } from './builderStyles';

/**
 * CRM step 5 parts for campaigns:
 *  - LabelBreakdownBar: 🟢/🔴/🟡/🔵/🟣/⚪ replies of a campaign, click a color to open those leads
 *  - CampaignCrmSettingsForm: "Assign to pipeline" + "Auto-tag all recipients with"
 *  - CampaignCrmPanel: the box on the campaign page (tags, label bar, settings)
 */

export function LabelBreakdownBar({ labels, onPick }: { labels: Record<string, number>; onPick?: (label: ReplyLabel) => void }) {
  const total = REPLY_LABELS.reduce((sum, l) => sum + (labels[l] ?? 0), 0);
  if (total === 0) {
    return <p className="text-sm text-gray-500">No labeled replies yet. Colors show up here when leads reply.</p>;
  }
  return (
    <div>
      <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: '#f3f4f6' }}>
        {REPLY_LABELS.filter((l) => (labels[l] ?? 0) > 0).map((l) => (
          <button
            key={l}
            type="button"
            title={`${REPLY_LABEL_META[l].name}: ${labels[l]}`}
            aria-label={`${REPLY_LABEL_META[l].name}: ${labels[l]}`}
            onClick={() => onPick?.(l)}
            style={{ width: `${((labels[l] ?? 0) / total) * 100}%`, background: REPLY_LABEL_META[l].color, minWidth: 6, cursor: onPick ? 'pointer' : 'default' }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {REPLY_LABELS.map((l) => {
          const n = labels[l] ?? 0;
          return (
            <button
              key={l}
              type="button"
              disabled={n === 0 || !onPick}
              onClick={() => onPick?.(l)}
              className={n > 0 && onPick ? 'hover:bg-gray-50' : ''}
              title={n > 0 && onPick ? `Open the ${n} lead(s) labeled ${REPLY_LABEL_META[l].name}` : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                borderRadius: 999,
                border: '1px solid #e5e7eb',
                fontSize: 12,
                color: n > 0 ? '#111827' : '#9ca3af',
                background: '#fff',
                cursor: n > 0 && onPick ? 'pointer' : 'default',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 999, background: REPLY_LABEL_META[l].color, opacity: n > 0 ? 1 : 0.4 }} />
              {REPLY_LABEL_META[l].name}
              <strong style={{ fontWeight: 600 }}>{n}</strong>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SettingsFormProps {
  campaignId: number;
  initial?: CrmCampaignSettings;
  tags: CrmTag[];
  onCreateTag: (name: string) => Promise<CrmTag>;
  onSaved?: (s: CrmCampaignSettings, tagged: number) => void;
}

/** Saves on every change. Used while creating a campaign and on the campaign page. */
export function CampaignCrmSettingsForm({ campaignId, initial, tags, onCreateTag, onSaved }: SettingsFormProps) {
  const toast = useToast();
  const [pipelines, setPipelines] = useState<CrmPipelineSummary[]>([]);
  const [settings, setSettings] = useState<CrmCampaignSettings>(initial ?? { pipelineId: null, autoTagIds: [] });
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');

  useEffect(() => {
    if (initial) setSettings(initial);
  }, [initial]);

  useEffect(() => {
    crmApi.getPipelines().then(setPipelines).catch(() => setPipelines([]));
  }, []);

  const save = async (next: CrmCampaignSettings) => {
    const prev = settings;
    setSettings(next);
    setState('saving');
    try {
      const r = await crmApi.saveCampaignSettings(campaignId, next);
      setState('saved');
      onSaved?.(r.settings, r.tagged);
      if (r.tagged > 0) toast.success(`Tagged ${r.tagged} existing lead(s)`);
    } catch (e) {
      setSettings(prev);
      setState('idle');
      toast.error(apiErrorMessage(e, 'Could not save the CRM settings'));
    }
  };

  const defaultName = pipelines.find((p) => p.isDefault)?.name;
  const selectedTags = settings.autoTagIds.map((id) => tags.find((t) => t.id === id)).filter(Boolean) as CrmTag[];

  return (
    <div className="space-y-3">
      <div>
        <label style={labelStyle} htmlFor={`crm-pipe-${campaignId}`}>
          <GitBranch size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          Assign to pipeline <span className="text-gray-400" style={{ fontWeight: 400 }}>(optional)</span>
        </label>
        <select
          id={`crm-pipe-${campaignId}`}
          value={settings.pipelineId ?? ''}
          onChange={(e) => void save({ ...settings, pipelineId: e.target.value ? Number(e.target.value) : null })}
          style={{ ...controlStyle, width: '100%', maxWidth: 360 }}
        >
          <option value="">Default pipeline{defaultName ? ` (${defaultName})` : ''}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">New leads from this campaign start in the first stage of this pipeline. Leads you already have stay where they are.</p>
      </div>
      <div>
        <span style={labelStyle}>
          <Tags size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
          Auto-tag all recipients with <span className="text-gray-400" style={{ fontWeight: 400 }}>(optional)</span>
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {selectedTags.map((t) => (
            <TagChip key={t.id} tag={t} onRemove={() => void save({ ...settings, autoTagIds: settings.autoTagIds.filter((id) => id !== t.id) })} />
          ))}
          <TagPicker
            tags={tags}
            target="contact"
            selectedIds={settings.autoTagIds}
            onAdd={(t) => save({ ...settings, autoTagIds: [...settings.autoTagIds, t.id] })}
            onRemove={(t) => save({ ...settings, autoTagIds: settings.autoTagIds.filter((id) => id !== t.id) })}
            onCreate={onCreateTag}
            label="Add tag"
          />
          {state === 'saving' && <Loader2 size={14} className="animate-spin" color="#6b7280" />}
          {state === 'saved' && (
            <span className="text-xs" style={{ color: '#16a34a', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Check size={12} /> Saved
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">Every lead of this campaign gets these tags. You can use them in rules (“Tag is …”) and to filter leads.</p>
      </div>
    </div>
  );
}

/** The CRM box on the campaign page. */
export function CampaignCrmPanel({ campaignId }: { campaignId: number }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { tags, create } = useCrmTags();
  const [summary, setSummary] = useState<CrmCampaignSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const load = () =>
    crmApi
      .getCampaignCrm(campaignId)
      .then((s) => {
        setSummary(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  if (failed) return null; // no CRM in the plan, or the campaign is gone: the rest of the page still works
  if (!summary) return null;

  const addTag = async (t: CrmTag) => {
    try {
      await crmApi.addCampaignTag(campaignId, t.id);
      setSummary((s) => (s ? { ...s, tags: [...s.tags, t].sort((a, b) => a.name.localeCompare(b.name)) } : s));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add the tag'));
    }
  };
  const removeTag = async (t: CrmTag) => {
    try {
      await crmApi.removeCampaignTag(campaignId, t.id);
      setSummary((s) => (s ? { ...s, tags: s.tags.filter((x) => x.id !== t.id) } : s));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not remove the tag'));
    }
  };

  const pipelineNote = summary.settings.pipelineId ? 'own pipeline' : null;
  const autoCount = summary.settings.autoTagIds.length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl" style={{ padding: 20 }}>
      <div className="flex items-center justify-between flex-wrap gap-2" style={{ marginBottom: 12 }}>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Reply labels</h3>
          <p className="text-xs text-gray-500 mt-1">
            {summary.labeledLeads} labeled {summary.labeledLeads === 1 ? 'reply' : 'replies'} · {summary.leadCount} lead(s) in CRM. Click a color to open those leads.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate(`/crm?view=table&campaignId=${campaignId}`)}
          className="text-xs font-medium text-gray-700 hover:bg-gray-50 rounded-lg border"
          style={{ padding: '6px 10px' }}
        >
          All leads of this campaign
        </button>
      </div>
      <LabelBreakdownBar labels={summary.labels} onPick={(l) => navigate(`/crm?view=table&campaignId=${campaignId}&label=${l}`)} />

      <div style={{ borderTop: '1px solid #f3f4f6', marginTop: 16, paddingTop: 14 }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-700" style={{ marginRight: 4 }}>Campaign tags</span>
          {summary.tags.map((t) => (
            <TagChip key={t.id} tag={t} onRemove={() => void removeTag(t)} />
          ))}
          <TagPicker
            tags={tags}
            target="campaign"
            selectedIds={summary.tags.map((t) => t.id)}
            onAdd={addTag}
            onRemove={removeTag}
            onCreate={(name) => create(name)}
          />
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="text-xs text-gray-600 hover:bg-gray-50 rounded-lg"
            style={{ padding: '4px 8px' }}
          >
            CRM settings{pipelineNote || autoCount ? ` (${[pipelineNote, autoCount ? `${autoCount} auto tag${autoCount > 1 ? 's' : ''}` : null].filter(Boolean).join(', ')})` : ''} {showSettings ? '▲' : '▼'}
          </button>
        </div>
        {showSettings && (
          <div style={{ marginTop: 12 }}>
            <CampaignCrmSettingsForm
              campaignId={campaignId}
              initial={summary.settings}
              tags={tags}
              onCreateTag={(name) => create(name)}
              onSaved={(s) => setSummary((prev) => (prev ? { ...prev, settings: s } : prev))}
            />
          </div>
        )}
      </div>
    </div>
  );
}
