import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, PageLoader } from '../components/ui';
import type { UpdateCampaignPayload, TemplateId } from '../types';
import { settingsApi } from '../lib/api';
import { buildPreviewHtml, wrapCustomHtml, TEMPLATE_DEFAULTS } from '../lib/emailPreview';

export function EditCampaign() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentCampaign, isLoading, error, fetchCampaign, updateCampaign, clearError, clearCurrentCampaign } = useCampaignStore();

  const [formData, setFormData] = useState<UpdateCampaignPayload>({ name: '', subject: '', emailContent: '', fromName: '', fromEmail: '', scheduledAt: null });
  const [useCustomHtml, setUseCustomHtml] = useState(true);
  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>({ heading: '', body: '', ctaText: '', ctaUrl: '' });
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const campaignId = Number(id);

  useEffect(() => { if (campaignId) fetchCampaign(campaignId); return () => { clearCurrentCampaign(); }; }, [campaignId, fetchCampaign, clearCurrentCampaign]);

  useEffect(() => {
    if (currentCampaign) {
      settingsApi.getSmtp().then((smtp) => {
        setFormData({ name: currentCampaign.name, subject: currentCampaign.subject, emailContent: currentCampaign.emailContent, fromName: smtp.fromName ?? '', fromEmail: smtp.fromEmail ?? '', scheduledAt: currentCampaign.scheduledAt });
      }).catch(() => {
        setFormData({ name: currentCampaign.name, subject: currentCampaign.subject, emailContent: currentCampaign.emailContent, fromName: currentCampaign.fromName, fromEmail: currentCampaign.fromEmail, scheduledAt: currentCampaign.scheduledAt });
      });
    }
  }, [currentCampaign]);

  const validate = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.name?.trim()) errors.name = 'Campaign name is required';
    if (!formData.subject?.trim()) errors.subject = 'Subject is required';
    if (useCustomHtml && !formData.emailContent?.trim()) errors.emailContent = 'Email content is required';
    if (!useCustomHtml && templateId === 'simple') { if (!templateData.heading?.trim()) errors.heading = 'Heading is required'; if (!templateData.body?.trim()) errors.body = 'Body is required'; }
    if (!useCustomHtml && templateId === 'announcement') { if (!templateData.title?.trim()) errors.title = 'Title is required'; if (!templateData.description?.trim()) errors.description = 'Description is required'; }
    if (!useCustomHtml && templateId === 'newsletter') { if (!templateData.title?.trim()) errors.title = 'Title is required'; if (!templateData.intro?.trim()) errors.intro = 'Intro is required'; }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (formErrors[name]) setFormErrors((prev) => ({ ...prev, [name]: undefined }));
  };
  const handleTemplateDataChange = (field: string, value: string) => {
    setTemplateData((prev) => ({ ...prev, [field]: value }));
    if (formErrors[field]) setFormErrors((prev) => ({ ...prev, [field]: undefined }));
  };
  const handleTemplateIdChange = (newId: TemplateId) => {
    setTemplateId(newId);
    setTemplateData({ ...TEMPLATE_DEFAULTS[newId] });
    setFormErrors({});
  };

  const previewHtml = useMemo(() => {
    if (useCustomHtml) return wrapCustomHtml(formData.emailContent ?? '');
    return buildPreviewHtml(templateId, templateData);
  }, [useCustomHtml, formData.emailContent, templateId, templateData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      const payload: UpdateCampaignPayload = { name: formData.name, subject: formData.subject, fromName: formData.fromName ?? '', fromEmail: formData.fromEmail ?? '', scheduledAt: formData.scheduledAt };
      if (useCustomHtml) { payload.emailContent = formData.emailContent ?? ''; }
      else { (payload as any).templateId = templateId; (payload as any).templateData = templateData; }
      await updateCampaign(campaignId, payload);
      navigate(`/campaigns/${campaignId}`);
    } catch {}
    setSaving(false);
  };

  if (isLoading && !currentCampaign) return <PageLoader />;
  if (!currentCampaign) return (
    <div className="text-center py-12">
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Campaign not found</h2>
      <Button onClick={() => navigate('/campaigns')}>Back to Campaigns</Button>
    </div>
  );
  if (currentCampaign.status !== 'draft') return (
    <div className="text-center py-12">
      <h2 className="text-xl font-semibold text-gray-900 mb-2">Cannot edit this campaign</h2>
      <p className="text-gray-500 mb-4">Only draft campaigns can be edited.</p>
      <Button onClick={() => navigate(`/campaigns/${campaignId}`)}>View Campaign</Button>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <button onClick={() => navigate(-1)} className="flex items-center text-gray-500 hover:text-gray-900 mb-3 text-sm transition-colors">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Edit Campaign</h1>
        <p className="text-gray-500 mt-1 text-sm">Update your campaign details</p>
      </div>

      {error && <Alert type="error" message={error} onClose={clearError} />}

      <form onSubmit={handleSubmit}>
        <Card>
          <CardContent className="py-6 space-y-5">
            <Input label="Campaign name" name="name" value={formData.name || ''} onChange={handleInputChange} error={formErrors.name} />
            <div className="grid grid-cols-2 gap-4">
              <Input label="Sender name" name="fromName" value={formData.fromName || ''} disabled helperText="From Settings" />
              <Input label="Sender email" name="fromEmail" value={formData.fromEmail || ''} disabled />
            </div>
            <Input label="Subject" name="subject" value={formData.subject || ''} onChange={handleInputChange} error={formErrors.subject} />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Template</label>
              <select
                value={useCustomHtml ? 'custom' : templateId}
                onChange={(e) => { if (e.target.value === 'custom') setUseCustomHtml(true); else { setUseCustomHtml(false); handleTemplateIdChange(e.target.value as TemplateId); } }}
                className="w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-4 py-2.5 focus:ring-2 focus:ring-gray-400 focus:outline-none"
              >
                <option value="simple">Simple</option>
                <option value="announcement">Announcement</option>
                <option value="newsletter">Newsletter</option>
                <option value="custom">Custom HTML</option>
              </select>
            </div>

            {!useCustomHtml && templateId === 'simple' && (
              <>
                <Input label="Heading" value={templateData.heading || ''} onChange={(e) => handleTemplateDataChange('heading', e.target.value)} error={formErrors.heading} />
                <TextArea label="Body" name="body" value={templateData.body || ''} onChange={(e) => handleTemplateDataChange('body', e.target.value)} rows={5} error={formErrors.body} />
                <div className="grid grid-cols-2 gap-4">
                  <Input label="Button text (optional)" value={templateData.ctaText || ''} onChange={(e) => handleTemplateDataChange('ctaText', e.target.value)} />
                  <Input label="Button URL (optional)" type="url" value={templateData.ctaUrl || ''} onChange={(e) => handleTemplateDataChange('ctaUrl', e.target.value)} />
                </div>
              </>
            )}
            {!useCustomHtml && templateId === 'announcement' && (
              <>
                <Input label="Title" value={templateData.title || ''} onChange={(e) => handleTemplateDataChange('title', e.target.value)} error={formErrors.title} />
                <TextArea label="Description" value={templateData.description || ''} onChange={(e) => handleTemplateDataChange('description', e.target.value)} rows={4} error={formErrors.description} />
              </>
            )}
            {!useCustomHtml && templateId === 'newsletter' && (
              <>
                <Input label="Title" value={templateData.title || ''} onChange={(e) => handleTemplateDataChange('title', e.target.value)} error={formErrors.title} />
                <TextArea label="Intro" value={templateData.intro || ''} onChange={(e) => handleTemplateDataChange('intro', e.target.value)} rows={5} error={formErrors.intro} />
              </>
            )}
            {useCustomHtml && (
              <TextArea label="Email body (HTML)" name="emailContent" value={formData.emailContent || ''} onChange={handleInputChange} error={formErrors.emailContent} rows={12} />
            )}

            <Input label="Schedule (optional)" name="scheduledAt" type="datetime-local" value={formData.scheduledAt || ''} onChange={handleInputChange} helperText="Leave empty to keep as draft" />
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3 mt-6">
          <Button type="button" variant="secondary" onClick={() => navigate(`/campaigns/${campaignId}`)}>Cancel</Button>
          <Button type="submit" isLoading={saving} leftIcon={<Save className="w-4 h-4" />}>Save Changes</Button>
        </div>
      </form>
    </div>
  );
}
