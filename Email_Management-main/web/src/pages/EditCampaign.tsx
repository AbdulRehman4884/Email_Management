import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, PageLoader, Modal, useToast, RichTextEditor } from '../components/ui';
import type { UpdateCampaignPayload, TemplateId } from '../types';
import { settingsApi, isSmtpConfigured } from '../lib/api';
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

  const [formData, setFormData] = useState<UpdateCampaignPayload>({
    name: '',
    subject: '',
    emailContent: '',
    fromName: '',
    fromEmail: '',
    scheduledAt: null,
    pauseAt: null,
  });
  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>(() => ({ ...TEMPLATE_DEFAULTS.simple }));
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});
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
        setSmtpReady(isSmtpConfigured(smtp));
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          fromName: smtp.fromName ?? '',
          fromEmail: smtp.fromEmail ?? '',
          scheduledAt: currentCampaign.scheduledAt,
          pauseAt: currentCampaign.pauseAt,
        });
      })
      .catch(() => {
        setSmtpReady(false);
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          fromName: currentCampaign.fromName,
          fromEmail: currentCampaign.fromEmail,
          scheduledAt: currentCampaign.scheduledAt,
          pauseAt: currentCampaign.pauseAt,
        });
      });

    const parsed = parseStoredCampaignHtml(currentCampaign.emailContent);
    if (parsed) {
      setTemplateId(parsed.templateId);
      setTemplateData({ ...TEMPLATE_DEFAULTS[parsed.templateId], ...parsed.templateData });
    } else {
      setTemplateId('simple');
      setTemplateData({ ...TEMPLATE_DEFAULTS.simple });
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smtpReady) {
      setSmtpModalOpen(true);
      return;
    }
    if (!validate()) return;
    setSaving(true);
    try {
      const payload: UpdateCampaignPayload = {
        name: formData.name,
        subject: formData.subject,
        fromName: formData.fromName ?? '',
        fromEmail: formData.fromEmail ?? '',
        scheduledAt: formData.scheduledAt || null,
        pauseAt: formData.pauseAt || null,
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
  if (currentCampaign.status !== 'draft') {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Cannot edit this campaign</h2>
        <p className="text-gray-500 mb-4">Only draft campaigns can be edited.</p>
        <Button onClick={() => navigate(`/campaigns/${campaignId}`)}>View Campaign</Button>
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
                <div className="grid grid-cols-2 gap-4">
                  <Input label="Sender name" name="fromName" value={formData.fromName || ''} disabled helperText="From Settings" />
                  <Input label="Sender email" name="fromEmail" value={formData.fromEmail || ''} disabled helperText="From Settings" />
                </div>
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

              <Input
                label="Auto-pause at (optional)"
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
                helperText="Campaign auto-pauses when this time is reached. Resume manually any time."
                placeholder="Select auto-pause time"
              />
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
