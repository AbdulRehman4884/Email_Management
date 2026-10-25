import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, LayoutTemplate, FlaskConical, Pencil, Trash2, Star, GitBranch, Loader2 } from 'lucide-react';
import { Button, Card, CardContent, ConfirmDialog, EmptyState, Modal, useToast } from '../components/ui';
import { UpgradePrompt } from '../components/UpgradePrompt';
import { StageList } from '../components/crm/StageList';
import { RuleEditorModal } from '../components/crm/RuleEditorModal';
import { RuleTestModal } from '../components/crm/RuleTestModal';
import { controlStyle, labelStyle, pillStyle } from '../components/crm/builderStyles';
import {
  crmApi,
  apiErrorMessage,
  type CrmPipelineSummary,
  type CrmPipelineTemplate,
  type CrmRule,
  type CrmRuleInput,
  type CrmStage,
  type CrmTag,
} from '../lib/api';
import { describeRule, rulesForStage, triggerLabel } from '../lib/crmRules';
import { useAuthStore } from '../store/authStore';

type RuleTab = 'stage' | 'all';

/** One rule as a readable sentence card. */
function RuleCard({
  rule, stages, tags, onEdit, onToggle, onDelete,
}: {
  rule: CrmRule; stages: CrmStage[]; tags: CrmTag[];
  onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const s = describeRule(rule, { stages, tags });
  const moveTo = rule.actions.find((a) => a.type === 'move_to_stage');
  const target = moveTo && moveTo.type === 'move_to_stage' ? stages.find((x) => x.id === moveTo.stageId) : undefined;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3" style={{ opacity: rule.isActive ? 1 : 0.6 }}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900 truncate">{rule.name}</span>
            <span className="text-xs text-gray-500">{triggerLabel(rule.trigger)}</span>
            {!rule.isActive && <span className="text-xs font-medium text-gray-500">Off</span>}
            {!rule.forwardOnly && <span className="text-xs text-orange-600">can move back</span>}
          </div>
          <p className="text-sm text-gray-700 mt-1 leading-relaxed">
            <b>WHEN</b> {s.when}
            {s.from && <> while the lead is in <b>{s.from}</b></>}
            {s.cond && <>, <b>IF</b> {s.cond}</>}
            , <b>THEN</b> {s.then}.
          </p>
          {target && (
            <div className="mt-2">
              <span style={pillStyle(target.color)}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: target.color }} /> {target.name}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            className={`toggle-switch ${rule.isActive ? 'active' : ''}`}
            aria-pressed={rule.isActive}
            aria-label={rule.isActive ? 'Turn rule off' : 'Turn rule on'}
            title={rule.isActive ? 'On' : 'Off'}
            onClick={onToggle}
          />
          <button type="button" className="hover:bg-gray-100 rounded-md" style={{ padding: 6, color: '#6b7280' }} title="Edit" aria-label="Edit rule" onClick={onEdit}>
            <Pencil size={14} />
          </button>
          <button type="button" className="hover:bg-red-50 hover:text-red-600 rounded-md" style={{ padding: 6, color: '#6b7280' }} title="Delete" aria-label="Delete rule" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function PipelineBuilder() {
  const user = useAuthStore((s) => s.user);
  const plan = user?.plan;
  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin';
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [pipelines, setPipelines] = useState<CrmPipelineSummary[]>([]);
  const [pipelineId, setPipelineId] = useState<number | null>(null);
  const [pipelineName, setPipelineName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [stages, setStages] = useState<CrmStage[]>([]);
  const [rules, setRules] = useState<CrmRule[]>([]);
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<number | null>(null);
  const [tab, setTab] = useState<RuleTab>('stage');
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState<string | null>(null);

  const [editor, setEditor] = useState<{ open: boolean; rule: CrmRule | null; draft?: Partial<CrmRuleInput> }>({ open: false, rule: null });
  const [testOpen, setTestOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [templates, setTemplates] = useState<CrmPipelineTemplate[]>([]);
  const [newForm, setNewForm] = useState({ name: '', template: 'sales', makeDefault: false });
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [deleteRule, setDeleteRule] = useState<CrmRule | null>(null);
  const [deleteStage, setDeleteStage] = useState<CrmStage | null>(null);
  const [stageTarget, setStageTarget] = useState<number | ''>('');
  const [deletePipelineOpen, setDeletePipelineOpen] = useState(false);
  const [pipelineTarget, setPipelineTarget] = useState<{ pipelineId: number | ''; stageId: number | ''; stages: CrmStage[] }>({ pipelineId: '', stageId: '', stages: [] });
  const [busy, setBusy] = useState(false);

  const loadPipelines = useCallback(async () => {
    const list = await crmApi.getPipelines();
    setPipelines(list);
    return list;
  }, []);

  const loadPipeline = useCallback(async (id: number) => {
    const data = await crmApi.getPipeline(id);
    setPipelineName(data.pipeline.name);
    setIsDefault(data.pipeline.isDefault);
    setStages(data.stages);
    setRules(data.rules);
    setSelectedStageId((cur) => (cur && data.stages.some((s) => s.id === cur) ? cur : data.stages[0]?.id ?? null));
  }, []);

  // first load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await loadPipelines();
        crmApi.getTags().then((t) => !cancelled && setTags(t)).catch(() => undefined);
        const fromUrl = Number(params.get('pipeline'));
        const pick = list.find((p) => p.id === fromUrl) ?? list.find((p) => p.isDefault) ?? list[0];
        if (pick && !cancelled) {
          setPipelineId(pick.id);
          await loadPipeline(pick.id);
        }
      } catch (e) {
        const status = (e as { response?: { status?: number } })?.response?.status;
        if (!cancelled) setBlocked(status === 403 ? apiErrorMessage(e, 'Your plan does not include the CRM.') : apiErrorMessage(e, 'Could not load pipelines'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchPipeline = async (id: number) => {
    setPipelineId(id);
    setParams({ pipeline: String(id) }, { replace: true });
    setLoading(true);
    try {
      await loadPipeline(id);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not load the pipeline'));
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    if (pipelineId == null) return;
    await Promise.all([loadPipeline(pipelineId), loadPipelines()]);
  };

  // ── stages ──
  const updateStage = async (stage: CrmStage, patch: Partial<CrmStage>) => {
    if (pipelineId == null) return;
    setStages((prev) => prev.map((s) => (s.id === stage.id ? { ...s, ...patch } : s)));
    try {
      const saved = await crmApi.updateStage(pipelineId, stage.id, patch);
      setStages((prev) => prev.map((s) => (s.id === saved.id ? { ...s, ...saved, contactCount: s.contactCount } : s)));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the stage'));
      await refresh();
    }
  };

  const reorder = async (ids: number[]) => {
    if (pipelineId == null) return;
    setStages((prev) => ids.map((id, i) => ({ ...prev.find((s) => s.id === id)!, position: i })));
    try {
      setStages(await crmApi.reorderStages(pipelineId, ids));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the new order'));
      await refresh();
    }
  };

  const addStage = async () => {
    if (pipelineId == null) return;
    let n = stages.length + 1;
    while (stages.some((s) => s.name.toLowerCase() === `stage ${n}`)) n++;
    try {
      const s = await crmApi.createStage(pipelineId, { name: `Stage ${n}`, color: '#6366f1', type: 'normal' });
      setStages((prev) => [...prev, s]);
      setSelectedStageId(s.id);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add a stage'));
    }
  };

  const confirmDeleteStage = async () => {
    if (pipelineId == null || !deleteStage) return;
    setBusy(true);
    try {
      const r = await crmApi.deleteStage(pipelineId, deleteStage.id, stageTarget === '' ? undefined : stageTarget);
      toast.success(
        `Stage deleted${r.moved ? `, ${r.moved} lead(s) moved` : ''}${r.rulesTurnedOff ? `, ${r.rulesTurnedOff} rule(s) turned off` : ''}`
      );
      setDeleteStage(null);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not delete the stage'));
    } finally {
      setBusy(false);
    }
  };

  // ── rules ──
  const saveRule = async (input: CrmRuleInput) => {
    if (pipelineId == null) return;
    try {
      if (editor.rule) await crmApi.updateRule(pipelineId, editor.rule.id, input);
      else await crmApi.createRule(pipelineId, input);
    } catch (e) {
      throw new Error(apiErrorMessage(e, 'Could not save the rule'));
    }
    setEditor({ open: false, rule: null });
    toast.success('Rule saved');
    await refresh();
  };

  const toggleRule = async (rule: CrmRule) => {
    if (pipelineId == null) return;
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, isActive: !r.isActive } : r)));
    try {
      await crmApi.updateRule(pipelineId, rule.id, { isActive: !rule.isActive });
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not change the rule'));
      await refresh();
    }
  };

  const confirmDeleteRule = async () => {
    if (pipelineId == null || !deleteRule) return;
    setBusy(true);
    try {
      await crmApi.deleteRule(pipelineId, deleteRule.id);
      setDeleteRule(null);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not delete the rule'));
    } finally {
      setBusy(false);
    }
  };

  // ── pipelines ──
  const openNew = async () => {
    setNewForm({ name: '', template: 'sales', makeDefault: pipelines.length === 0 });
    setNewOpen(true);
    if (templates.length === 0) {
      try {
        setTemplates(await crmApi.getTemplates());
      } catch {
        /* list stays empty */
      }
    }
  };

  const createPipeline = async () => {
    const tpl = templates.find((t) => t.key === newForm.template);
    const name = newForm.name.trim() || tpl?.label || 'New pipeline';
    setBusy(true);
    try {
      const { id } = await crmApi.createPipeline({ name, template: newForm.template, makeDefault: newForm.makeDefault });
      setNewOpen(false);
      await loadPipelines();
      await switchPipeline(id);
      toast.success(`Pipeline "${name}" created`);
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not create the pipeline'));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (pipelineId == null) return;
    try {
      await crmApi.updatePipeline(pipelineId, { name: renameValue });
      setRenameOpen(false);
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not rename'));
    }
  };

  const makeDefault = async () => {
    if (pipelineId == null) return;
    try {
      await crmApi.updatePipeline(pipelineId, { isDefault: true });
      toast.success('New leads now go into this pipeline');
      await refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not change the default'));
    }
  };

  const currentSummary = pipelines.find((p) => p.id === pipelineId);
  const otherPipelines = pipelines.filter((p) => p.id !== pipelineId);

  const pickTargetPipeline = async (id: number | '') => {
    setPipelineTarget({ pipelineId: id, stageId: '', stages: [] });
    if (id === '') return;
    try {
      const data = await crmApi.getPipeline(id);
      setPipelineTarget({ pipelineId: id, stageId: data.stages[0]?.id ?? '', stages: data.stages });
    } catch {
      /* ignore */
    }
  };

  const confirmDeletePipeline = async () => {
    if (pipelineId == null) return;
    setBusy(true);
    try {
      const r = await crmApi.deletePipeline(pipelineId, pipelineTarget.stageId === '' ? undefined : pipelineTarget.stageId);
      toast.success(`Pipeline deleted${r.moved ? `, ${r.moved} lead(s) moved` : ''}`);
      setDeletePipelineOpen(false);
      const list = await loadPipelines();
      const next = list.find((p) => p.isDefault) ?? list[0];
      if (next) await switchPipeline(next.id);
      else {
        setPipelineId(null);
        setStages([]);
        setRules([]);
      }
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not delete the pipeline'));
    } finally {
      setBusy(false);
    }
  };

  const selectedStage = stages.find((s) => s.id === selectedStageId) ?? null;
  const shownRules = useMemo(() => {
    if (tab === 'all' || !selectedStage) return { into: rules, whileIn: [] as CrmRule[] };
    return rulesForStage(rules, selectedStage.id);
  }, [tab, rules, selectedStage]);

  // ── render ──
  if (plan && plan.crmEnabled === false && !isAdmin) return <UpgradePrompt feature="CRM Pipelines" />;
  if (blocked) {
    return (
      <div className="max-w-xl mx-auto mt-8">
        <EmptyState icon={<GitBranch className="w-8 h-8 text-gray-400" />} title="Pipeline Builder is not available" description={blocked} />
      </div>
    );
  }

  const renderRuleList = (list: CrmRule[], empty: string) =>
    list.length === 0 ? (
      <p className="text-sm text-gray-500">{empty}</p>
    ) : (
      <div className="space-y-2">
        {list.map((r) => (
          <RuleCard
            key={r.id}
            rule={r}
            stages={stages}
            tags={tags}
            onEdit={() => setEditor({ open: true, rule: r })}
            onToggle={() => void toggleRule(r)}
            onDelete={() => setDeleteRule(r)}
          />
        ))}
      </div>
    );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pipeline Builder</h1>
          <p className="text-gray-500 mt-1 text-sm">Stages your leads move through, and the rules that move them.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {pipelines.length > 0 && (
            <select
              aria-label="Pipeline"
              style={{ ...controlStyle, height: 38, minWidth: 200 }}
              value={pipelineId ?? ''}
              onChange={(e) => void switchPipeline(Number(e.target.value))}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
          )}
          <Button variant="secondary" leftIcon={<LayoutTemplate size={16} />} onClick={() => void openNew()}>Templates</Button>
          {pipelineId != null && (
            <Button variant="secondary" leftIcon={<FlaskConical size={16} />} onClick={() => setTestOpen(true)}>Test rules</Button>
          )}
        </div>
      </div>

      {loading && pipelineId == null ? (
        <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>
      ) : pipelineId == null ? (
        <Card>
          <CardContent className="py-8">
            <EmptyState
              icon={<GitBranch className="w-8 h-8 text-gray-400" />}
              title="No pipeline yet"
              description="Start from a ready template (Sales Outreach, Simple or Recruiting) or an empty pipeline."
            />
            <div className="flex justify-center mt-4">
              <Button leftIcon={<Plus size={16} />} onClick={() => void openNew()}>Create a pipeline</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="font-semibold text-gray-900">{pipelineName}</span>
            {isDefault ? (
              <span className="inline-flex items-center gap-1 text-xs text-gray-600"><Star size={12} /> Default: new leads start here</span>
            ) : (
              <button type="button" className="text-xs text-indigo-600 hover:text-gray-900" onClick={() => void makeDefault()}>Make default</button>
            )}
            <span className="text-gray-300">·</span>
            <span className="text-xs text-gray-500">{currentSummary?.contactCount ?? 0} lead(s) · {rules.length} rule(s)</span>
            <span className="text-gray-300">·</span>
            <button type="button" className="text-xs text-gray-600 hover:text-gray-900" onClick={() => { setRenameValue(pipelineName); setRenameOpen(true); }}>Rename</button>
            <button
              type="button"
              className="text-xs text-red-500 hover:text-red-600"
              onClick={() => { setPipelineTarget({ pipelineId: '', stageId: '', stages: [] }); setDeletePipelineOpen(true); }}
            >
              Delete
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card>
              <CardContent className="py-5">
                <h2 className="text-base font-semibold text-gray-900 mb-1">Stages</h2>
                <p className="text-xs text-gray-500 mb-3">Drag to reorder. Click a stage to see its rules.</p>
                <StageList
                  stages={stages}
                  selectedId={selectedStageId}
                  onSelect={(id) => { setSelectedStageId(id); setTab('stage'); }}
                  onUpdate={updateStage}
                  onReorder={reorder}
                  onDelete={(s) => { setStageTarget(stages.find((x) => x.id !== s.id)?.id ?? ''); setDeleteStage(s); }}
                  onAdd={() => void addStage()}
                />
              </CardContent>
            </Card>

            <div className="lg:col-span-2">
              <Card>
                <CardContent className="py-5 space-y-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-white">
                      <button
                        type="button"
                        className={`px-3 py-1.5 text-sm rounded-md ${tab === 'stage' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                        onClick={() => setTab('stage')}
                        disabled={!selectedStage}
                      >
                        {selectedStage ? selectedStage.name : 'Stage'}
                      </button>
                      <button
                        type="button"
                        className={`px-3 py-1.5 text-sm rounded-md ${tab === 'all' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                        onClick={() => setTab('all')}
                      >
                        All rules ({rules.length})
                      </button>
                    </div>
                    <Button
                      className="ml-auto"
                      size="sm"
                      leftIcon={<Plus size={14} />}
                      onClick={() =>
                        setEditor({
                          open: true,
                          rule: null,
                          draft: selectedStage && tab === 'stage'
                            ? { actions: [{ type: 'move_to_stage', stageId: selectedStage.id }] }
                            : undefined,
                        })
                      }
                      disabled={stages.length === 0}
                    >
                      Add rule
                    </Button>
                  </div>

                  {tab === 'stage' && selectedStage ? (
                    <>
                      <div>
                        <h3 className="text-sm font-semibold text-gray-900 mb-2">
                          Leads come to <span style={pillStyle(selectedStage.color)}>{selectedStage.name}</span> when…
                        </h3>
                        {renderRuleList(shownRules.into, 'No rule moves leads here yet. Leads can still be moved here by hand.')}
                      </div>
                      {shownRules.whileIn.length > 0 && (
                        <div>
                          <h3 className="text-sm font-semibold text-gray-900 mb-2">While a lead is in this stage…</h3>
                          {renderRuleList(shownRules.whileIn, '')}
                        </div>
                      )}
                      {(selectedStage.manualOnly || selectedStage.stopFollowUps || selectedStage.type !== 'normal') && (
                        <p className="text-xs text-gray-500">
                          {selectedStage.type !== 'normal' && <>This is a <b>{selectedStage.type === 'won' ? 'Won' : 'Lost'}</b> stage: rules never move leads out of it. </>}
                          {selectedStage.manualOnly && <>Manual only: rules never move leads into or out of it. </>}
                          {selectedStage.stopFollowUps && <>Leads here get no automatic follow-ups.</>}
                        </p>
                      )}
                    </>
                  ) : (
                    renderRuleList(shownRules.into, 'No rules yet. Click "Add rule" or start from a template.')
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}

      <RuleEditorModal
        isOpen={editor.open}
        rule={editor.rule}
        draft={editor.draft}
        stages={stages}
        tags={tags}
        onClose={() => setEditor({ open: false, rule: null })}
        onSave={saveRule}
      />
      {pipelineId != null && <RuleTestModal isOpen={testOpen} pipelineId={pipelineId} onClose={() => setTestOpen(false)} />}

      <Modal isOpen={newOpen} onClose={() => setNewOpen(false)} title="New pipeline from a template" size="lg">
        <div className="space-y-3">
          {templates.length === 0 && <p className="text-sm text-gray-500">Loading templates…</p>}
          {templates.map((t) => (
            <label
              key={t.key}
              className="block rounded-lg border p-3 cursor-pointer hover:bg-gray-50"
              style={{ borderColor: newForm.template === t.key ? '#111827' : '#e5e7eb' }}
            >
              <div className="flex items-center gap-2">
                <input type="radio" name="tpl" checked={newForm.template === t.key} onChange={() => setNewForm((f) => ({ ...f, template: t.key }))} />
                <span className="text-sm font-semibold text-gray-900">{t.label}</span>
                {t.ruleCount > 0 && <span className="text-xs text-gray-500">{t.stages.length} stages · {t.ruleCount} rules</span>}
              </div>
              <p className="text-xs text-gray-500 mt-1" style={{ paddingLeft: 22 }}>{t.description}</p>
            </label>
          ))}
          <div>
            <label style={labelStyle}>Pipeline name</label>
            <input
              style={{ ...controlStyle, width: '100%' }}
              placeholder={templates.find((t) => t.key === newForm.template)?.label ?? 'New pipeline'}
              maxLength={255}
              value={newForm.name}
              onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={newForm.makeDefault} onChange={(e) => setNewForm((f) => ({ ...f, makeDefault: e.target.checked }))} />
            Make it the default (new leads start here)
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button>
          <Button onClick={() => void createPipeline()} isLoading={busy}>Create pipeline</Button>
        </div>
      </Modal>

      <Modal isOpen={renameOpen} onClose={() => setRenameOpen(false)} title="Rename pipeline" size="sm">
        <input style={{ ...controlStyle, width: '100%' }} maxLength={255} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setRenameOpen(false)}>Cancel</Button>
          <Button onClick={() => void rename()} disabled={!renameValue.trim()}>Save</Button>
        </div>
      </Modal>

      <Modal isOpen={!!deleteStage} onClose={() => setDeleteStage(null)} title={`Delete stage "${deleteStage?.name ?? ''}"?`} size="sm">
        <div className="space-y-3 text-sm text-gray-700">
          {deleteStage && deleteStage.contactCount > 0 ? (
            <>
              <p><b>{deleteStage.contactCount}</b> lead(s) are in this stage. Move them to:</p>
              <select style={{ ...controlStyle, width: '100%' }} value={stageTarget} onChange={(e) => setStageTarget(e.target.value ? Number(e.target.value) : '')}>
                {stages.filter((s) => s.id !== deleteStage.id).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </>
          ) : (
            <p>No leads are in this stage.</p>
          )}
          <p className="text-xs text-gray-500">Rules that start from or move to this stage will be turned off so you can fix them.</p>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setDeleteStage(null)}>Cancel</Button>
          <Button
            variant="danger"
            isLoading={busy}
            disabled={!!deleteStage && deleteStage.contactCount > 0 && stageTarget === ''}
            onClick={() => void confirmDeleteStage()}
          >
            Delete stage
          </Button>
        </div>
      </Modal>

      <Modal isOpen={deletePipelineOpen} onClose={() => setDeletePipelineOpen(false)} title={`Delete pipeline "${pipelineName}"?`} size="sm">
        <div className="space-y-3 text-sm text-gray-700">
          {isDefault ? (
            <p>This is your default pipeline. Make another pipeline the default first.</p>
          ) : (currentSummary?.contactCount ?? 0) > 0 ? (
            <>
              <p><b>{currentSummary?.contactCount}</b> lead(s) are in this pipeline. Move them to:</p>
              <select style={{ ...controlStyle, width: '100%' }} value={pipelineTarget.pipelineId} onChange={(e) => void pickTargetPipeline(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Pick a pipeline…</option>
                {otherPipelines.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {pipelineTarget.stages.length > 0 && (
                <select style={{ ...controlStyle, width: '100%' }} value={pipelineTarget.stageId} onChange={(e) => setPipelineTarget((t) => ({ ...t, stageId: Number(e.target.value) }))}>
                  {pipelineTarget.stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </>
          ) : (
            <p>Its stages and rules will be deleted. No leads are in it.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => setDeletePipelineOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            isLoading={busy}
            disabled={isDefault || ((currentSummary?.contactCount ?? 0) > 0 && pipelineTarget.stageId === '')}
            onClick={() => void confirmDeletePipeline()}
          >
            Delete pipeline
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteRule}
        title="Delete rule?"
        message={deleteRule ? `"${deleteRule.name}" will be deleted. Leads already moved stay where they are.` : ''}
        confirmLabel="Delete"
        variant="danger"
        isLoading={busy}
        onConfirm={() => void confirmDeleteRule()}
        onCancel={() => setDeleteRule(null)}
      />
    </div>
  );
}
