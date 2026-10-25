import React from 'react';
import { Plus, X, FolderPlus } from 'lucide-react';
import type { CrmConditionGroup, CrmConditionLeaf, CrmStage, CrmTag } from '../../lib/api';
import { FIELDS, OPERATORS, OPERATORS_FOR, fieldMeta, isGroup } from '../../lib/crmRules';
import { REPLY_LABELS, REPLY_LABEL_META } from '../../lib/replyLabels';
import { iconButtonStyle, smallControlStyle } from './builderStyles';

interface Ctx {
  stages: CrmStage[];
  tags: CrmTag[];
}

const MAX_DEPTH = 3;

function defaultValueFor(field: string, ctx: Ctx): unknown {
  const kind = fieldMeta(field)?.kind;
  if (kind === 'label') return 'interested';
  if (kind === 'number') return 1;
  if (kind === 'tag') return ctx.tags[0]?.id ?? '';
  if (kind === 'stage') return ctx.stages[0]?.id ?? '';
  return '';
}

export function newLeaf(ctx: Ctx): CrmConditionLeaf {
  return { field: 'reply_label', operator: 'equals', value: defaultValueFor('reply_label', ctx) };
}

/** Value input that matches the field (label picker, number, tag, stage, text). */
function ValueInput({ leaf, ctx, onChange }: { leaf: CrmConditionLeaf; ctx: Ctx; onChange: (v: unknown) => void }) {
  const kind = fieldMeta(leaf.field)?.kind ?? 'text';
  if (leaf.operator === 'exists') {
    return (
      <select style={{ ...smallControlStyle, width: 110 }} value={leaf.value === false ? 'no' : 'yes'} onChange={(e) => onChange(e.target.value !== 'no')}>
        <option value="yes">has a value</option>
        <option value="no">is empty</option>
      </select>
    );
  }
  if (kind === 'label' && leaf.operator === 'in') {
    const selected = Array.isArray(leaf.value) ? (leaf.value as string[]) : [];
    return (
      <div className="flex flex-wrap gap-1">
        {REPLY_LABELS.map((l) => {
          const on = selected.includes(l);
          const m = REPLY_LABEL_META[l];
          return (
            <button
              key={l}
              type="button"
              onClick={() => onChange(on ? selected.filter((x) => x !== l) : [...selected, l])}
              style={{
                fontSize: 11, padding: '2px 7px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${on ? m.color : '#e5e7eb'}`, background: on ? `${m.color}1f` : '#fff', color: '#111827',
              }}
            >
              {m.name}
            </button>
          );
        })}
      </div>
    );
  }
  if (kind === 'label') {
    return (
      <select style={{ ...smallControlStyle, width: 170 }} value={String(leaf.value ?? '')} onChange={(e) => onChange(e.target.value)}>
        {REPLY_LABELS.map((l) => (
          <option key={l} value={l}>{REPLY_LABEL_META[l].name}</option>
        ))}
      </select>
    );
  }
  if (kind === 'number') {
    return (
      <input
        type="number"
        style={{ ...smallControlStyle, width: 90 }}
        value={leaf.value === undefined || leaf.value === null ? '' : String(leaf.value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    );
  }
  if (kind === 'tag') {
    if (ctx.tags.length === 0) return <span className="text-xs text-gray-400">No tags yet: create them on the Leads page (Manage tags)</span>;
    return (
      <select style={{ ...smallControlStyle, width: 150 }} value={String(leaf.value ?? '')} onChange={(e) => onChange(Number(e.target.value))}>
        {ctx.tags.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
    );
  }
  if (kind === 'stage') {
    return (
      <select style={{ ...smallControlStyle, width: 150 }} value={String(leaf.value ?? '')} onChange={(e) => onChange(Number(e.target.value))}>
        {ctx.stages.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      placeholder={leaf.field === 'reply_text_contains' ? 'e.g. pricing, demo' : 'value'}
      title={leaf.field === 'reply_text_contains' ? 'Separate several words with commas: any of them matches' : undefined}
      style={{ ...smallControlStyle, width: 170 }}
      value={Array.isArray(leaf.value) ? (leaf.value as string[]).join(', ') : String(leaf.value ?? '')}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function LeafEditor({ leaf, ctx, onChange, onRemove }: { leaf: CrmConditionLeaf; ctx: Ctx; onChange: (l: CrmConditionLeaf) => void; onRemove: () => void }) {
  const isCustom = leaf.field.startsWith('custom_field');
  const kind = fieldMeta(leaf.field)?.kind ?? 'text';
  const ops = OPERATORS_FOR[kind];

  const setField = (key: string) => {
    const field = key === 'custom_field' ? 'custom_field.' : key;
    const k = fieldMeta(field)?.kind ?? 'text';
    const operator = OPERATORS_FOR[k].includes(leaf.operator) ? leaf.operator : OPERATORS_FOR[k][0]!;
    onChange({ field, operator, value: defaultValueFor(field, ctx) });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select style={{ ...smallControlStyle, width: 190 }} value={isCustom ? 'custom_field' : leaf.field} onChange={(e) => setField(e.target.value)}>
        {FIELDS.map((f) => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>
      {isCustom && (
        <input
          placeholder="field name, e.g. industry"
          style={{ ...smallControlStyle, width: 150 }}
          value={leaf.field.slice('custom_field.'.length)}
          onChange={(e) => onChange({ ...leaf, field: `custom_field.${e.target.value.replace(/[^A-Za-z0-9 _.\-]/g, '')}` })}
        />
      )}
      <select
        style={{ ...smallControlStyle, width: 130 }}
        value={leaf.operator}
        onChange={(e) => {
          const operator = e.target.value;
          let value = leaf.value;
          if (operator === 'in' && !Array.isArray(value)) value = value ? [value] : [];
          if (operator !== 'in' && Array.isArray(value)) value = value[0] ?? defaultValueFor(leaf.field, ctx);
          if (operator === 'exists') value = true;
          if (leaf.operator === 'exists' && operator !== 'exists') value = defaultValueFor(leaf.field, ctx);
          onChange({ ...leaf, operator, value });
        }}
      >
        {ops.map((o) => (
          <option key={o} value={o}>{OPERATORS[o]}</option>
        ))}
      </select>
      <ValueInput leaf={leaf} ctx={ctx} onChange={(value) => onChange({ ...leaf, value })} />
      <button type="button" aria-label="Remove condition" title="Remove condition" className="hover:bg-gray-100" style={iconButtonStyle} onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

interface GroupEditorProps {
  group: CrmConditionGroup;
  ctx: Ctx;
  onChange: (g: CrmConditionGroup) => void;
  onRemove?: () => void;
  depth?: number;
}

/** AND/OR group with conditions and nested groups. */
export function ConditionBuilder({ group, ctx, onChange, onRemove, depth = 1 }: GroupEditorProps) {
  const setItem = (i: number, item: CrmConditionLeaf | CrmConditionGroup) => {
    const items = [...group.items];
    items[i] = item;
    onChange({ ...group, items });
  };
  const removeItem = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });

  return (
    <div
      className="rounded-lg space-y-2"
      style={{
        padding: depth === 1 ? 0 : 10,
        border: depth === 1 ? 'none' : '1px dashed #d1d5db',
        background: depth === 1 ? 'transparent' : depth % 2 === 0 ? '#f9fafb' : '#ffffff',
      }}
    >
      {group.items.length > 1 || depth > 1 ? (
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <span>Match</span>
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
            {(['AND', 'OR'] as const).map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => onChange({ ...group, op })}
                style={{
                  padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: group.op === op ? '#111827' : '#fff', color: group.op === op ? '#fff' : '#374151',
                }}
              >
                {op === 'AND' ? 'ALL (AND)' : 'ANY (OR)'}
              </button>
            ))}
          </div>
          <span>of these</span>
          {onRemove && (
            <button type="button" className="ml-auto hover:bg-gray-100" style={iconButtonStyle} title="Remove group" aria-label="Remove group" onClick={onRemove}>
              <X size={14} />
            </button>
          )}
        </div>
      ) : null}

      {group.items.length === 0 && depth === 1 && (
        <p className="text-xs text-gray-500">No conditions: the rule runs every time the trigger happens.</p>
      )}

      {group.items.map((item, i) =>
        isGroup(item) ? (
          <ConditionBuilder key={i} group={item} ctx={ctx} depth={depth + 1} onChange={(g) => setItem(i, g)} onRemove={() => removeItem(i)} />
        ) : (
          <LeafEditor key={i} leaf={item} ctx={ctx} onChange={(l) => setItem(i, l)} onRemove={() => removeItem(i)} />
        )
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 rounded-md border border-gray-300 hover:bg-gray-50"
          style={{ padding: '4px 8px' }}
          onClick={() => onChange({ ...group, items: [...group.items, newLeaf(ctx)] })}
        >
          <Plus size={12} /> Condition
        </button>
        {depth < MAX_DEPTH && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 rounded-md border border-gray-300 hover:bg-gray-50"
            style={{ padding: '4px 8px' }}
            onClick={() => onChange({ ...group, items: [...group.items, { op: group.op === 'AND' ? 'OR' : 'AND', items: [newLeaf(ctx)] }] })}
          >
            <FolderPlus size={12} /> Group
          </button>
        )}
      </div>
    </div>
  );
}
