import React, { useEffect, useRef, useState } from 'react';
import { GripVertical, Plus, Trash2, Users } from 'lucide-react';
import type { CrmStage } from '../../lib/api';
import { iconButtonStyle, smallControlStyle } from './builderStyles';

interface StageListProps {
  stages: CrmStage[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Save one changed field of a stage. */
  onUpdate: (stage: CrmStage, patch: Partial<CrmStage>) => Promise<void>;
  onReorder: (stageIds: number[]) => Promise<void>;
  onDelete: (stage: CrmStage) => void;
  onAdd: () => void;
}

const TYPE_LABEL: Record<string, string> = { normal: 'Normal', won: 'Won', lost: 'Lost' };

/** Left side of the Pipeline Builder: stages as draggable rows. */
export function StageList({ stages, selectedId, onSelect, onUpdate, onReorder, onDelete, onAdd }: StageListProps) {
  const [order, setOrder] = useState<CrmStage[]>(stages);
  const [dragId, setDragId] = useState<number | null>(null);
  /** Ref copy so drop + dragend (both fire) only save once. */
  const draggingRef = useRef<number | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});

  useEffect(() => {
    setOrder(stages);
    setNames(Object.fromEntries(stages.map((s) => [s.id, s.name])));
  }, [stages]);

  const moveOver = (overId: number) => {
    if (dragId == null || dragId === overId) return;
    setOrder((prev) => {
      const from = prev.findIndex((s) => s.id === dragId);
      const to = prev.findIndex((s) => s.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  };

  const finishDrag = async () => {
    if (draggingRef.current == null) return;
    draggingRef.current = null;
    const changed = order.some((s, i) => stages[i]?.id !== s.id);
    setDragId(null);
    if (changed) await onReorder(order.map((s) => s.id));
  };

  const saveName = async (stage: CrmStage) => {
    const name = (names[stage.id] ?? '').trim();
    if (!name || name === stage.name) {
      setNames((n) => ({ ...n, [stage.id]: stage.name }));
      return;
    }
    await onUpdate(stage, { name });
  };

  return (
    <div className="space-y-2">
      {order.map((stage) => {
        const selected = stage.id === selectedId;
        return (
          <div
            key={stage.id}
            draggable
            onDragStart={(e) => {
              setDragId(stage.id);
              draggingRef.current = stage.id;
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              moveOver(stage.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              void finishDrag();
            }}
            onDragEnd={() => void finishDrag()}
            onClick={() => onSelect(stage.id)}
            className="rounded-lg border bg-white transition-colors"
            style={{
              padding: 10,
              cursor: 'pointer',
              borderColor: selected ? '#111827' : '#e5e7eb',
              boxShadow: selected ? '0 0 0 1px #111827' : undefined,
              opacity: dragId === stage.id ? 0.5 : 1,
            }}
          >
            <div className="flex items-center gap-2">
              <span title="Drag to reorder" style={{ ...iconButtonStyle, width: 18, cursor: 'grab', color: '#9ca3af' }}>
                <GripVertical size={16} />
              </span>
              <input
                type="color"
                value={stage.color}
                title="Stage color"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => void onUpdate(stage, { color: e.target.value })}
                style={{ width: 26, height: 26, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
              />
              <input
                value={names[stage.id] ?? stage.name}
                maxLength={100}
                aria-label="Stage name"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(stage.id);
                }}
                onChange={(e) => setNames((n) => ({ ...n, [stage.id]: e.target.value }))}
                onBlur={() => void saveName(stage)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                style={{ ...smallControlStyle, flex: 1, fontWeight: 600, fontSize: 13, border: '1px solid transparent', background: 'transparent' }}
                onFocus={(e) => (e.target.style.borderColor = '#d1d5db')}
              />
              <span
                title={`${stage.contactCount} lead(s) in this stage`}
                className="inline-flex items-center gap-1 text-xs text-gray-500"
                style={{ flexShrink: 0 }}
              >
                <Users size={12} />
                {stage.contactCount}
              </span>
              <button
                type="button"
                title="Delete stage"
                aria-label={`Delete stage ${stage.name}`}
                className="hover:bg-red-50 hover:text-red-600"
                style={iconButtonStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(stage);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>

            <div className="flex items-center gap-3 flex-wrap mt-2" style={{ paddingLeft: 26 }} onClick={(e) => e.stopPropagation()}>
              <select
                value={stage.type}
                aria-label="Stage type"
                onChange={(e) => {
                  const newType = e.target.value as CrmStage['type'];
                  const patch: Partial<CrmStage> = { type: newType };
                  if ((newType === 'won' || newType === 'lost') && !stage.stopFollowUps) {
                    patch.stopFollowUps = true;
                  }
                  void onUpdate(stage, patch);
                }}
                style={{ ...smallControlStyle, width: 92 }}
              >
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <label className="inline-flex items-center gap-1 text-xs text-gray-600" title="Rules never move leads into or out of this stage">
                <input type="checkbox" checked={stage.manualOnly} onChange={(e) => void onUpdate(stage, { manualOnly: e.target.checked })} />
                Manual only
              </label>
              <label className="inline-flex items-center gap-1 text-xs text-gray-600" title="Leads in this stage get no automatic follow-ups">
                <input type="checkbox" checked={stage.stopFollowUps} onChange={(e) => void onUpdate(stage, { stopFollowUps: e.target.checked })} />
                Stop follow-ups
              </label>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
        style={{ padding: '10px 0' }}
      >
        <Plus size={16} /> Add stage
      </button>
    </div>
  );
}
