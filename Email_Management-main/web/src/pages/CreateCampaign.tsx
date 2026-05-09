import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Upload, FileText, X, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, Modal, useToast, RichTextEditor } from '../components/ui';
import type { CreateCampaignPayload, TemplateId, UploadResponse } from '../types';
import { settingsApi, isSmtpConfigured, type SmtpSettingsResponse } from '../lib/api';
import { buildPreviewHtml, sanitizeHtmlForIframe, TEMPLATE_DEFAULTS } from '../lib/emailPreview';
import { CAMPAIGN_LIMITS, maxLenMessage, emailHtmlTooLongMessage } from '../lib/fieldLimits';
import { getSendTimeEstimateDescription } from '../lib/sendScheduleEstimate';

type Step = 1 | 2 | 3;

function toDatetimeLocalValue(dateStr: string): string {
  return dateStr.replace(' ', 'T').slice(0, 16);
}

function parseStrictLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day ||
    dt.getHours() !== hour ||
    dt.getMinutes() !== minute
  ) {
    return null;
  }
  return dt;
}

export function CreateCampaign() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const { createCampaign, uploadRecipients, isLoading, error, clearError } = useCampaignStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step is driven by URL so browser back/forward works naturally.
  // State (formData, templateData …) is preserved because the component stays mounted
  // when only the search param changes.
  const currentStep = (Math.max(1, Math.min(3, parseInt(searchParams.get('step') || '1'))) as Step);
  const [createdCampaignId, setCreatedCampaignId] = useState<number | null>(null);
  const uploadedCampaignSnapshot = useCampaignStore((s) =>
    createdCampaignId != null && s.currentCampaign?.id === createdCampaignId ? s.currentCampaign : null
  );
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [pauseEnabled, setPauseEnabled] = useState(false);
  /** When auto-pause is on: fixed clock time vs. run for N minutes/hours from send start */
  const [pauseScheduleMode, setPauseScheduleMode] = useState<'datetime' | 'duration'>('datetime');
  const [pauseDurationStr, setPauseDurationStr] = useState('');
  const [pauseDurationUnit, setPauseDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const [smtpProfileOptions, setSmtpProfileOptions] = useState<SmtpSettingsResponse[]>([]);

  const [formData, setFormData] = useState<CreateCampaignPayload>({
    name: '',
    subject: '',
    emailContent: '',
    fromName: '',
    fromEmail: '',
    scheduledAt: null,
    pauseAt: null,
    smtpSettingsId: 0,
  });

  // If user refreshes on ?step=2 or ?step=3 the form data is gone — reset to step 1.
  useEffect(() => {
    const step = parseInt(searchParams.get('step') || '1');
    if (step > 1 && !formData.name.trim() && !createdCampaignId) {
      navigate('/campaigns/create', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [smtpReady, setSmtpReady] = useState(false);
  const [smtpModalOpen, setSmtpModalOpen] = useState(false);

  useEffect(() => {
    settingsApi
      .getSmtp()
      .then((data) => {
        const profiles =
          data.profiles && data.profiles.length > 0
            ? data.profiles
            : data.id
              ? [data]
              : [];
        setSmtpProfileOptions(profiles);
        setSmtpReady(profiles.length > 0);
        const first = profiles[0];
        if (first?.id) {
          setFormData((prev) => ({
            ...prev,
            smtpSettingsId: first.id,
            fromName: first.fromName ?? '',
            fromEmail: first.fromEmail ?? '',
          }));
        }
      })
      .catch(() => {
        setSmtpReady(false);
      });
  }, []);

  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>(() => ({ ...TEMPLATE_DEFAULTS.simple }));
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});
  const [campaignDailyCapStr, setCampaignDailyCapStr] = useState('');
  /** Only when "Schedule for later" is on: optional spread sends via per-day cap. */
  const [dailyCapEnabled, setDailyCapEnabled] = useState(false);

  useEffect(() => {
    if (!scheduleEnabled) {
      setDailyCapEnabled(false);
      setCampaignDailyCapStr('');
    }
  }, [scheduleEnabled]);

  useEffect(() => {
    if (!pauseEnabled) {
      setPauseScheduleMode('datetime');
      setPauseDurationStr('');
      setFormErrors((prev) => ({ ...prev, pauseAt: undefined, pauseDuration: undefined }));
    }
  }, [pauseEnabled]);

  useEffect(() => {
    if (!dailyCapEnabled) {
      setCampaignDailyCapStr('');
      setFormErrors((prev) => ({ ...prev, dailySendCap: undefined }));
    }
  }, [dailyCapEnabled]);

  const steps = [
    { number: 1, title: 'Campaign Details' },
    { number: 2, title: 'Email Content' },
    { number: 3, title: 'Recipients' },
  ];

  const validateStep1 = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.name.trim()) errors.name = 'Campaign name is required';
    else if (formData.name.length > CAMPAIGN_LIMITS.name) {
      errors.name = maxLenMessage('Campaign name', CAMPAIGN_LIMITS.name);
    }
    if (scheduleEnabled) {
      if (!formData.scheduledAt) {
        errors.scheduledAt = 'Scheduled date and time is required';
      } else {
        const selectedLocal = parseStrictLocalDateTime(formData.scheduledAt);
        if (!selectedLocal) {
          errors.scheduledAt = 'Invalid scheduled date and time';
        } else if (selectedLocal.getTime() <= Date.now()) {
          errors.scheduledAt = 'Scheduled time must be in the future';
        }
      }
    }
    if (!formData.smtpSettingsId || formData.smtpSettingsId < 1) {
      errors.smtpSettingsId = 'Select which SMTP account sends this campaign';
    }
    if (scheduleEnabled && dailyCapEnabled) {
      const raw = campaignDailyCapStr.trim();
      if (!raw) {
        errors.dailySendCap = 'Enter max emails per day or turn off daily spread.';
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) {
          errors.dailySendCap = 'Daily limit must be a positive integer.';
        }
      }
    }
    if (pauseEnabled) {
      if (pauseScheduleMode === 'datetime') {
        if (!formData.pauseAt) {
          errors.pauseAt = 'Auto-pause date and time is required';
        } else {
          const pauseLocal = parseStrictLocalDateTime(formData.pauseAt);
          if (!pauseLocal) {
            errors.pauseAt = 'Invalid auto-pause date and time';
          } else if (pauseLocal.getTime() <= Date.now()) {
            errors.pauseAt = 'Auto-pause time must be in the future';
          } else if (scheduleEnabled && formData.scheduledAt) {
            const sched = parseStrictLocalDateTime(formData.scheduledAt);
            if (sched && pauseLocal.getTime() <= sched.getTime()) {
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
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateStep2 = () => {
    const errors: Partial<Record<string, string>> = {};
    if (!formData.subject.trim()) errors.subject = 'Email subject is required';
    else if (formData.subject.length > CAMPAIGN_LIMITS.subject) {
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
      if (validateStep1()) navigate('?step=2');
    } else if (currentStep === 2) {
      if (validateStep2()) {
        // If the campaign was already created (user came back via browser back),
        // just advance without creating a duplicate.
        if (createdCampaignId) {
          navigate('?step=3');
          return;
        }
        try {
          let dailySendLimit: number | undefined = undefined;
          if (scheduleEnabled && dailyCapEnabled && campaignDailyCapStr.trim()) {
            const n = Number(campaignDailyCapStr);
            if (!Number.isFinite(n) || n < 1) {
              toast.error('Daily send cap must be a positive integer.');
              return;
            }
            dailySendLimit = Math.floor(n);
          }
          const pauseMinutes =
            pauseEnabled && pauseScheduleMode === 'duration'
              ? Math.floor(
                  Number(pauseDurationStr.trim()) * (pauseDurationUnit === 'hours' ? 60 : 1)
                )
              : null;
          const payload: CreateCampaignPayload = {
            ...formData,
            smtpSettingsId: formData.smtpSettingsId,
            fromName: formData.fromName || 'MailFlow',
            fromEmail: formData.fromEmail,
            scheduledAt: scheduleEnabled ? formData.scheduledAt : null,
            pauseAt:
              pauseEnabled && pauseScheduleMode === 'datetime' ? formData.pauseAt : null,
            autoPauseAfterMinutes: pauseEnabled && pauseScheduleMode === 'duration' ? pauseMinutes : null,
            templateId,
            templateData: templateData as Record<string, unknown>,
            ...(dailySendLimit !== undefined ? { dailySendLimit } : {}),
          };
          const campaign = await createCampaign(payload);
          setCreatedCampaignId(campaign.id);
          navigate('?step=3');
        } catch {
          // handled by store
        }
      }
    }
  };

  // Browser back button also moves between steps because the URL drives currentStep.
  // This UI "Back" button mirrors that behaviour.
  const handleBack = () => {
    navigate(-1);
  };

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

  const handleTemplateIdChange = (id: TemplateId) => {
    setTemplateId(id);
    setTemplateData({ ...TEMPLATE_DEFAULTS[id] });
    setFormErrors({});
  };

  const previewHtml = useMemo(() => {
    return buildPreviewHtml(templateId, templateData);
  }, [templateId, templateData]);

  const safePreviewHtml = useMemo(() => sanitizeHtmlForIframe(previewHtml), [previewHtml]);

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
      if (result.availableColumns) {
        setAvailableColumns(result.availableColumns);
      }
      if (result.addedCount > 0) {
        toast.success(`${result.addedCount} recipient${result.addedCount === 1 ? '' : 's'} uploaded successfully!`);
      }
      if ((result.rejectedCount ?? 0) > 0) {
        toast.warning(`${result.rejectedCount} recipient${result.rejectedCount === 1 ? '' : 's'} skipped — invalid email format.`);
      }
      if (result.addedCount === 0 && (result.rejectedCount ?? 0) === 0) {
        toast.success('No new recipients to add.');
      }
    } catch {
      // handled by store
    }
  };

  const handleFinish = () => navigate(`/campaigns/${createdCampaignId}`);

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

  const recipientCountForEstimate =
    uploadedCampaignSnapshot?.recieptCount ?? uploadResult?.addedCount ?? 0;
  const sendEstimate = useMemo(
    () => getSendTimeEstimateDescription(recipientCountForEstimate),
    [recipientCountForEstimate]
  );

  const getPlaceholderButtons = () => {
    const defaultCols = ['email', 'first_name', 'last_name', 'company'];
    const uploadedCols = availableColumns.filter(c => !defaultCols.includes(c));
    return [...defaultCols, ...uploadedCols].slice(0, 8);
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
                maxLength={CAMPAIGN_LIMITS.name}
              />

              {smtpReady ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Send from (SMTP account)<span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <select
                      className={`w-full rounded-lg bg-white text-gray-900 px-4 py-2.5 border focus:ring-2 focus:ring-gray-400 focus:outline-none ${
                        formErrors.smtpSettingsId ? 'border-red-500' : 'border-gray-300'
                      }`}
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
                        if (formErrors.smtpSettingsId) {
                          setFormErrors((prev) => ({ ...prev, smtpSettingsId: undefined }));
                        }
                      }}
                    >
                      {smtpProfileOptions.map((p) => (
                        <option key={p.id} value={p.id ?? ''}>
                          {p.fromEmail}
                          {p.fromName ? ` (${p.fromName})` : ''}
                        </option>
                      ))}
                    </select>
                    {formErrors.smtpSettingsId && (
                      <p className="text-sm text-red-500 mt-1">{formErrors.smtpSettingsId}</p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">Each campaign uses one account. Add more in Settings (up to 5).</p>
                  </div>
                  <Input
                    label="Sender name"
                    name="fromName"
                    value={formData.fromName}
                    disabled
                    helperText="From the selected SMTP account"
                  />
                  <Input
                    label="Sender email"
                    name="fromEmail"
                    type="email"
                    value={formData.fromEmail}
                    disabled
                    helperText="From the selected SMTP account"
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
                  onClick={() => {
                    setScheduleEnabled((v) => !v);
                  }}
                  className={`toggle-switch ${scheduleEnabled ? 'active' : ''}`}
                  role="switch"
                  aria-checked={scheduleEnabled}
                />
                <span className="text-sm font-medium text-gray-700">Schedule for later</span>
              </div>

              {scheduleEnabled && (
                <div className="grid grid-cols-1 gap-4 rounded-lg border border-gray-100 bg-gray-50/80 p-4 space-y-4">
                  <Input
                    label="Start date & time"
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
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => setDailyCapEnabled((d) => !d)}
                      className={`toggle-switch mt-0.5 shrink-0 ${dailyCapEnabled ? 'active' : ''}`}
                      role="switch"
                      aria-checked={dailyCapEnabled}
                    />
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-gray-900">Spread sends across days (daily limit)</span>
                      <p className="text-xs text-gray-500 mt-0.5">
                        When on, at most this many emails count toward this campaign per calendar day (same timezone as
                        the server schedule). Remaining sends continue the next day after your SMTP daily window allows.
                        Leave off to use only your SMTP account&apos;s daily limit from Settings.
                      </p>
                    </div>
                  </div>
                  {dailyCapEnabled && (
                    <Input
                      label="Max emails per day for this campaign"
                      type="number"
                      min={1}
                      value={campaignDailyCapStr}
                      onChange={(e) => setCampaignDailyCapStr(e.target.value)}
                      error={formErrors.dailySendCap}
                      helperText="Counts campaign sends logged today; pairs with the schedule above."
                    />
                  )}
                </div>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setPauseEnabled(!pauseEnabled)}
                  className={`toggle-switch ${pauseEnabled ? 'active' : ''}`}
                  role="switch"
                  aria-checked={pauseEnabled}
                />
                <span className="text-sm font-medium text-gray-700">Auto-pause (time or duration)</span>
              </div>

              {pauseEnabled && (
                <div className="grid grid-cols-1 gap-4 rounded-lg border border-gray-100 bg-gray-50/80 p-4 space-y-4">
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="pauseScheduleMode"
                        checked={pauseScheduleMode === 'datetime'}
                        onChange={() => setPauseScheduleMode('datetime')}
                        className="rounded-full border-gray-300"
                      />
                      Pause at a date &amp; time
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="pauseScheduleMode"
                        checked={pauseScheduleMode === 'duration'}
                        onChange={() => setPauseScheduleMode('duration')}
                        className="rounded-full border-gray-300"
                      />
                      Run for a duration (then auto-pause)
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
                      helperText="Campaign pauses when this clock time is reached (same timezone as server schedule)."
                      placeholder="Select auto-pause time"
                      required
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
                        required
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
                      <p className="sm:col-span-2 text-xs text-gray-500">
                        Timer starts when sending begins (scheduled start or when you press Start). Campaign
                        auto-pauses when the duration ends.
                      </p>
                    </div>
                  )}
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
                {formErrors.emailContent && (
                  <p className="text-sm text-red-500" role="alert">
                    {formErrors.emailContent}
                  </p>
                )}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm font-medium text-gray-700">
                      Subject line<span className="text-red-500 ml-0.5">*</span>
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
                    placeholder="Write a clear subject line, e.g. Hi {first_name}, check this out!"
                    value={formData.subject}
                    onChange={handleInputChange}
                    error={formErrors.subject}
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
                      name="heading"
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
                  srcDoc={safePreviewHtml}
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
            <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50/80 px-3 py-2 text-xs text-blue-900">
              <p className="font-medium text-blue-950">Send pacing</p>
              <p className="text-blue-900/90 mt-0.5">
                This app sends roughly one email every <strong>1–2 minutes</strong> per campaign. After you upload, we
                show an estimated total duration for your list.
              </p>
            </div>
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
                  Required column: <code className="text-gray-700 font-medium">email</code>. 
                  Add any other columns (e.g., <code className="text-gray-700 font-medium">first_name</code>, <code className="text-gray-700 font-medium">company</code>) 
                  to use them as placeholders like <code className="text-gray-700 font-medium">{'{first_name}'}</code> in your email.
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
                <p className="text-gray-500 text-sm">{uploadResult.addedCount} recipient{uploadResult.addedCount === 1 ? '' : 's'} added.</p>
                {(uploadResult.rejectedCount ?? 0) > 0 && (
                  <p className="text-amber-600 text-sm mt-1">{uploadResult.rejectedCount} skipped — invalid email format.</p>
                )}
                {recipientCountForEstimate > 0 && (
                  <div className="mt-5 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-left max-w-lg mx-auto">
                    <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Estimated send duration</p>
                    <p className="text-sm text-gray-900 mt-1.5">{sendEstimate.line}</p>
                    <p className="text-xs text-gray-500 mt-2">{sendEstimate.detail}</p>
                  </div>
                )}
                {availableColumns.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <p className="text-sm font-medium text-gray-700 mb-2">Available placeholders for personalization:</p>
                    <div className="flex flex-wrap gap-1.5 justify-center">
                      {availableColumns.map((col) => (
                        <span
                          key={col}
                          className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded font-mono"
                        >
                          {`{${col}}`}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      You can use these in your email template to personalize each recipient's email.
                    </p>
                  </div>
                )}
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
