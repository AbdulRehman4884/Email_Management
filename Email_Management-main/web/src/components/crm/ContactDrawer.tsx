import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2, Mail, Reply, X } from 'lucide-react';
import { crmApi, repliesApi, apiErrorMessage, type CrmContactDetail, type CrmStage, type CrmTag } from '../../lib/api';
import type { ReplyLabel } from '../../lib/replyLabels';
import { ContactTimeline } from './ContactTimeline';
import { useToast } from '../ui';
import { ReplyLabelChip } from './ReplyLabelChip';
import { TagChip, TagPicker } from './TagChip';
import { LabelDot } from './ContactCard';
import { controlStyle } from './builderStyles';
import { ScoreBadge, ScoreBreakdown } from './ScoreBadge';

interface ContactDrawerProps {
  contactId: number;
  tags: CrmTag[];
  onCreateTag: (name: string) => Promise<CrmTag>;
  onClose: () => void;
  /** Called after a change (tags, stage) so the list can refresh. */
  onChanged: () => void;
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const REASON: Record<string, string> = { created: 'Lead created', rule: 'Moved by rule', manual: 'Moved by you', backfill: 'Imported' };

/** Lead details on the right side: latest reply color, stage, tags, campaigns, replies, history. */
export function ContactDrawer({ contactId, tags, onCreateTag, onClose, onChanged }: ContactDrawerProps) {
  const toast = useToast();
  const [detail, setDetail] = useState<CrmContactDetail | null>(null);
  const [stages, setStages] = useState<CrmStage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await crmApi.getContact(contactId);
      setDetail(d);
      setError(null);
      if (d.contact.pipelineId) {
        crmApi.getPipeline(d.contact.pipelineId).then((p) => setStages(p.stages)).catch(() => setStages([]));
      }
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load this lead'));
    }
  }, [contactId]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const c = detail?.contact;

  const addTag = async (t: CrmTag) => {
    try {
      await crmApi.addContactTag(contactId, t.id);
      setDetail((d) => (d ? { ...d, contact: { ...d.contact, tags: [...d.contact.tags, t].sort((a, b) => a.name.localeCompare(b.name)) } } : d));
      onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add the tag'));
    }
  };
  const removeTag = async (t: CrmTag) => {
    try {
      await crmApi.removeContactTag(contactId, t.id);
      setDetail((d) => (d ? { ...d, contact: { ...d.contact, tags: d.contact.tags.filter((x) => x.id !== t.id) } } : d));
      onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not remove the tag'));
    }
  };
  // Step 8: change a reply's label from the drawer (same as in the Inbox).
  const changeLabel = async (replyId: number, label: ReplyLabel) => {
    try {
      await repliesApi.updateLabel(replyId, label);
      await load();
      onChanged();
      toast.success('Label changed');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not change the label'));
    }
  };
  const latestInbound = detail?.replies.find((r) => r.direction !== 'outbound') ?? null;

  const moveTo = async (stageId: number) => {
    setMoving(true);
    try {
      await crmApi.bulkUpdateContacts({ contactIds: [contactId], moveToStageId: stageId });
      await load();
      onChanged();
      toast.success('Lead moved');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not move the lead'));
    } finally {
      setMoving(false);
    }
  };

  return (
    // margin 0: pages use space-y-* which would push a fixed overlay down.
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, margin: 0 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.25)' }} />
      <aside
        aria-label="Lead details"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(440px, 100vw)',
          background: 'var(--crm-surface, #fff)',
          color: 'var(--crm-text, #111827)',
          boxShadow: '-8px 0 30px rgba(0,0,0,.12)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '16px 18px', borderBottom: '1px solid var(--crm-border, #e5e7eb)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="text-base font-semibold text-gray-900 truncate">{c ? c.name || c.email : 'Lead'}</p>
            {c && (
              <p className="text-xs text-gray-500 truncate">
                {c.email}
                {c.company ? ` · ${c.company}` : ''}
              </p>
            )}
          </div>
          {latestInbound && (
            <Link
              to={`/inbox?thread=${latestInbound.threadRootId ?? latestInbound.id}&reply=${latestInbound.id}`}
              className="rounded-lg text-xs font-medium"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', background: 'var(--crm-accent, #111827)', color: 'var(--crm-accent-text, #fff)', whiteSpace: 'nowrap' }}
              title="Open this conversation in the Inbox to reply"
            >
              <Reply size={13} /> Reply
            </Link>
          )}
          <button type="button" aria-label="Close" onClick={onClose} className="hover:bg-gray-100 rounded-lg" style={{ padding: 6, color: '#6b7280' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 24px' }}>
          {error && <p className="text-sm" style={{ color: '#b91c1c' }}>{error}</p>}
          {!detail && !error && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <Loader2 className="animate-spin" size={22} color="#9ca3af" />
            </div>
          )}
          {c && detail && (
            <div className="space-y-4">
              <section>
                <h4 style={sectionTitle}>Latest reply</h4>
                <LabelDot label={c.lastReplyLabel} />
              </section>

              <section>
                <h4 style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
                  Lead score <ScoreBadge score={c.score} tier={c.scoreTier} />
                </h4>
                <ScoreBreakdown breakdown={detail.score?.breakdown ?? []} events={detail.score?.events ?? []} score={c.score} />
              </section>

              <section>
                <h4 style={sectionTitle}>Stage {c.pipelineName ? <span style={{ fontWeight: 400, color: '#9ca3af' }}>· {c.pipelineName}</span> : null}</h4>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <select
                    aria-label="Move to stage"
                    value={c.stageId ?? ''}
                    disabled={moving || stages.length === 0}
                    onChange={(e) => e.target.value && void moveTo(Number(e.target.value))}
                    style={{ ...controlStyle, flex: 1 }}
                  >
                    {c.stageId == null && <option value="">No stage</option>}
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {/* CRM-10: no "Lost (Lost)": the type only when the name does not already say it */}
                        {s.type !== 'normal' && s.name.trim().toLowerCase() !== s.type ? ` (${s.type === 'won' ? 'Won' : 'Lost'})` : ''}
                      </option>
                    ))}
                  </select>
                  {moving && <Loader2 className="animate-spin" size={16} color="#6b7280" />}
                </div>
                {c.stageEnteredAt && <p className="text-xs text-gray-400 mt-1">In this stage since {fmt(c.stageEnteredAt)}</p>}
              </section>

              <section>
                <h4 style={sectionTitle}>Tags</h4>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {c.tags.map((t) => (
                    <TagChip key={t.id} tag={t} onRemove={() => void removeTag(t)} />
                  ))}
                  <TagPicker
                    tags={tags}
                    target="contact"
                    selectedIds={c.tags.map((t) => t.id)}
                    onAdd={addTag}
                    onRemove={removeTag}
                    onCreate={onCreateTag}
                  />
                </div>
              </section>

              <section>
                <h4 style={sectionTitle}>Activity</h4>
                <div className="text-xs text-gray-600" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
                  <span className="text-gray-400">Last reply</span><span>{fmt(c.lastInboundAt)}</span>
                  <span className="text-gray-400">Last email sent</span><span>{fmt(c.lastOutboundAt)}</span>
                  <span className="text-gray-400">Opens</span><span>{c.openCount}</span>
                  <span className="text-gray-400">Follow-ups</span><span>{c.followUpsStopped ? (c.followUpsStoppedBy === 'stage' && c.stageName ? `Stopped (stage ${c.stageName})` : 'Stopped') : 'Allowed'}</span>
                </div>
              </section>

              <section>
                <h4 style={sectionTitle}>Campaigns ({detail.campaigns.length})</h4>
                {detail.campaigns.length === 0 && <p className="text-xs text-gray-400">None</p>}
                <div className="space-y-2">
                  {detail.campaigns.map((x) => (
                    <Link
                      key={x.recipientId}
                      to={`/campaigns/${x.id}`}
                      className="hover:bg-gray-50 rounded-lg border"
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 13, color: 'var(--crm-text, #111827)' }}
                    >
                      <Mail size={13} color="#9ca3af" />
                      <span className="truncate" style={{ flex: 1 }}>{x.name}</span>
                      <span className="text-xs text-gray-400">{x.repliedAt ? 'replied' : x.openedAt ? 'opened' : x.status}</span>
                      <ArrowRight size={13} color="#9ca3af" />
                    </Link>
                  ))}
                </div>
              </section>

              <section>
                <h4 style={sectionTitle}>Latest messages</h4>
                {detail.replies.length === 0 && <p className="text-xs text-gray-400">No replies yet</p>}
                <div className="space-y-2">
                  {detail.replies.slice(0, 8).map((r) => (
                    <div key={r.id} className="rounded-lg border" style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="text-xs text-gray-400" style={{ flex: 1 }}>
                          {r.direction === 'outbound' ? 'You' : 'Lead'} · {fmt(r.receivedAt)}
                        </span>
                        {r.direction !== 'outbound' && <ReplyLabelChip label={r.label} source={r.labelSource} onChange={(l) => changeLabel(r.id, l)} />}
                      </div>
                      <p className="text-sm text-gray-900 truncate" style={{ marginTop: 2 }}>{r.subject}</p>
                      {r.snippet && <p className="text-xs text-gray-500" style={{ marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.snippet}</p>}
                    </div>
                  ))}
                </div>
                {latestInbound && (
                  <Link
                    to={`/inbox?thread=${latestInbound.threadRootId ?? latestInbound.id}&reply=${latestInbound.id}`}
                    className="text-xs text-gray-600"
                    style={{ display: 'inline-block', marginTop: 6, textDecoration: 'underline' }}
                  >
                    Open the conversation to reply
                  </Link>
                )}
              </section>

              {detail.timeline && (
                <section>
                  <h4 style={sectionTitle}>Timeline</h4>
                  <ContactTimeline items={detail.timeline} />
                </section>
              )}

              <section>
                <h4 style={sectionTitle}>Stage history</h4>
                {detail.history.length === 0 && <p className="text-xs text-gray-400">No moves yet</p>}
                <ol className="space-y-2">
                  {detail.history.map((h) => (
                    <li key={h.id} className="text-xs text-gray-600">
                      <span className="text-gray-900">{h.fromName ? `${h.fromName} → ` : ''}{h.toName ?? 'a deleted stage'}</span>
                      <span className="text-gray-400">
                        {' '}· {h.reason === 'rule' && h.ruleName ? `rule “${h.ruleName}”` : REASON[h.reason ?? ''] ?? h.reason} · {fmt(h.at)}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: '#6b7280',
  marginBottom: 6,
};
