import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { campaignApi, followUpApi } from '../lib/api';
import type { Campaign, FollowUpEngagement, FollowUpTemplate } from '../types';
import { Button, Card, CardContent, PageLoader, useToast } from '../components/ui';
import { datetimeLocalToWallClock } from '../lib/localScheduleFormat';
import { ISO_WEEKDAY_OPTIONS } from '../lib/isoWeekdays';
import { useCampaignStore } from '../store';
import { useReportingScope } from '../lib/reportingScope';

export function FollowUpSchedule() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetCampaignId = Number(searchParams.get('campaignId'));
  const { campaigns, fetchCampaigns, isLoading: campaignsLoading } = useCampaignStore();
  const { scopeSmtpProfileId, scopedCampaigns } = useReportingScope();

  const [campaignId, setCampaignId] = useState<number>(() =>
    Number.isFinite(presetCampaignId) && presetCampaignId > 0 ? presetCampaignId : 0
  );
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loadingCampaign, setLoadingCampaign] = useState(false);

  const [priorFollowUpCount, setPriorFollowUpCount] = useState(0);
  const [engagement, setEngagement] = useState<FollowUpEngagement>('sent');
  const [templateId, setTemplateId] = useState('');
  const [scheduledLocal, setScheduledLocal] = useState('');
  const [maxRunDurationStr, setMaxRunDurationStr] = useState('');
  const [maxRunDurationUnit, setMaxRunDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sendWeekdaysEnabled, setSendWeekdaysEnabled] = useState(false);
  const [selectedSendWeekdays, setSelectedSendWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);

  const [addTplOpen, setAddTplOpen] = useState(false);
  const [tplForm, setTplForm] = useState({ title: '', subject: '', body: '' });
  const [tplSaving, setTplSaving] = useState(false);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  useEffect(() => {
    const ids = new Set(scopedCampaigns.map((c) => Number(c.id)));
    if (campaignId > 0 && !ids.has(campaignId)) {
      setCampaignId(0);
    }
  }, [scopedCampaigns, campaignId]);

  useEffect(() => {
    if (!campaignId || campaignId < 1) {
      setCampaign(null);
      setTemplateId('');
      return;
    }
    let alive = true;
    setLoadingCampaign(true);
    campaignApi
      .getById(campaignId)
      .then((c) => {
        if (!alive) return;
        setCampaign(c);
        const tpls = c.followUpTemplates ?? [];
        setTemplateId((prev) => {
          if (prev && tpls.some((t) => t.id === prev)) return prev;
          return tpls[0]?.id ?? '';
        });
      })
      .catch(() => {
        if (alive) setCampaign(null);
      })
      .finally(() => {
        if (alive) setLoadingCampaign(false);
      });
    return () => {
      alive = false;
    };
  }, [campaignId]);

  const templates = campaign?.followUpTemplates ?? [];

  const refreshPreview = async () => {
    if (!campaignId || !templateId) {
      setPreviewCount(null);
      return;
    }
    try {
      const { count } = await followUpApi.previewCount({
        campaignId,
        templateId,
        priorFollowUpCount,
        engagement,
      });
      setPreviewCount(count);
    } catch {
      setPreviewCount(null);
    }
  };

  useEffect(() => {
    void refreshPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preview when inputs change
  }, [campaignId, templateId, priorFollowUpCount, engagement]);

  const scheduleWall = useMemo(() => datetimeLocalToWallClock(scheduledLocal), [scheduledLocal]);

  const toggleSendWeekday = (iso: number) => {
    setSelectedSendWeekdays((prev) => {
      const next = prev.includes(iso) ? prev.filter((x) => x !== iso) : [...prev, iso].sort((a, b) => a - b);
      return next;
    });
  };

  const saveNewTemplate = async () => {
    if (!campaign) return;
    const title = tplForm.title.trim();
    const subject = tplForm.subject.trim();
    const body = tplForm.body.trim();
    if (!subject || !body) {
      toast.error('Subject and message are required');
      return;
    }
    setTplSaving(true);
    try {
      const list: FollowUpTemplate[] = [...(campaign.followUpTemplates ?? [])];
      const id = crypto.randomUUID();
      list.push({ id, title: title || `Follow-up ${list.length + 1}`, subject, body });
      const updated = await campaignApi.patchFollowUpSettings(campaign.id, { followUpTemplates: list });
      setCampaign(updated);
      setTemplateId(id);
      setAddTplOpen(false);
      setTplForm({ title: '', subject: '', body: '' });
      toast.success('Template saved on campaign');
    } catch {
      toast.error('Could not save template');
    } finally {
      setTplSaving(false);
    }
  };

  const submit = async () => {
    if (!campaignId || campaignId < 1) {
      toast.error('Select a campaign');
      return;
    }
    if (!templateId) {
      toast.error('Select or add a follow-up template');
      return;
    }
    const scheduledAt = datetimeLocalToWallClock(scheduledLocal);
    if (!scheduledAt) {
      toast.error('Pick a valid schedule date and time');
      return;
    }
    let maxRunMinutes: number | null = null;
    const rawMax = maxRunDurationStr.trim();
    if (rawMax) {
      const n = Number(rawMax);
      const mult = maxRunDurationUnit === 'hours' ? 60 : 1;
      const mins = Math.floor(n * mult);
      if (!Number.isFinite(n) || n < 1 || mins < 1 || mins > 10080) {
        toast.error('Max run must be between 1 minute and 7 days (10080 minutes).');
        return;
      }
      maxRunMinutes = mins;
    }
    if (sendWeekdaysEnabled && selectedSendWeekdays.length === 0) {
      toast.error('Pick at least one weekday, or turn off day filtering.');
      return;
    }
    setSubmitting(true);
    try {
      await followUpApi.createJob({
        campaignId,
        scheduledAt,
        templateId,
        priorFollowUpCount,
        engagement,
        ...(maxRunMinutes != null ? { maxRunMinutes } : {}),
        ...(sendWeekdaysEnabled ? { sendWeekdays: selectedSendWeekdays } : {}),
      });
      if (maxRunMinutes != null) {
        const hr = maxRunMinutes % 60 === 0 && maxRunMinutes >= 60;
        const lbl = hr
          ? `${maxRunMinutes / 60} hour${maxRunMinutes === 60 ? '' : 's'}`
          : `${maxRunMinutes} minute${maxRunMinutes === 1 ? '' : 's'}`;
        toast.success(`Follow-up job scheduled · stops after ${lbl} from start (unless the queue finishes earlier)`);
      } else {
        toast.success('Follow-up job scheduled · runs until every matching recipient is processed');
      }
      navigate('/follow-ups');
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'response' in e
          ? (e as { response?: { data?: { error?: string } } }).response?.data?.error
          : undefined;
      toast.error(typeof msg === 'string' ? msg : 'Could not schedule job');
    } finally {
      setSubmitting(false);
    }
  };

  if (campaignsLoading && campaigns.length === 0) return <PageLoader />;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <button
        type="button"
        onClick={() => navigate('/follow-ups')}
        className="flex items-center text-gray-500 hover:text-gray-900 text-sm transition-colors"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to Follow-up
      </button>

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Schedule bulk follow-up</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Targets only recipients who already received the primary send for this campaign (for example your first 25
          sends). If the campaign is running when the job starts, it will pause until you resume after the job finishes.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Campaign</label>
            <select
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-900/15"
              value={campaignId || ''}
              onChange={(e) => setCampaignId(Number(e.target.value))}
            >
              <option value="">Select campaign…</option>
              {scopedCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {scopeSmtpProfileId != null && scopedCampaigns.length === 0 && (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mt-2">
                No campaigns use the SMTP profile selected under Settings → Reports and inbox scope. Choose
                &quot;All SMTP accounts&quot; there to schedule for any campaign, or pick a profile that matches your
                campaign&apos;s sender account.
              </p>
            )}
          </div>

          {loadingCampaign && campaignId > 0 ? (
            <PageLoader />
          ) : campaign ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Prior follow-up count (exact)
                </label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm tabular-nums"
                  value={priorFollowUpCount}
                  onChange={(e) => setPriorFollowUpCount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Use <strong>0</strong> for recipients who have not received any follow-up yet; <strong>1</strong> before
                  sending the second follow-up, etc.
                </p>
              </div>

              <div>
                <span className="block text-sm font-medium text-gray-700 mb-2">Audience</span>
                <div className="flex flex-wrap gap-4 text-sm">
                  {(['sent', 'opened', 'delivered'] as const).map((v) => (
                    <label key={v} className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="engagement"
                        checked={engagement === v}
                        onChange={() => setEngagement(v)}
                      />
                      <span className="capitalize">{v}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Primary email must be sent. <strong>Opened</strong> / <strong>delivered</strong> narrow the list using
                  tracking columns on recipients.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="text-sm font-medium text-gray-700">Follow-up template</label>
                  <button
                    type="button"
                    className="text-xs font-medium text-gray-700 hover:text-gray-900"
                    onClick={() => setAddTplOpen((o) => !o)}
                  >
                    {addTplOpen ? 'Close editor' : 'Add template for this campaign'}
                  </button>
                </div>
                {templates.length === 0 && !addTplOpen ? (
                  <p className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    No templates yet. Add one below (saved on this campaign).
                  </p>
                ) : (
                  <select
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-900/15"
                    value={templateId}
                    onChange={(e) => setTemplateId(e.target.value)}
                  >
                    <option value="">Choose template…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title || t.subject || t.id}
                      </option>
                    ))}
                  </select>
                )}

                {addTplOpen && (
                  <div className="mt-3 space-y-2 border border-gray-100 rounded-lg p-3 bg-gray-50">
                    <input
                      placeholder="Title (optional)"
                      className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm"
                      value={tplForm.title}
                      onChange={(e) => setTplForm((p) => ({ ...p, title: e.target.value }))}
                    />
                    <input
                      placeholder="Subject"
                      className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm"
                      value={tplForm.subject}
                      onChange={(e) => setTplForm((p) => ({ ...p, subject: e.target.value }))}
                    />
                    <textarea
                      placeholder="Body (placeholders supported)"
                      rows={4}
                      className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm font-mono"
                      value={tplForm.body}
                      onChange={(e) => setTplForm((p) => ({ ...p, body: e.target.value }))}
                    />
                    <Button size="sm" onClick={() => void saveNewTemplate()} isLoading={tplSaving}>
                      Save template on campaign
                    </Button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Run at (local)</label>
                <input
                  type="datetime-local"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  value={scheduledLocal}
                  onChange={(e) => setScheduledLocal(e.target.value)}
                />
                {scheduleWall && (
                  <p className="text-xs text-gray-500 mt-1">
                    Sends as <code className="bg-gray-100 px-1 rounded">{scheduleWall}</code> (wall clock for API)
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-4 space-y-3">
                <p className="text-sm font-medium text-gray-800">How long the job may send (optional)</p>
                <p className="text-xs text-gray-500">
                  Same idea as campaign send window: leave empty to process every matching recipient. Otherwise the job
                  stops after this much time from when it actually starts (delays between emails count).
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Max run duration</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="e.g. 2 — leave empty for no limit"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                      value={maxRunDurationStr}
                      onChange={(e) => setMaxRunDurationStr(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Unit</label>
                    <select
                      value={maxRunDurationUnit}
                      onChange={(e) =>
                        setMaxRunDurationUnit(e.target.value as 'minutes' | 'hours')
                      }
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white"
                    >
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setSendWeekdaysEnabled((v) => {
                      const next = !v;
                      if (next) setSelectedSendWeekdays((s) => (s.length === 0 ? [1, 2, 3, 4, 5] : s));
                      return next;
                    });
                  }}
                  className={`toggle-switch ${sendWeekdaysEnabled ? 'active' : ''}`}
                  role="switch"
                  aria-checked={sendWeekdaysEnabled}
                />
                <span className="text-sm font-medium text-gray-700">Only send on selected weekdays</span>
              </div>
              {sendWeekdaysEnabled && (
                <div className="rounded-lg border border-gray-100 bg-gray-50/80 p-4 space-y-2">
                  <p className="text-xs text-gray-500">
                    Job waits (same timezone as server schedule) until an allowed day before each send.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ISO_WEEKDAY_OPTIONS.map(({ iso, short }) => {
                      const on = selectedSendWeekdays.includes(iso);
                      return (
                        <button
                          key={iso}
                          type="button"
                          onClick={() => toggleSendWeekday(iso)}
                          className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                            on
                              ? 'bg-gray-900 text-white border-gray-900'
                              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {short}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-sm">
                <span className="text-gray-600">Matching recipients:</span>{' '}
                <strong className="tabular-nums">{previewCount ?? '—'}</strong>
                <Button variant="secondary" size="sm" className="ml-3" type="button" onClick={() => void refreshPreview()}>
                  Refresh count
                </Button>
              </div>

              <Button className="w-full sm:w-auto" onClick={() => void submit()} isLoading={submitting}>
                Schedule job
              </Button>
            </>
          ) : campaignId ? (
            <p className="text-sm text-red-600">Could not load campaign.</p>
          ) : null}
        </CardContent>
      </Card>

      <p className="text-xs text-gray-500">
        Manage templates anytime under{' '}
        <Link className="underline" to={campaign ? `/campaigns/${campaign.id}` : '/campaigns'}>
          campaign detail
        </Link>
        .
      </p>
    </div>
  );
}
