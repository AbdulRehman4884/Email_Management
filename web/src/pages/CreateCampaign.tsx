import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, X, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, Modal } from '../components/ui';
import type { CreateCampaignPayload, TemplateId } from '../types';
import { settingsApi, isSmtpConfigured } from '../lib/api';
import { buildPreviewHtml, TEMPLATE_DEFAULTS } from '../lib/emailPreview';

type Step = 1 | 2 | 3;

function toDatetimeLocalValue(dateStr: string): string {
  return dateStr.replace(' ', 'T').slice(0, 16);
}

export function CreateCampaign() {
  const navigate = useNavigate();
  const { createCampaign, uploadRecipients, isLoading, error, clearError } = useCampaignStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [createdCampaignId, setCreatedCampaignId] = useState<number | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<{ addedCount: number } | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [formData, setFormData] = useState<CreateCampaignPayload>({
    name: '',
    subject: '',
    emailContent: '',
    fromName: '',
    fromEmail: '',
    scheduledAt: null,
  });

  const [smtpReady, setSmtpReady] = useState(false);
  const [smtpModalOpen, setSmtpModalOpen] = useState(false);

  useEffect(() => {
    settingsApi
      .getSmtp()
      .then((data) => {
        setSmtpReady(isSmtpConfigured(data));
        setFormData((prev) => ({
          ...prev,
          fromName: data.fromName ?? '',
          fromEmail: data.fromEmail ?? '',
        }));
      })
      .catch(() => {
        setSmtpReady(false);
      });
  }, []);

  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>(() => ({ ...TEMPLATE_DEFAULTS.simple }));
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});

  const steps = [
    { number: 1, title: 'Campaign Details' },
    { number: 2, title: 'Email Content' },
    { number: 3, title: 'Recipients' },
  ];

  const validateStep1 = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.name.trim()) errors.name = 'Campaign name is required';
    if (scheduleEnabled) {
      if (!formData.scheduledAt) {
        errors.scheduledAt = 'Scheduled date and time is required';
      } else if (new Date(formData.scheduledAt).getTime() <= Date.now()) {
        errors.scheduledAt = 'Scheduled time must be in the future';
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateStep2 = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.subject.trim()) errors.subject = 'Email subject is required';
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
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const openSmtpModal = () => setSmtpModalOpen(true);

  const handleNext = async () => {
    clearError();
    if (!smtpReady) {
      openSmtpModal();
      return;
    }
    if (currentStep === 1) {
      if (validateStep1()) setCurrentStep(2);
    } else if (currentStep === 2) {
      if (validateStep2()) {
        try {
          const payload: CreateCampaignPayload = {
            ...formData,
            fromName: formData.fromName || 'MailFlow',
            fromEmail: formData.fromEmail,
            scheduledAt: formData.scheduledAt,
            templateId,
            templateData: templateData as Record<string, unknown>,
          };
          const campaign = await createCampaign(payload);
          setCreatedCampaignId(campaign.id);
          setCurrentStep(3);
        } catch {
          // handled by store
        }
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep((prev) => (prev - 1) as Step);
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

  const handleTemplateIdChange = (id: TemplateId) => {
    setTemplateId(id);
    setTemplateData({ ...TEMPLATE_DEFAULTS[id] });
    setFormErrors({});
  };

  const previewHtml = useMemo(() => {
    return buildPreviewHtml(templateId, templateData);
  }, [templateId, templateData]);

  const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) return;
    setUploadedFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    pickFile(e.target.files?.[0]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    pickFile(e.dataTransfer.files?.[0]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleUpload = async () => {
    if (!uploadedFile || !createdCampaignId) return;
    try {
      const result = await uploadRecipients(createdCampaignId, uploadedFile);
      setUploadResult(result);
    } catch {
      // handled by store
    }
  };

  const handleFinish = () => navigate(`/campaigns/${createdCampaignId}`);

  const insertToken = (token: string) => {
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

  return (
    <div className={`mx-auto space-y-6 ${currentStep === 2 ? 'max-w-5xl' : 'max-w-3xl'}`}>
      <div>
        <button
          onClick={() => navigate('/campaigns')}
          className="flex items-center text-gray-500 hover:text-gray-900 mb-3 text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to campaigns
        </button>
        <h1 className="text-2xl font-bold text-gray-900">Create campaign</h1>
      </div>

      <div className="flex items-center justify-center">
        {steps.map((step, index) => (
          <React.Fragment key={step.number}>
            <div className="flex items-center gap-2.5">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors shrink-0 ${
                  currentStep > step.number
                    ? 'bg-green-500 text-white'
                    : currentStep === step.number
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-200 text-gray-500'
                }`}
              >
                {currentStep > step.number ? <Check className="w-4 h-4" /> : step.number}
              </div>
              <span
                className={`text-sm font-medium hidden sm:inline whitespace-nowrap ${
                  currentStep >= step.number ? 'text-gray-900' : 'text-gray-400'
                }`}
              >
                {step.title}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div className={`w-20 h-px mx-4 ${currentStep > step.number ? 'bg-green-500' : 'bg-gray-200'}`} />
            )}
          </React.Fragment>
        ))}
      </div>

      {error && <Alert type="error" message={error} onClose={clearError} />}

      <Modal isOpen={smtpModalOpen} onClose={() => setSmtpModalOpen(false)} title="Configure email sending">
        <p className="text-gray-600 text-sm mb-4">
          Add your SMTP settings and sender email in Settings before you can continue creating a campaign.
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

      {currentStep === 1 && (
        <Card>
          <CardContent className="py-6 px-8">
            <div className="space-y-5">
              <Input
                label="Campaign name"
                name="name"
                placeholder="e.g. Product Launch Q1"
                value={formData.name}
                onChange={handleInputChange}
                error={formErrors.name}
                required
              />

              {smtpReady ? (
                <>
                  <Input
                    label="Sender name"
                    name="fromName"
                    value={formData.fromName}
                    disabled
                    helperText="Configured in Settings"
                  />
                  <Input
                    label="Sender email"
                    name="fromEmail"
                    type="email"
                    value={formData.fromEmail}
                    disabled
                    helperText="Configured in Settings"
                  />
                </>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-medium mb-2">Email sending is not configured</p>
                  <p className="text-amber-800/90 mb-3">Set up SMTP and sender email in Settings to create campaigns.</p>
                  <Button type="button" size="sm" onClick={() => navigate('/settings')}>
                    Go to Settings
                  </Button>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setScheduleEnabled(!scheduleEnabled)}
                  className={`toggle-switch ${scheduleEnabled ? 'active' : ''}`}
                  role="switch"
                  aria-checked={scheduleEnabled}
                />
                <span className="text-sm font-medium text-gray-700">Schedule for later</span>
              </div>

              {scheduleEnabled && (
                <div className="grid grid-cols-1 gap-4">
                  <Input
                    label="Date & Time"
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
                    placeholder="Select date and time"
                    required
                  />
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {currentStep === 2 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <Card>
            <CardContent className="py-6 px-8">
              <div className="space-y-5">
                <Input
                  label="Subject line"
                  name="subject"
                  placeholder="Write a clear subject line"
                  value={formData.subject}
                  onChange={handleInputChange}
                  error={formErrors.subject}
                  required
                />

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
                      name="heading"
                      value={templateData.heading || ''}
                      onChange={(e) => handleTemplateDataChange('heading', e.target.value)}
                      placeholder="e.g. Welcome to our update"
                      error={formErrors.heading}
                      required
                    />
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-sm font-medium text-gray-700">
                          Body<span className="text-red-500 ml-0.5">*</span>
                        </label>
                        <div className="flex gap-1 flex-wrap justify-end">
                          {['{{firstName}}', '{{lastName}}', '{{email}}', '{{company}}'].map((token) => (
                            <button
                              key={token}
                              type="button"
                              onClick={() => insertToken(token)}
                              className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors font-mono"
                            >
                              {token}
                            </button>
                          ))}
                        </div>
                      </div>
                      <TextArea
                        name="body"
                        value={templateData.body || ''}
                        onChange={(e) => handleTemplateDataChange('body', e.target.value)}
                        rows={5}
                        placeholder="Hi {{firstName}}, write your message here…"
                        error={formErrors.body}
                        required
                      />
                      <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                        <span>&#9432;</span> Use tokens like {'{{firstName}}'} for personalization
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Button text (optional)"
                        name="ctaText"
                        value={templateData.ctaText || ''}
                        onChange={(e) => handleTemplateDataChange('ctaText', e.target.value)}
                        placeholder="e.g. Learn more"
                      />
                      <Input
                        label="Button URL (optional)"
                        name="ctaUrl"
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
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Link URL (optional)"
                        type="url"
                        value={templateData.linkUrl || ''}
                        onChange={(e) => handleTemplateDataChange('linkUrl', e.target.value)}
                        placeholder="https://…"
                      />
                      <Input
                        label="Link text (optional)"
                        value={templateData.linkText || ''}
                        onChange={(e) => handleTemplateDataChange('linkText', e.target.value)}
                        placeholder="Read more"
                      />
                    </div>
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
                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="Main link URL (optional)"
                        type="url"
                        value={templateData.mainLinkUrl || ''}
                        onChange={(e) => handleTemplateDataChange('mainLinkUrl', e.target.value)}
                        placeholder="https://…"
                      />
                      <Input
                        label="Main link text (optional)"
                        value={templateData.mainLinkText || ''}
                        onChange={(e) => handleTemplateDataChange('mainLinkText', e.target.value)}
                        placeholder="See details"
                      />
                    </div>
                    <Input
                      label="Footer (optional)"
                      value={templateData.footer || ''}
                      onChange={(e) => handleTemplateDataChange('footer', e.target.value)}
                      placeholder="Company name · address"
                    />
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="lg:sticky lg:top-4">
            <CardContent className="py-4 px-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Preview</h3>
              <p className="text-xs text-gray-500 mb-3">How your email may look to recipients (tokens show as-is until send).</p>
              <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
                <iframe
                  title="Email preview"
                  className="w-full min-h-[320px] border-0 bg-white"
                  sandbox="allow-same-origin"
                  srcDoc={previewHtml}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {currentStep === 3 && (
        <Card>
          <CardContent className="py-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">
              Upload recipients<span className="text-red-500 ml-0.5">*</span>
            </h2>
            <p className="text-xs text-gray-500 mb-4">Upload at least one recipient file, or save as draft without recipients.</p>
            {!uploadResult ? (
              <div className="space-y-4">
                <div
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                  }}
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    uploadedFile ? 'border-green-400 bg-green-50' : 'border-gray-300 hover:border-gray-400'
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                >
                  <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelect} className="hidden" />
                  <Upload className={`w-8 h-8 mx-auto mb-3 ${uploadedFile ? 'text-green-500' : 'text-gray-400'}`} />
                  {uploadedFile ? (
                    <div className="flex items-center justify-center gap-2">
                      <FileText className="w-4 h-4 text-green-600" />
                      <span className="text-gray-900 font-medium text-sm">{uploadedFile.name}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setUploadedFile(null);
                        }}
                        className="p-1 hover:bg-gray-200 rounded transition-colors"
                      >
                        <X className="w-3.5 h-3.5 text-gray-500" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="text-gray-900 font-medium text-sm">Drag and drop your file here</p>
                      <p className="text-xs text-gray-500 mt-1">CSV or Excel, max 10MB</p>
                      <button
                        type="button"
                        className="mt-3 px-4 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Choose file
                      </button>
                    </>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  Required column: <code className="text-gray-700 font-medium">email</code>. Optional:{' '}
                  <code className="text-gray-700 font-medium">name</code>, <code className="text-gray-700 font-medium">firstName</code>,{' '}
                  <code className="text-gray-700 font-medium">lastName</code>
                </p>
                {uploadedFile && (
                  <Button onClick={handleUpload} isLoading={isLoading} leftIcon={<Upload className="w-4 h-4" />} className="w-full">
                    Upload Recipients
                  </Button>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <Check className="w-7 h-7 text-green-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">Recipients uploaded!</h3>
                <p className="text-gray-500 text-sm">{uploadResult.addedCount} recipients added.</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between items-center pt-2">
        {currentStep > 1 ? (
          <button
            onClick={handleBack}
            className="flex items-center text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
          </button>
        ) : (
          <button
            onClick={() => navigate('/campaigns')}
            className="flex items-center text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" /> Cancel
          </button>
        )}

        <div className="flex items-center gap-3">
          {currentStep === 3 && !uploadResult && (
            <Button variant="secondary" onClick={() => navigate(`/campaigns/${createdCampaignId}`)}>
              Save as draft
            </Button>
          )}
          {currentStep < 3 && (
            <Button onClick={handleNext} isLoading={isLoading} rightIcon={<ArrowRight className="w-4 h-4" />}>
              Next
            </Button>
          )}
          {currentStep === 3 && <Button onClick={handleFinish}>Done</Button>}
        </div>
      </div>
    </div>
  );
}
