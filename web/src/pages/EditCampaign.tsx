import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, PageLoader } from '../components/ui';
import type { UpdateCampaignPayload, TemplateId } from '../types';
import { settingsApi } from '../lib/api';

export function EditCampaign() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    currentCampaign,
    isLoading,
    error,
    fetchCampaign,
    updateCampaign,
    clearError,
    clearCurrentCampaign,
  } = useCampaignStore();

  const [formData, setFormData] = useState<UpdateCampaignPayload>({
    name: '',
    subject: '',
    emailContent: '',
    fromName: '',
    fromEmail: '',
    scheduledAt: null,
  });
  const [useCustomHtml, setUseCustomHtml] = useState(true);
  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>({
    heading: '',
    body: '',
    ctaText: '',
    ctaUrl: '',
  });
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const campaignId = Number(id);

  useEffect(() => {
    if (campaignId) {
      fetchCampaign(campaignId);
    }

    return () => {
      clearCurrentCampaign();
    };
  }, [campaignId, fetchCampaign, clearCurrentCampaign]);

  useEffect(() => {
    if (currentCampaign) {
      settingsApi.getSmtp().then((smtp) => {
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          fromName: smtp.fromName ?? '',
          fromEmail: smtp.fromEmail ?? '',
          scheduledAt: currentCampaign.scheduledAt,
        });
      }).catch(() => {
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          fromName: currentCampaign.fromName,
          fromEmail: currentCampaign.fromEmail,
          scheduledAt: currentCampaign.scheduledAt,
        });
      });
    }
  }, [currentCampaign]);

  const validate = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.name?.trim()) errors.name = 'Campaign name is required';
    if (!formData.subject?.trim()) errors.subject = 'Subject is required';
    if (useCustomHtml && !formData.emailContent?.trim()) errors.emailContent = 'Email content is required';
    if (!useCustomHtml && templateId === 'simple') {
      if (!templateData.heading?.trim()) errors.heading = 'Heading is required';
      if (!templateData.body?.trim()) errors.body = 'Body is required';
    }
    if (!useCustomHtml && templateId === 'announcement') {
      if (!templateData.title?.trim()) errors.title = 'Title is required';
      if (!templateData.description?.trim()) errors.description = 'Description is required';
    }
    if (!useCustomHtml && templateId === 'newsletter') {
      if (!templateData.title?.trim()) errors.title = 'Title is required';
      if (!templateData.intro?.trim()) errors.intro = 'Intro is required';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (formErrors[name as keyof UpdateCampaignPayload]) {
      setFormErrors((prev) => ({ ...prev, [name]: undefined }));
    }
  };

  const handleTemplateDataChange = (field: string, value: string) => {
    setTemplateData((prev) => ({ ...prev, [field]: value }));
    if (formErrors[field]) setFormErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSaving(true);
    try {
      const payload: UpdateCampaignPayload = {
        name: formData.name,
        subject: formData.subject,
        fromName: formData.fromName ?? '',
        fromEmail: formData.fromEmail ?? '',
        scheduledAt: formData.scheduledAt,
      };
      if (useCustomHtml) {
        payload.emailContent = formData.emailContent ?? '';
      } else {
        (payload as UpdateCampaignPayload & { templateId?: TemplateId; templateData?: Record<string, unknown> }).templateId = templateId;
        (payload as UpdateCampaignPayload & { templateId?: TemplateId; templateData?: Record<string, unknown> }).templateData = templateData as Record<string, unknown>;
      }
      await updateCampaign(campaignId, payload);
      navigate(`/campaigns/${campaignId}`);
    } catch (err) {
      // Error handled by store
    }
    setSaving(false);
  };

  if (isLoading && !currentCampaign) {
    return <PageLoader />;
  }

  if (!currentCampaign) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-white mb-2">Campaign not found</h2>
        <Button onClick={() => navigate('/campaigns')}>Back to Campaigns</Button>
      </div>
    );
  }

  if (currentCampaign.status !== 'draft') {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-white mb-2">Cannot edit this campaign</h2>
        <p className="text-gray-400 mb-4">Only draft campaigns can be edited.</p>
        <Button onClick={() => navigate(`/campaigns/${campaignId}`)}>View Campaign</Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center text-gray-400 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </button>
        <h1 className="text-2xl font-bold text-white">Edit Campaign</h1>
        <p className="text-gray-400 mt-1">Update your campaign details</p>
      </div>

      {error && <Alert type="error" message={error} onClose={clearError} />}

      <form onSubmit={handleSubmit}>
        <Card>
          <CardContent className="py-6 space-y-6">
            <Input
              label="Campaign Name"
              name="name"
              placeholder="e.g., Summer Sale Announcement"
              value={formData.name || ''}
              onChange={handleInputChange}
              error={formErrors.name}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Input
                label="Sender Name"
                name="fromName"
                value={formData.fromName || ''}
                disabled
                helperText="From Settings (read-only)"
              />
              <Input
                label="Sender Email"
                name="fromEmail"
                type="email"
                value={formData.fromEmail || ''}
                disabled
                helperText="From Settings (read-only)"
              />
            </div>

            <Input
              label="Email Subject"
              name="subject"
              placeholder="e.g., Don't miss our biggest sale of the year!"
              value={formData.subject || ''}
              onChange={handleInputChange}
              error={formErrors.subject}
            />

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Template</label>
              <select
                value={useCustomHtml ? 'custom' : templateId}
                onChange={(e) => {
                  setUseCustomHtml(e.target.value === 'custom');
                  if (e.target.value !== 'custom') setTemplateId(e.target.value as TemplateId);
                }}
                className="w-full rounded-xl bg-gray-800 border border-gray-700 text-white px-4 py-2.5 focus:ring-2 focus:ring-indigo-500"
              >
                <option value="simple">Simple (heading + body + button)</option>
                <option value="announcement">Announcement</option>
                <option value="newsletter">Newsletter</option>
                <option value="custom">Custom HTML</option>
              </select>
            </div>

            {!useCustomHtml && templateId === 'simple' && (
              <>
                <Input label="Heading" name="heading" value={templateData.heading || ''} onChange={(e) => handleTemplateDataChange('heading', e.target.value)} error={formErrors.heading} />
                <TextArea label="Body" name="body" value={templateData.body || ''} onChange={(e) => handleTemplateDataChange('body', e.target.value)} rows={5} error={formErrors.body} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input label="Button text (optional)" name="ctaText" value={templateData.ctaText || ''} onChange={(e) => handleTemplateDataChange('ctaText', e.target.value)} />
                  <Input label="Button URL (optional)" name="ctaUrl" type="url" value={templateData.ctaUrl || ''} onChange={(e) => handleTemplateDataChange('ctaUrl', e.target.value)} />
                </div>
              </>
            )}
            {!useCustomHtml && templateId === 'announcement' && (
              <>
                <Input label="Title" name="title" value={templateData.title || ''} onChange={(e) => handleTemplateDataChange('title', e.target.value)} error={formErrors.title} />
                <TextArea label="Description" name="description" value={templateData.description || ''} onChange={(e) => handleTemplateDataChange('description', e.target.value)} rows={4} error={formErrors.description} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input label="Link URL (optional)" name="linkUrl" type="url" value={templateData.linkUrl || ''} onChange={(e) => handleTemplateDataChange('linkUrl', e.target.value)} />
                  <Input label="Link text (optional)" name="linkText" value={templateData.linkText || ''} onChange={(e) => handleTemplateDataChange('linkText', e.target.value)} />
                </div>
              </>
            )}
            {!useCustomHtml && templateId === 'newsletter' && (
              <>
                <Input label="Title" name="title" value={templateData.title || ''} onChange={(e) => handleTemplateDataChange('title', e.target.value)} error={formErrors.title} />
                <TextArea label="Intro" name="intro" value={templateData.intro || ''} onChange={(e) => handleTemplateDataChange('intro', e.target.value)} rows={5} error={formErrors.intro} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Input label="Main link URL (optional)" name="mainLinkUrl" type="url" value={templateData.mainLinkUrl || ''} onChange={(e) => handleTemplateDataChange('mainLinkUrl', e.target.value)} />
                  <Input label="Main link text (optional)" name="mainLinkText" value={templateData.mainLinkText || ''} onChange={(e) => handleTemplateDataChange('mainLinkText', e.target.value)} />
                </div>
                <Input label="Footer (optional)" name="footer" value={templateData.footer || ''} onChange={(e) => handleTemplateDataChange('footer', e.target.value)} />
              </>
            )}

            {useCustomHtml && (
              <TextArea
                label="Email body (HTML)"
                name="emailContent"
                value={formData.emailContent || ''}
                onChange={handleInputChange}
                error={formErrors.emailContent}
                rows={12}
              />
            )}

            <Input
              label="Schedule (Optional)"
              name="scheduledAt"
              type="datetime-local"
              value={formData.scheduledAt || ''}
              onChange={handleInputChange}
              helperText="Leave empty to keep as draft"
            />
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3 mt-6">
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate(`/campaigns/${campaignId}`)}
          >
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
