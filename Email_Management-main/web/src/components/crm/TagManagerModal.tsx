import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { crmApi, apiErrorMessage, type CrmTag } from '../../lib/api';
import { Button, ConfirmDialog, Modal, useToast } from '../ui';
import { controlStyle, iconButtonStyle, smallControlStyle } from './builderStyles';
import { hex6 } from './TagChip';

interface TagManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  tags: CrmTag[];
  colors: string[];
  /** Reload tags (and anything showing them) after a change. */
  onChanged: () => void | Promise<void>;
}

const SCOPE_LABEL: Record<string, string> = { both: 'Leads + campaigns', contact: 'Leads only', campaign: 'Campaigns only' };

/** Create, rename, recolor and delete tags. */
export function TagManagerModal({ isOpen, onClose, tags, colors, onChanged }: TagManagerModalProps) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState(colors[0] ?? '#6366f1');
  const [scope, setScope] = useState<'both' | 'contact' | 'campaign'>('both');
  const [saving, setSaving] = useState(false);
  const [names, setNames] = useState<Record<number, string>>({});
  const [confirm, setConfirm] = useState<CrmTag | null>(null);
  const [deleting, setDeleting] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await crmApi.createTag({ name: name.trim(), color, scope });
      setName('');
      setColor(colors[(tags.length + 1) % colors.length] ?? color);
      await onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not create the tag'));
    } finally {
      setSaving(false);
    }
  };

  const update = async (tag: CrmTag, patch: Partial<Pick<CrmTag, 'name' | 'color' | 'scope'>>) => {
    try {
      await crmApi.updateTag(tag.id, patch);
      await onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the tag'));
      setNames((n) => ({ ...n, [tag.id]: tag.name }));
    }
  };

  const remove = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      const r = await crmApi.deleteTag(confirm.id);
      toast.success(r.rulesTurnedOff ? `Tag deleted. ${r.rulesTurnedOff} rule(s) that used it were turned off.` : 'Tag deleted');
      setConfirm(null);
      await onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not delete the tag'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} title="Tags" size="lg">
        <div className="space-y-4">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="New tag color" style={{ width: 34, height: 34, padding: 0, border: 'none', background: 'none' }} />
            <input
              value={name}
              maxLength={50}
              placeholder="New tag name, e.g. VIP"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
              style={{ ...controlStyle, flex: 1, minWidth: 160 }}
            />
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Where the tag is used" style={{ ...controlStyle, width: 160 }}>
              {Object.entries(SCOPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <Button size="sm" onClick={() => void create()} isLoading={saving} disabled={!name.trim()} leftIcon={<Plus className="w-4 h-4" />}>
              Add
            </Button>
          </div>

          {tags.length === 0 ? (
            <p className="text-sm text-gray-500">No tags yet. Tags help you group leads (VIP, Agency, Q4 list…) and can be used in pipeline rules.</p>
          ) : (
            <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 10 }}>
              {tags.map((t) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
                  <input
                    type="color"
                    value={hex6(t.color)}
                    aria-label={`Color of ${t.name}`}
                    onChange={(e) => void update(t, { color: e.target.value })}
                    style={{ width: 24, height: 24, padding: 0, border: 'none', background: 'none', flexShrink: 0 }}
                  />
                  <input
                    value={names[t.id] ?? t.name}
                    maxLength={50}
                    aria-label="Tag name"
                    onChange={(e) => setNames((n) => ({ ...n, [t.id]: e.target.value }))}
                    onBlur={() => {
                      const v = (names[t.id] ?? t.name).trim();
                      if (v && v !== t.name) void update(t, { name: v });
                      else setNames((n) => ({ ...n, [t.id]: t.name }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    style={{ ...smallControlStyle, flex: 1, fontWeight: 600, border: '1px solid transparent' }}
                  />
                  <select
                    value={t.scope ?? 'both'}
                    aria-label={`Where ${t.name} is used`}
                    onChange={(e) => void update(t, { scope: e.target.value as CrmTag['scope'] })}
                    style={{ ...smallControlStyle, width: 140 }}
                  >
                    {Object.entries(SCOPE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                  <span className="text-xs text-gray-500" style={{ width: 120, textAlign: 'right', flexShrink: 0 }}>
                    {t.contactCount ?? 0} lead(s) · {t.campaignCount ?? 0} camp.
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete tag ${t.name}`}
                    className="hover:bg-red-50 hover:text-red-600"
                    style={iconButtonStyle}
                    onClick={() => setConfirm(t)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        isOpen={confirm != null}
        title="Delete tag?"
        message={
          confirm ? (
            <>
              “{confirm.name}” is removed from {confirm.contactCount ?? 0} lead(s) and {confirm.campaignCount ?? 0} campaign(s). Pipeline rules that use
              this tag are turned off (not deleted) so you can fix them.
            </>
          ) : ''
        }
        confirmLabel="Delete tag"
        variant="danger"
        isLoading={deleting}
        onConfirm={() => void remove()}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
