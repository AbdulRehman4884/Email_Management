import React, { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal, Button } from '../ui';
import type { CrmRule, CrmRuleAction, CrmRuleInput, CrmStage, CrmTag } from '../../lib/api';
import { ACTION_TYPES, TRIGGERS, describeRule, newAction } from '../../lib/crmRules';
import { ConditionBuilder } from './ConditionBuilder';
import { controlStyle, iconButtonStyle, labelStyle, smallControlStyle } from './builderStyles';

interface RuleEditorModalProps {
  isOpen: boolean;
  /** null = new rule */
  rule: CrmRule | null;
  /** Prefill for a new rule (e.g. "move to the selected stage"). */
  draft?: Partial<CrmRuleInput>;
  stages: CrmStage[];
  tags: CrmTag[];
  onClose: () => void;
  onSave: (input: CrmRuleInput) => Promise<void>;
}

function blank(draft: Partial<CrmRuleInput> | undefined, stages: CrmStage[]): CrmRuleInput {
  return {
    name: '',
    trigger: 'reply_labeled',
    fromStageId: null,
    priority: 50,
    isActive: true,
    forwardOnly: true,
    conditions: { op: 'AND', items: [] },
    actions: [{ type: 'move_to_stage', stageId: stages[0]?.id ?? 0 }],
    ...draft,
  };
}

