import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileText, X, ArrowLeft, ArrowRight, Check, Mail, User } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert } from '../components/ui';
import type { CreateCampaignPayload, TemplateId } from '../types';
import { settingsApi } from '../lib/api';

type Step = 1 | 2 | 3;

export function CreateCampaign() {
  const navigate = useNavigate();
  const { createCampaign, uploadRecipients, isLoading, error, clearError } = useCampaignStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [currentStep, setCurrentStep] = useState<Step>(1);
  const [createdCampaignId, setCreatedCampaignId] = useState<number | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<{ addedCount: number } | null>(null);
  const [formData, setFormData] = useState<CreateCampaignPayload>({
    name: '',
    subject: '',
    emailContent: '',
    fromName: '',
    fromEmail: '',
    scheduledAt: null,
  });

  useEffect(() => {
    settingsApi.getSmtp().then((data) => {
      setFormData((prev) => ({
        ...prev,
        fromName: data.fromName ?? '',
        fromEmail: data.fromEmail ?? '',
      }));
    }).catch(() => {});
  }, []);
  const [useCustomHtml, setUseCustomHtml] = useState(false);
  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>({
    heading: 'Hello!',
    body: 'Your message here. Use {{firstName}} for their first name.',
    ctaText: '',
    ctaUrl: '',
  });
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});

  const steps = [
    { number: 1, title: 'Campaign Details', description: 'Basic information about your campaign' },
    { number: 2, title: 'Email Content', description: 'Compose your email message' },
    { number: 3, title: 'Recipients', description: 'Upload your recipient list' },
  ];

  const validateStep1 = () => {
    const errors: Partial<Record<keyof CreateCampaignPayload, string>> = {};
    if (!formData.name.trim()) errors.name = 'Campaign name is required';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateStep2 = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.subject.trim()) errors.subject = 'Email subject is required';
    if (useCustomHtml) {
      if (!formData.emailContent?.trim()) errors.emailContent = 'Email body is required';
    } else {
      if (templateId === 'simple' && !templateData.heading?.trim()) errors.heading = 'Heading is required';
      if (templateId === 'simple' && !templateData.body?.trim()) errors.body = 'Body is required';
      if (templateId === 'announcement' && !templateData.title?.trim()) errors.title = 'Title is required';
      if (templateId === 'announcement' && !templateData.description?.trim()) errors.description = 'Description is required';
      if (templateId === 'newsletter' && !templateData.title?.trim()) errors.title = 'Title is required';
      if (templateId === 'newsletter' && !templateData.intro?.trim()) errors.intro = 'Intro is required';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleNext = async () => {
    clearError();
    if (currentStep === 1) {
      if (validateStep1()) setCurrentStep(2);
    } else if (currentStep === 2) {
      if (validateStep2()) {
        try {
          const payload: CreateCampaignPayload = {
            ...formData,
            fromName: formData.fromName || 'MailFlow',
            fromEmail: formData.fromEmail,
          };
          if (useCustomHtml) {
            payload.emailContent = formData.emailContent || '';
          } else {
            payload.templateId = templateId;
            payload.templateData = templateData as Record<string, unknown>;
          }
          const campaign = await createCampaign(payload);
          setCreatedCampaignId(campaign.id);
          setCurrentStep(3);
        } catch (err) {
          // Error is handled by the store
        }
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => (prev - 1) as Step);
    }
  };

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
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
    if (id === 'announcement') setTemplateData({ title: '', description: '', linkUrl: '', linkText: '' });
    else if (id === 'newsletter') setTemplateData({ title: '', intro: '', mainLinkUrl: '', mainLinkText: '', footer: '' });
    else setTemplateData({ heading: 'Hello!', body: 'Your message here. Use the personalise section below to add each person’s name or email.', ctaText: '', ctaUrl: '' });
    setFormErrors({});
  };

  const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        setFormErrors({ ...formErrors });
        return;
      }
      setUploadedFile(file);
    }
  };

  const handleUpload = async () => {
    if (!uploadedFile || !createdCampaignId) return;
    try {
      const result = await uploadRecipients(createdCampaignId, uploadedFile);
      setUploadResult(result);
    } catch (err) {
      // Error is handled by the store
    }
  };

  const handleFinish = () => {
    navigate(`/campaigns/${createdCampaignId}`);
  };

  const handleSkipUpload = () => {
    navigate(`/campaigns/${createdCampaignId}`);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page Header */}
      <div>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center text-gray-400 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </button>
        <h1 className="text-2xl font-bold text-white">Create New Campaign</h1>
        <p className="text-gray-400 mt-1">Set up your email campaign in a few simple steps</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => (
          <React.Fragment key={step.number}>
            <div className="flex items-center">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center font-medium transition-colors ${
                  currentStep >= step.number
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-500'
                }`}
              >
                {currentStep > step.number ? (
                  <Check className="w-5 h-5" />
                ) : (
                  step.number
                )}
              </div>
              <div className="ml-3 hidden sm:block">
                <p
                  className={`text-sm font-medium ${
                    currentStep >= step.number ? 'text-white' : 'text-gray-500'
                  }`}
                >
                  {step.title}
                </p>
                <p className="text-xs text-gray-500">{step.description}</p>
              </div>
            </div>
            {index < steps.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-4 ${
                  currentStep > step.number ? 'bg-indigo-600' : 'bg-gray-800'
                }`}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {error && (
        <Alert type="error" message={error} onClose={clearError} />
      )}

      {/* Step Content */}
      <Card>
        <CardContent className="py-8">
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <div className="w-12 h-12 bg-indigo-500/20 rounded-xl flex items-center justify-center">
                  <Mail className="w-6 h-6 text-indigo-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Campaign Details</h2>
                  <p className="text-sm text-gray-400">Enter the basic information for your campaign</p>
                </div>
              </div>

              <Input
                label="Campaign Name"
                name="name"
                placeholder="e.g., Summer Sale Announcement"
                value={formData.name}
                onChange={handleInputChange}
                error={formErrors.name}
              />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Input
                  label="Sender Name"
                  name="fromName"
                  value={formData.fromName}
                  disabled
                  helperText="From Settings (read-only)"
                />
                <Input
                  label="Sender Email"
                  name="fromEmail"
                  type="email"
                  value={formData.fromEmail}
                  disabled
                  helperText="From Settings (read-only)"
                />
              </div>

              <Input
                label="Schedule (Optional)"
                name="scheduledAt"
                type="datetime-local"
                value={formData.scheduledAt || ''}
                onChange={handleInputChange}
                helperText="Leave empty to save as draft"
              />
            </div>
          )}

          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center">
                  <FileText className="w-6 h-6 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Email Content</h2>
                  <p className="text-sm text-gray-400">Pick a template and fill in your message — no HTML needed</p>
                </div>
              </div>

              <Input
                label="Email Subject"
                name="subject"
                placeholder="e.g., Don't miss our biggest sale of the year!"
                value={formData.subject}
                onChange={handleInputChange}
                error={formErrors.subject}
              />

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">Template</label>
                <select
                  value={useCustomHtml ? 'custom' : templateId}
                  onChange={(e) => {
                    if (e.target.value === 'custom') {
                      setUseCustomHtml(true);
                    } else {
                      setUseCustomHtml(false);
                      handleTemplateIdChange(e.target.value as TemplateId);
                    }
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
                  <Input label="Heading" name="heading" value={templateData.heading || ''} onChange={(e) => handleTemplateDataChange('heading', e.target.value)} placeholder="e.g. Hello!" error={formErrors.heading} />
                  <TextArea label="Body" name="body" value={templateData.body || ''} onChange={(e) => handleTemplateDataChange('body', e.target.value)} rows={5} placeholder="Write your message. Use the personalise section below to add name or email where needed." error={formErrors.body} />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Input label="Button text (optional)" name="ctaText" value={templateData.ctaText || ''} onChange={(e) => handleTemplateDataChange('ctaText', e.target.value)} placeholder="Learn more" />
                    <Input label="Button URL (optional)" name="ctaUrl" type="url" value={templateData.ctaUrl || ''} onChange={(e) => handleTemplateDataChange('ctaUrl', e.target.value)} placeholder="https://..." />
                  </div>
                </>
              )}
              {!useCustomHtml && templateId === 'announcement' && (
                <>
                  <Input label="Title" name="title" value={templateData.title || ''} onChange={(e) => handleTemplateDataChange('title', e.target.value)} placeholder="Announcement title" error={formErrors.title} />
                  <TextArea label="Description" name="description" value={templateData.description || ''} onChange={(e) => handleTemplateDataChange('description', e.target.value)} rows={4} error={formErrors.description} />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Input label="Link URL (optional)" name="linkUrl" type="url" value={templateData.linkUrl || ''} onChange={(e) => handleTemplateDataChange('linkUrl', e.target.value)} />
                    <Input label="Link text (optional)" name="linkText" value={templateData.linkText || ''} onChange={(e) => handleTemplateDataChange('linkText', e.target.value)} />
                  </div>
                </>
              )}
              {!useCustomHtml && templateId === 'newsletter' && (
                <>
                  <Input label="Title" name="title" value={templateData.title || ''} onChange={(e) => handleTemplateDataChange('title', e.target.value)} placeholder="Newsletter title" error={formErrors.title} />
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
                  placeholder="e.g. <p>Hi {{firstName}},</p><p>Your email: {{email}}</p>"
                  value={formData.emailContent ?? ''}
                  onChange={handleInputChange}
                  error={formErrors.emailContent}
                  rows={10}
                  helperText="Use {{firstName}} for name and {{email}} for email where you want them in the message."
                />
              )}

              <div className="p-4 bg-gray-800/50 rounded-xl border border-gray-700/50">
                <p className="text-sm font-medium text-white mb-1">Personalise your message</p>
                <p className="text-sm text-gray-400 mb-3">Type the text below exactly where you want each person’s name or email to appear. We’ll fill it in for every recipient.</p>
                <p className="text-sm text-gray-300">For <strong>name</strong>, type: <span className="text-indigo-300 font-mono">{'{{firstName}}'}</span></p>
                <p className="text-sm text-gray-300 mt-1">For <strong>email</strong>, type: <span className="text-indigo-300 font-mono">{'{{email}}'}</span></p>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div className="space-y-6">
              <div className="flex items-center space-x-3 mb-6">
                <div className="w-12 h-12 bg-green-500/20 rounded-xl flex items-center justify-center">
                  <User className="w-6 h-6 text-green-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">Upload Recipients</h2>
                  <p className="text-sm text-gray-400">Upload a CSV or Excel file with your recipient list</p>
                </div>
              </div>

              {!uploadResult ? (
                <>
                  <div
                    className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors ${
                      uploadedFile
                        ? 'border-indigo-500/50 bg-indigo-500/10'
                        : 'border-gray-700 hover:border-gray-600'
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.xlsx,.xls"
                      onChange={handleFileSelect}
                      className="hidden"
                    />
                    <Upload className={`w-12 h-12 mx-auto mb-4 ${uploadedFile ? 'text-indigo-400' : 'text-gray-500'}`} />
                    {uploadedFile ? (
                      <div className="flex items-center justify-center space-x-2">
                        <FileText className="w-5 h-5 text-indigo-400" />
                        <span className="text-white font-medium">{uploadedFile.name}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setUploadedFile(null);
                          }}
                          className="p-1 hover:bg-gray-700 rounded-lg transition-colors"
                        >
                          <X className="w-4 h-4 text-gray-400" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <p className="text-white font-medium mb-1">
                          Click to upload or drag and drop
                        </p>
                        <p className="text-sm text-gray-400">CSV or Excel (.xlsx, .xls) up to 10MB</p>
                      </>
                    )}
                  </div>

                  <div className="p-4 bg-gray-800/50 rounded-xl">
                    <p className="text-sm text-gray-400">
                      <span className="font-medium text-white">Required columns:</span> <code className="text-indigo-400">email</code>, <code className="text-indigo-400">name</code> (optional).
                      <br />
                      CSV: <code className="text-gray-300">email,name</code> — Excel: first row as headers, same column names.
                    </p>
                  </div>

                  {uploadedFile && (
                    <Button
                      onClick={handleUpload}
                      isLoading={isLoading}
                      leftIcon={<Upload className="w-4 h-4" />}
                      className="w-full"
                    >
                      Upload Recipients
                    </Button>
                  )}
                </>
              ) : (
                <div className="text-center py-8">
                  <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check className="w-8 h-8 text-green-400" />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-2">
                    Recipients Uploaded Successfully!
                  </h3>
                  <p className="text-gray-400">
                    {uploadResult.addedCount} recipients have been added to your campaign.
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Navigation Buttons */}
      <div className="flex justify-between">
        {currentStep > 1 && currentStep < 3 && (
          <Button variant="secondary" onClick={handleBack} leftIcon={<ArrowLeft className="w-4 h-4" />}>
            Back
          </Button>
        )}
        {currentStep === 1 && <div />}
        
        {currentStep < 3 && (
          <Button
            onClick={handleNext}
            isLoading={isLoading}
            rightIcon={<ArrowRight className="w-4 h-4" />}
          >
            {currentStep === 2 ? 'Create Campaign' : 'Next'}
          </Button>
        )}

        {currentStep === 3 && (
          <div className="flex gap-3 ml-auto">
            {!uploadResult && (
              <Button variant="secondary" onClick={handleSkipUpload}>
                Skip for Now
              </Button>
            )}
            <Button onClick={handleFinish} leftIcon={<Check className="w-4 h-4" />}>
              View Campaign
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
