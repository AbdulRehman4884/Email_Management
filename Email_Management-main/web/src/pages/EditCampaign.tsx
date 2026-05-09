import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, PageLoader, Modal, useToast, RichTextEditor } from '../components/ui';
import type { UpdateCampaignPayload, TemplateId } from '../types';
import { settingsApi, isSmtpConfigured, type SmtpSettingsResponse } from '../lib/api';
import { buildPreviewHtml, sanitizeHtmlForIframe, TEMPLATE_DEFAULTS, parseStoredCampaignHtml } from '../lib/emailPreview';
import { CAMPAIGN_LIMITS, maxLenMessage, emailHtmlTooLongMessage } from '../lib/fieldLimits';
import { localScheduleStringToDate } from '../lib/localScheduleFormat';

function toDatetimeLocalValue(dateStr: string): string {
  return dateStr.replace(' ', 'T').slice(0, 16);
}

export function EditCampaign() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentCampaign, isLoading, error, fetchCampaign, updateCampaign, clearError, clearCurrentCampaign } = useCampaignStore();

  const [smtpProfileOptions, setSmtpProfileOptions] = useState<SmtpSettingsResponse[]>([]);

  const [formData, setFormData] = useState<UpdateCampaignPayload>({
    name: '',
    subject: '',
    emailContent: '',
    fromName: '',
    fromEmail: '',
    scheduledAt: null,
    pauseAt: null,
    smtpSettingsId: undefined,
  });
  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>(() => ({ ...TEMPLATE_DEFAULTS.simple }));
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});
  const [pausedDailyStr, setPausedDailyStr] = useState('');
  const [pauseScheduleMode, setPauseScheduleMode] = useState<'datetime' | 'duration'>('datetime');
  const [pauseDurationStr, setPauseDurationStr] = useState('');
  const [pauseDurationUnit, setPauseDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [smtpReady, setSmtpReady] = useState(false);
  const [smtpModalOpen, setSmtpModalOpen] = useState(false);
  const campaignId = Number(id);

  useEffect(() => {
    if (campaignId) fetchCampaign(campaignId);
    return () => {
      clearCurrentCampaign();
    };
  }, [campaignId, fetchCampaign, clearCurrentCampaign]);

  useEffect(() => {
    if (!currentCampaign) return;

    settingsApi
      .getSmtp()
      .then((smtp) => {
        const profiles =
          smtp.profiles && smtp.profiles.length > 0
            ? smtp.profiles
            : smtp.id
              ? [smtp]
              : [];
        setSmtpProfileOptions(profiles);
        setSmtpReady(profiles.length > 0);
        const campSmtpId = currentCampaign.smtpSettingsId ?? undefined;
        const pick = profiles.find((p) => p.id === campSmtpId) ?? profiles[0];
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          smtpSettingsId: pick?.id ?? campSmtpId,
          fromName: pick?.fromName ?? currentCampaign.fromName,
          fromEmail: pick?.fromEmail ?? currentCampaign.fromEmail,
          scheduledAt: currentCampaign.scheduledAt,
          pauseAt: currentCampaign.pauseAt,
          dailySendLimit: currentCampaign.dailySendLimit ?? undefined,
        });
        setPausedDailyStr(
          currentCampaign.dailySendLimit != null ? String(currentCampaign.dailySendLimit) : ''
        );
      })
      .catch(() => {
        setSmtpReady(false);
        setSmtpProfileOptions([]);
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          smtpSettingsId: currentCampaign.smtpSettingsId ?? undefined,
          fromName: currentCampaign.fromName,
          fromEmail: currentCampaign.fromEmail,
          scheduledAt: currentCampaign.scheduledAt,
          pauseAt: currentCampaign.pauseAt,
          dailySendLimit: currentCampaign.dailySendLimit ?? undefined,
        });
        setPausedDailyStr(
          currentCampaign.dailySendLimit != null ? String(currentCampaign.dailySendLimit) : ''
        );
      });

    const parsed = parseStoredCampaignHtml(currentCampaign.emailContent);
    if (parsed) {
      setTemplateId(parsed.templateId);
      setTemplateData({ ...TEMPLATE_DEFAULTS[parsed.templateId], ...parsed.templateData });
    } else {
      setTemplateId('simple');
      setTemplateData({ ...TEMPLATE_DEFAULTS.simple });
    }

    const ap = currentCampaign.autoPauseAfterMinutes;
    if (ap != null && ap > 0) {
      setPauseScheduleMode('duration');
      if (ap % 60 === 0 && ap / 60 <= 168) {
        setPauseDurationUnit('hours');
        setPauseDurationStr(String(ap / 60));
      } else {
        setPauseDurationUnit('minutes');
        setPauseDurationStr(String(ap));
      }
    } else {
      setPauseScheduleMode('datetime');
      setPauseDurationStr('');
      setPauseDurationUnit('hours');
    }
  }, [currentCampaign]);

  const validate = () => {
    const errors: Partial<Record<string, string>> = {};
    const nameVal = formData.name?.trim() ?? '';
    if (!nameVal) errors.name = 'Campaign name is required';
    else if (nameVal.length > CAMPAIGN_LIMITS.name) {
      errors.name = maxLenMessage('Campaign name', CAMPAIGN_LIMITS.name);
    }
    const subjectVal = formData.subject?.trim() ?? '';
    if (!subjectVal) errors.subject = 'Subject is required';
    else if (subjectVal.length > CAMPAIGN_LIMITS.subject) {
      errors.subject = maxLenMessage('Subject', CAMPAIGN_LIMITS.subject);
    }
    const builtHtml = buildPreviewHtml(templateId, templateData);
    if (builtHtml.length > CAMPAIGN_LIMITS.emailContent) {
      errors.emailContent = emailHtmlTooLongMessage(builtHtml.length, CAMPAIGN_LIMITS.emailContent);
    }
    if (templateId === 'simple') {
      if (!templateData.heading?.trim()) errors.heading = 'Heading is required';
      if (!templateData.body?.trim()) errors.body = 'Body is required';
    }
    if (templateId === 'announcement') {
      if (!templateData.title?.trim()) errors.title = 'Title is required';
      if (!templateData.description?.trim()) errors.description = 'Description is required';
    }
    if (templateId === 'newsletter') {
      if (!templateData.title?.trim()) errors.title = 'Title is required';
      if (!templateData.intro?.trim()) errors.intro = 'Intro is required';
    }
    if (formData.scheduledAt) {
      const t = localScheduleStringToDate(formData.scheduledAt);
      if (t && t.getTime() <= Date.now()) {
        errors.scheduledAt = 'Scheduled time must be in the future';
      }
    }
    if (pauseScheduleMode === 'datetime') {
      if (formData.pauseAt) {
        const pauseDt = localScheduleStringToDate(formData.pauseAt);
        if (pauseDt && pauseDt.getTime() <= Date.now()) {
          errors.pauseAt = 'Auto-pause time must be in the future';
        } else if (formData.scheduledAt) {
          const sched = localScheduleStringToDate(formData.scheduledAt);
          if (sched && pauseDt && pauseDt.getTime() <= sched.getTime()) {
            errors.pauseAt = 'Auto-pause time must be after the scheduled time';
          }
        }
      }
    } else {
      const raw = pauseDurationStr.trim();
      if (!raw) {
        errors.pauseDuration = 'Enter how long the campaign should stay active.';
      } else {
        const n = Number(raw);
        const mult = pauseDurationUnit === 'hours' ? 60 : 1;
        if (!Number.isFinite(n) || n < 1) {
          errors.pauseDuration = 'Enter a positive number.';
        } else {
          const mins = Math.floor(n * mult);
          if (mins < 1) errors.pauseDuration = 'Duration must be at least 1 minute.';
          else if (mins > 10080) errors.pauseDuration = 'Maximum is 7 days (10080 minutes).';
        }
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const previewHtml = useMemo(() => buildPreviewHtml(templateId, templateData), [templateId, templateData]);
  const safePreviewHtml = useMemo(() => sanitizeHtmlForIframe(previewHtml), [previewHtml]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (formErrors[name]) setFormErrors((prev) => ({ ...prev, [name]: undefined }));
  };
  const handleTemplateDataChange = (field: string, value: string) => {
    setTemplateData((prev) => ({ ...prev, [field]: value }));
    setFormErrors((prev) => {
      const next = { ...prev };
      if (next[field]) next[field] = undefined;
      if (next.emailContent) next.emailContent = undefined;
      return next;
    });
  };
  const handleTemplateIdChange = (newId: TemplateId) => {
    setTemplateId(newId);
    setTemplateData({ ...TEMPLATE_DEFAULTS[newId] });
    setFormErrors({});
  };

  const availableColumns: string[] = currentCampaign?.availableColumns
    ? (typeof currentCampaign.availableColumns === 'string'
        ? JSON.parse(currentCampaign.availableColumns)
        : currentCampaign.availableColumns)
    : [];

  const getPlaceholderButtons = () => {
    const defaultCols = ['email', 'first_name', 'last_name', 'company'];
    const uploadedCols = availableColumns.filter((c: string) => !defaultCols.includes(c));
    return [...defaultCols, ...uploadedCols].slice(0, 8);
  };

  const insertTokenToSubject = (token: string) => {
    const field = document.querySelector<HTMLInputElement>('input[name="subject"]');
    if (!field) return;
    const start = field.selectionStart || 0;
    const end = field.selectionEnd || 0;
    const current = formData.subject || '';
    const newVal = current.substring(0, start) + token + current.substring(end);
    setFormData((prev) => ({ ...prev, subject: newVal }));
    setTimeout(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  };

  const insertTokenToBody = (token: string) => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const current = templateData.body || '';
    const newVal = current.substring(0, start) + token + current.substring(end);
    handleTemplateDataChange('body', newVal);
    setTimeout(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  };

  const applyFormatting = (format: 'bold' | 'italic' | 'underline' | 'highlight' | 'bullet') => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const current = templateData.body || '';
    const selectedText = current.substring(start, end);
    
    let newText = '';
    switch (format) {
      case 'bold':
        newText = `<strong>${selectedText || 'bold text'}</strong>`;
        break;
      case 'italic':
        newText = `<em>${selectedText || 'italic text'}</em>`;
        break;
      case 'underline':
        newText = `<u>${selectedText || 'underlined text'}</u>`;
        break;
      case 'highlight':
        newText = `<mark style="background-color: yellow;">${selectedText || 'highlighted text'}</mark>`;
        break;
      case 'bullet':
        const lines = selectedText ? selectedText.split('\n') : ['Item 1', 'Item 2'];
        newText = '<ul>\n' + lines.map(line => `  <li>${line}</li>`).join('\n') + '\n</ul>';
        break;
    }
    
    const newVal = current.substring(0, start) + newText + current.substring(end);
    handleTemplateDataChange('body', newVal);
    setTimeout(() => {
      field.focus();
      field.setSelectionRange(start + newText.length, start + newText.length);
    }, 0);
  };

  const handlePausedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smtpReady) {
      setSmtpModalOpen(true);
      return;
    }
    if (!formData.smtpSettingsId) {
      toast.error('Select an SMTP account');
      return;
    }
    let dailySendLimit: number | null = null;
    if (pausedDailyStr.trim()) {
      const n = Number(pausedDailyStr);
      if (!Number.isFinite(n) || n < 1) {
        toast.error('Daily send cap must be a positive integer or empty');
        return;
      }
      dailySendLimit = Math.floor(n);
    }
    setSaving(true);
    try {
      await updateCampaign(campaignId, {
        smtpSettingsId: formData.smtpSettingsId,
        dailySendLimit,
      });
      toast.success('Campaign updated');
      navigate(`/campaigns/${campaignId}`);
    } catch {
      // store
    }
    setSaving(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smtpReady) {
      setSmtpModalOpen(true);
      return;
    }
    if (!validate()) return;
    setSaving(true);
    try {
      const pauseMinutes =
        pauseScheduleMode === 'duration'
          ? Math.floor(Number(pauseDurationStr.trim()) * (pauseDurationUnit === 'hours' ? 60 : 1))
          : null;
      const payload: UpdateCampaignPayload = {
        name: formData.name,
        subject: formData.subject,
        smtpSettingsId: formData.smtpSettingsId,
        fromName: formData.fromName ?? '',
        fromEmail: formData.fromEmail ?? '',
        scheduledAt: formData.scheduledAt || null,
        pauseAt: pauseScheduleMode === 'datetime' ? formData.pauseAt || null : null,
        autoPauseAfterMinutes: pauseScheduleMode === 'duration' ? pauseMinutes : null,
        templateId,
        templateData: templateData as Record<string, unknown>,
      };
      await updateCampaign(campaignId, payload);
      toast.success('Campaign updated successfully!');
      navigate(`/campaigns/${campaignId}`);
    } catch {
      // store handles error display
    }
    setSaving(false);
  };

  if (isLoading && !currentCampaign) return <PageLoader />;
  if (!currentCampaign) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Campaign not found</h2>
        <Button onClick={() => navigate('/campaigns')}>Back to Campaigns</Button>
      </div>
    );
  }
  if (!['draft', 'paused'].includes(currentCampaign.status)) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Cannot edit this campaign</h2>
        <p className="text-gray-500 mb-4">Only draft or paused campaigns can be edited.</p>
        <Button onClick={() => navigate(`/campaigns/${campaignId}`)}>View Campaign</Button>
      </div>
    );
  }

  if (currentCampaign.status === 'paused') {
    return (
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <button
            type="button"
            onClick={() => navigate(`/campaigns/${campaignId}`)}
            className="flex items-center text-gray-500 hover:text-gray-900 mb-3 text-sm transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to campaign
          </button>
          <h1 className="text-2xl font-bold text-gray-900">Campaign settings</h1>
          <p className="text-gray-500 mt-1 text-sm">
            This campaign is paused. Switch SMTP account or adjust the optional daily send cap.
          </p>
        </div>
        {error && <Alert type="error" message={error} onClose={clearError} />}
        <Modal isOpen={smtpModalOpen} onClose={() => setSmtpModalOpen(false)} title="Configure email sending">
          <p className="text-gray-600 text-sm mb-4">
            Add your SMTP settings and sender email in Settings before you can save changes.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setSmtpModalOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => navigate('/settings')}>
              Go to Settings
            </Button>
          </div>
        </Modal>
        <Card>
          <CardContent className="py-6">
            <form onSubmit={handlePausedSubmit} className="space-y-5">
              {smtpReady ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Send from (SMTP account)<span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <select
                      className="w-full rounded-lg bg-white text-gray-900 px-4 py-2.5 border border-gray-300 focus:ring-2 focus:ring-gray-400 focus:outline-none"
                      value={formData.smtpSettingsId || ''}
                      onChange={(e) => {
                        const sid = Number(e.target.value);
                        const p = smtpProfileOptions.find((x) => x.id === sid);
                        setFormData((prev) => ({
                          ...prev,
                          smtpSettingsId: sid,
                          fromName: p?.fromName ?? '',
                          fromEmail: p?.fromEmail ?? '',
                        }));
                      }}
                    >
                      {smtpProfileOptions.map((p) => (
                        <option key={p.id} value={p.id ?? ''}>
                          {p.fromEmail} ({p.provider})
                        </option>
                      ))}
                    </select>
                  </div>
                  <Input
                    label="Daily send cap (optional)"
                    name="pausedDaily"
                    type="number"
                    min={1}
                    value={pausedDailyStr}
                    onChange={(e) => setPausedDailyStr(e.target.value)}
                    placeholder="Empty = only SMTP daily limit applies"
                    helperText="Spread sends over multiple days. Leave empty to rely on your SMTP profile limit only."
                  />
                  <Button type="submit" isLoading={saving} leftIcon={<Save className="w-4 h-4" />}>
                    Save
                  </Button>
                </>
              ) : (
                <p className="text-sm text-gray-600">Loading SMTP profiles…</p>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center text-gray-500 hover:text-gray-900 mb-3 text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Edit Campaign</h1>
        <p className="text-gray-500 mt-1 text-sm">Update your campaign details</p>
      </div>

      {error && <Alert type="error" message={error} onClose={clearError} />}

      <Modal isOpen={smtpModalOpen} onClose={() => setSmtpModalOpen(false)} title="Configure email sending">
        <p className="text-gray-600 text-sm mb-4">
          Add your SMTP settings and sender email in Settings before you can save changes.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setSmtpModalOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => navigate('/settings')}>
            Go to Settings
          </Button>
        </div>
      </Modal>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <Card>
            <CardContent className="py-6 space-y-5">
              {formErrors.emailContent && (
                <p className="text-sm text-red-500" role="alert">
                  {formErrors.emailContent}
                </p>
              )}
              <Input
                label="Campaign name"
                name="name"
                value={formData.name || ''}
                onChange={handleInputChange}
                error={formErrors.name}
                placeholder="Campaign name"
                required
                maxLength={CAMPAIGN_LIMITS.name}
              />

              {smtpReady ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Send from (SMTP account)<span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <select
                      className="w-full rounded-lg bg-white text-gray-900 px-4 py-2.5 border border-gray-300 focus:ring-2 focus:ring-gray-400 focus:outline-none"
                      value={formData.smtpSettingsId || ''}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        const p = smtpProfileOptions.find((x) => x.id === id);
                        setFormData((prev) => ({
                          ...prev,
                          smtpSettingsId: id,
                          fromName: p?.fromName ?? '',
                          fromEmail: p?.fromEmail ?? '',
                        }));
                      }}
                    >
                      {smtpProfileOptions.map((p) => (
                        <option key={p.id} value={p.id ?? ''}>
                          {p.fromEmail}
                          {p.fromName ? ` (${p.fromName})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <Input label="Sender name" name="fromName" value={formData.fromName || ''} disabled helperText="From selected account" />
                    <Input label="Sender email" name="fromEmail" value={formData.fromEmail || ''} disabled helperText="From selected account" />
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-medium mb-2">Email sending is not configured</p>
                  <Button type="button" size="sm" onClick={() => navigate('/settings')}>
                    Go to Settings
                  </Button>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-700">
                    Subject<span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <div className="flex gap-1 flex-wrap justify-end">
                    {getPlaceholderButtons().slice(0, 4).map((col) => (
                      <button
                        key={col}
                        type="button"
                        onClick={() => insertTokenToSubject(`{${col}}`)}
                        className="px-2 py-0.5 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition-colors font-mono"
                      >
                        {`{${col}}`}
                      </button>
                    ))}
                  </div>
                </div>
                <Input
                  name="subject"
                  value={formData.subject || ''}
                  onChange={handleInputChange}
                  error={formErrors.subject}
                  placeholder="Write a clear subject line, e.g. Hi {first_name}, check this out!"
                  maxLength={CAMPAIGN_LIMITS.subject}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Template<span className="text-red-500 ml-0.5">*</span>
                </label>
                <select
                  value={templateId}
                  onChange={(e) => handleTemplateIdChange(e.target.value as TemplateId)}
                  className="w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-4 py-2.5 focus:ring-2 focus:ring-gray-400 focus:outline-none"
                >
                  <option value="simple">Blank Template</option>
                  <option value="announcement">Announcement</option>
                  <option value="newsletter">Newsletter</option>
                </select>
              </div>

              {templateId === 'simple' && (
                <>
                  <Input
                    label="Heading"
                    value={templateData.heading || ''}
                    onChange={(e) => handleTemplateDataChange('heading', e.target.value)}
                    placeholder="e.g. Welcome to our update"
                    error={formErrors.heading}
                    required
                  />
                  <RichTextEditor
                    value={templateData.body || ''}
                    onChange={(value) => handleTemplateDataChange('body', value)}
                    placeholder="Write your message here..."
                    error={formErrors.body}
                    availablePlaceholders={availableColumns}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <Input
                      label="Button text (optional)"
                      value={templateData.ctaText || ''}
                      onChange={(e) => handleTemplateDataChange('ctaText', e.target.value)}
                      placeholder="e.g. Learn more"
                    />
                    <Input
                      label="Button URL (optional)"
                      type="url"
                      value={templateData.ctaUrl || ''}
                      onChange={(e) => handleTemplateDataChange('ctaUrl', e.target.value)}
                      placeholder="https://…"
                    />
                  </div>
                </>
              )}
              {templateId === 'announcement' && (
                <>
                  <Input
                    label="Title"
                    value={templateData.title || ''}
                    onChange={(e) => handleTemplateDataChange('title', e.target.value)}
                    placeholder="Announcement title"
                    error={formErrors.title}
                    required
                  />
                  <TextArea
                    label="Description"
                    value={templateData.description || ''}
                    onChange={(e) => handleTemplateDataChange('description', e.target.value)}
                    rows={4}
                    placeholder="What do you want to tell recipients?"
                    error={formErrors.description}
                    required
                  />
                </>
              )}
              {templateId === 'newsletter' && (
                <>
                  <Input
                    label="Title"
                    value={templateData.title || ''}
                    onChange={(e) => handleTemplateDataChange('title', e.target.value)}
                    placeholder="Newsletter title"
                    error={formErrors.title}
                    required
                  />
                  <TextArea
                    label="Intro"
                    value={templateData.intro || ''}
                    onChange={(e) => handleTemplateDataChange('intro', e.target.value)}
                    rows={5}
                    placeholder="Hi {{firstName}}, …"
                    error={formErrors.intro}
                    required
                  />
                </>
              )}

              <Input
                label="Schedule (optional)"
                name="scheduledAt"
                type="datetime-local"
                value={formData.scheduledAt ? toDatetimeLocalValue(formData.scheduledAt) : ''}
                onClick={(e) => e.currentTarget.showPicker?.()}
                onChange={(e) => {
                  setFormData((prev) => ({
                    ...prev,
                    scheduledAt: e.target.value || null,
                  }));
                }}
                error={formErrors.scheduledAt}
                helperText="Leave empty to keep as draft"
                placeholder="Select date and time"
              />

              <div className="space-y-3 rounded-lg border border-gray-100 bg-gray-50/80 p-4">
                <p className="text-sm font-medium text-gray-800">Auto-pause (optional)</p>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="pauseScheduleModeEdit"
                      checked={pauseScheduleMode === 'datetime'}
                      onChange={() => setPauseScheduleMode('datetime')}
                      className="rounded-full border-gray-300"
                    />
                    At a date &amp; time
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="pauseScheduleModeEdit"
                      checked={pauseScheduleMode === 'duration'}
                      onChange={() => setPauseScheduleMode('duration')}
                      className="rounded-full border-gray-300"
                    />
                    After a duration
                  </label>
                </div>
                {pauseScheduleMode === 'datetime' ? (
                  <Input
                    label="Auto-pause date & time"
                    name="pauseAt"
                    type="datetime-local"
                    value={formData.pauseAt ? toDatetimeLocalValue(formData.pauseAt) : ''}
                    onClick={(e) => e.currentTarget.showPicker?.()}
                    onChange={(e) => {
                      setFormData((prev) => ({
                        ...prev,
                        pauseAt: e.target.value || null,
                      }));
                    }}
                    error={formErrors.pauseAt}
                    helperText="Leave empty for no time-based auto-pause."
                    placeholder="Select auto-pause time"
                  />
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                    <Input
                      label="Run for"
                      type="number"
                      min={1}
                      step={1}
                      value={pauseDurationStr}
                      onChange={(e) => {
                        setPauseDurationStr(e.target.value);
                        setFormErrors((prev) => ({ ...prev, pauseDuration: undefined }));
                      }}
                      error={formErrors.pauseDuration}
                      placeholder="e.g. 2"
                    />
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5">Unit</label>
                      <select
                        value={pauseDurationUnit}
                        onChange={(e) =>
                          setPauseDurationUnit(e.target.value as 'minutes' | 'hours')
                        }
                        className="w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-4 py-2.5 focus:ring-2 focus:ring-gray-400 focus:outline-none"
                      >
                        <option value="minutes">Minutes</option>
                        <option value="hours">Hours</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="lg:sticky lg:top-4">
            <CardContent className="py-4 px-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Preview</h3>
              <p className="text-xs text-gray-500 mb-3">How your email may look to recipients.</p>
              <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
                <iframe
                  title="Email preview"
                  className="w-full min-h-[360px] border-0 bg-white"
                  sandbox="allow-same-origin"
                  srcDoc={safePreviewHtml}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button type="button" variant="secondary" onClick={() => navigate(`/campaigns/${campaignId}`)}>
            Cancel
          </Button>
          <Button type="submit" isLoading={saving} leftIcon={<Save className="w-4 h-4" />}>
            Save Changes
          </Button>
        </div>
      </form>
    </div>
  );
}