function ActionEditor({
  action, stages, tags, onChange, onRemove,
}: { action: CrmRuleAction; stages: CrmStage[]; tags: CrmTag[]; onChange: (a: CrmRuleAction) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        style={{ ...smallControlStyle, width: 170 }}
        value={action.type}
        onChange={(e) => onChange(newAction(e.target.value as CrmRuleAction['type'], stages, tags))}
      >
        {ACTION_TYPES.map((a) => (
          <option key={a.key} value={a.key}>{a.label}</option>
        ))}
      </select>

      {action.type === 'move_to_stage' && (
        <select style={{ ...smallControlStyle, width: 170 }} value={action.stageId} onChange={(e) => onChange({ ...action, stageId: Number(e.target.value) })}>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}
      {(action.type === 'add_tag' || action.type === 'remove_tag') &&
        (tags.length === 0 ? (
          <span className="text-xs text-gray-400">No tags yet: create them on the Leads page (Manage tags)</span>
        ) : (
          <select style={{ ...smallControlStyle, width: 170 }} value={action.tagId} onChange={(e) => onChange({ ...action, tagId: Number(e.target.value) })}>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        ))}
      {action.type === 'schedule_follow_up' && (
        <>
          <span className="text-xs text-gray-600">after</span>
          <input
            type="number" min={0} max={365}
            style={{ ...smallControlStyle, width: 70 }}
            value={action.afterDays}
            onChange={(e) => onChange({ ...action, afterDays: Number(e.target.value) })}
          />
          <span className="text-xs text-gray-600">days, template ID</span>
          <input
            placeholder="empty = next template"
            style={{ ...smallControlStyle, width: 160 }}
            value={action.templateId ?? ''}
            onChange={(e) => onChange({ ...action, templateId: e.target.value.trim() || null })}
          />
        </>
      )}
      {action.type === 'notify_user' && (
        <input
          placeholder="Message. Use {{name}}, {{email}}, {{stage}}"
          maxLength={500}
          style={{ ...smallControlStyle, flex: 1, minWidth: 220 }}
          value={action.message}
          onChange={(e) => onChange({ ...action, message: e.target.value })}
        />
      )}
      {action.type === 'add_score' && (
        <>
          <input
            type="number" min={-100} max={100}
            style={{ ...smallControlStyle, width: 80 }}
            value={action.points}
            onChange={(e) => onChange({ ...action, points: Number(e.target.value) })}
          />
          <span className="text-xs text-gray-600">points (use a minus to remove)</span>
        </>
      )}
      <button type="button" aria-label="Remove action" title="Remove action" className="ml-auto hover:bg-gray-100" style={iconButtonStyle} onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Create / edit one rule: WHEN trigger, IF conditions, THEN actions. */
export function RuleEditorModal({ isOpen, rule, draft, stages, tags, onClose, onSave }: RuleEditorModalProps) {
  const [form, setForm] = useState<CrmRuleInput>(() => blank(draft, stages));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // PB-06: bring the error into view when saving fails.
  useEffect(() => {
    if (error) scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [error]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setForm(rule ? {
      name: rule.name, trigger: rule.trigger, fromStageId: rule.fromStageId, priority: rule.priority,
      isActive: rule.isActive, forwardOnly: rule.forwardOnly, conditions: rule.conditions, actions: rule.actions,
    } : blank(draft, stages));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, rule]);

  const set = <K extends keyof CrmRuleInput>(k: K, v: CrmRuleInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const sentence = describeRule(form, { stages, tags });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rule');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={rule ? 'Edit rule' : 'New rule'} size="xl">
      <div ref={scrollRef} className="space-y-5" style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {/* PB-06: the error is shown at the top of the dialog (it used to be below the preview, out of view). */}
        {error && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-600" role="alert">
            {error.split('; ').map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label style={labelStyle}>Rule name</label>
            <input
              style={{ ...controlStyle, width: '100%' }}
              placeholder="e.g. Interested → Interested stage"
              maxLength={255}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label style={labelStyle} title="Higher runs first. The first matching rule that moves the lead wins.">Priority</label>
              <input type="number" style={{ ...controlStyle, width: '100%' }} value={form.priority} onChange={(e) => set('priority', Number(e.target.value))} />
            </div>
            <div>
              <label style={labelStyle}>Active</label>
              <button
                type="button"
                className={`toggle-switch ${form.isActive ? 'active' : ''}`}
                aria-pressed={form.isActive}
                aria-label="Rule active"
                onClick={() => set('isActive', !form.isActive)}
                style={{ marginTop: 5 }}
              />
            </div>
          </div>
        </div>

        <section className="rounded-lg border border-gray-200 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">WHEN</h3>
          <div className="flex flex-wrap gap-3 items-center">
            <select style={{ ...controlStyle, width: 240 }} value={form.trigger} onChange={(e) => set('trigger', e.target.value)}>
              {TRIGGERS.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
            <span className="text-sm text-gray-600">and the lead is in</span>
            <select
              style={{ ...controlStyle, width: 200 }}
              value={form.fromStageId ?? ''}
              onChange={(e) => set('fromStageId', e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">any stage</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">IF</h3>
          <ConditionBuilder group={form.conditions} ctx={{ stages, tags }} onChange={(g) => set('conditions', g)} />
        </section>

        <section className="rounded-lg border border-gray-200 p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">THEN</h3>
          {form.actions.map((a, i) => (
            <ActionEditor
              key={i}
              action={a}
              stages={stages}
              tags={tags}
              onChange={(next) => set('actions', form.actions.map((x, j) => (j === i ? next : x)))}
              onRemove={() => set('actions', form.actions.filter((_, j) => j !== i))}
            />
          ))}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 rounded-md border border-gray-300 hover:bg-gray-50"
            style={{ padding: '4px 8px' }}
            onClick={() => set('actions', [...form.actions, newAction('stop_follow_ups', stages, tags)])}
            disabled={form.actions.length >= 10}
          >
            <Plus size={12} /> Action
          </button>
          <label className="flex items-center gap-2 text-xs text-gray-600" title="Off = this rule may also move leads back to an earlier stage">
            <input type="checkbox" checked={form.forwardOnly} onChange={(e) => set('forwardOnly', e.target.checked)} />
            Forward only (never move a lead back to an earlier stage)
          </label>
        </section>

        <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm text-gray-700">
          <span className="font-semibold">WHEN</span> {sentence.when}
          {sentence.from && <> while the lead is in <b>{sentence.from}</b></>}
          {sentence.cond && <>, <span className="font-semibold">IF</span> {sentence.cond}</>}
          , <span className="font-semibold">THEN</span> {sentence.then}.
        </div>

      </div>

      <div className="flex justify-end gap-2 mt-5">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => void save()} isLoading={saving}>{rule ? 'Save rule' : 'Create rule'}</Button>
      </div>
    </Modal>
  );
}
