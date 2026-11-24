import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useCampaignStore } from '../store';
import { Button, Input, TextArea, Card, CardContent, Alert, PageLoader, Modal, useToast, RichTextEditor } from '../components/ui';
import type { UpdateCampaignPayload, TemplateId } from '../types';
import { settingsApi, userApi, isSmtpConfigured, type SmtpSettingsResponse } from '../lib/api';
import { buildPreviewHtml, sanitizeHtmlForIframe, TEMPLATE_DEFAULTS, parseStoredCampaignHtml } from '../lib/emailPreview';
import { isValidHttpUrl, INVALID_URL_MESSAGE, htmlHasVisibleText, PLACEHOLDER_CHIPS } from '../lib/campaignValidation';
import { withNormalizedBody } from '../components/ui/RichTextEditor';
import { AddSignatureButton } from '../components/AddSignatureButton';
import { appendHtml } from '../lib/composerStorage';
import { CAMPAIGN_LIMITS, maxLenMessage, emailHtmlTooLongMessage } from '../lib/fieldLimits';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../lib/smtpLimits';
import { localScheduleStringToDate } from '../lib/localScheduleFormat';
import { ScheduleBuilder, type ScheduleBuilderValue } from '../components/ScheduleBuilder';

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
    smtpSettingIds: [],
  });
  /** IDs of SMTP profiles selected for this campaign (multi-select) */
  const [selectedSmtpIds, setSelectedSmtpIds] = useState<number[]>([]);
  // Optional subset of sending alias IDs; empty = all active aliases of the selected profiles.
  const [selectedAliasIds, setSelectedAliasIds] = useState<number[]>([]);
  const [templateId, setTemplateId] = useState<TemplateId>('simple');
  const [templateData, setTemplateData] = useState<Record<string, string>>(() => ({ ...TEMPLATE_DEFAULTS.simple }));
  const [formErrors, setFormErrors] = useState<Partial<Record<string, string>>>({});
  const [pausedDailyStr, setPausedDailyStr] = useState('');
  // Real scheduling flags mirroring CreateCampaign, so the shared ScheduleBuilder can drive them.
  // (pausedDailyStr doubles as the daily-cap string the builder's "rate" token edits.)
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [dailyCapEnabled, setDailyCapEnabled] = useState(false);
  const [pauseEnabled, setPauseEnabled] = useState(false);
  const [pauseScheduleMode, setPauseScheduleMode] = useState<'datetime' | 'duration'>('datetime');
  const [pauseDurationStr, setPauseDurationStr] = useState('');
  const [pauseDurationUnit, setPauseDurationUnit] = useState<'minutes' | 'hours'>('hours');
  const [sendWeekdaysEnabled, setSendWeekdaysEnabled] = useState(false);
  const [selectedSendWeekdays, setSelectedSendWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [sendWindowEnabled, setSendWindowEnabled] = useState(false);
  const [sendWindowStart, setSendWindowStart] = useState('09:00');
  const [sendWindowEnd, setSendWindowEnd] = useState('17:00');
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [smtpReady, setSmtpReady] = useState(false);
  const [smtpModalOpen, setSmtpModalOpen] = useState(false);
  const [smtpQuotaMap, setSmtpQuotaMap] = useState<Record<number, number | null>>({});
  const campaignId = Number(id);

  useEffect(() => {
    if (campaignId) fetchCampaign(campaignId);
    return () => {
      clearCurrentCampaign();
    };
  }, [campaignId, fetchCampaign, clearCurrentCampaign]);

  useEffect(() => {
    userApi.getSmtpQuota().then(({ profiles }) => {
      const map: Record<number, number | null> = {};
      for (const p of profiles) map[p.smtpSettingsId] = p.remaining;
      setSmtpQuotaMap(map);
    }).catch(() => {});
  }, []);

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
        // Determine the selected SMTP IDs: use new array if available, fallback to single ID, or pick first
        let currentSmtpIds = currentCampaign.smtpSettingIds ?? [];
        if (currentSmtpIds.length === 0 && currentCampaign.smtpSettingsId) {
          currentSmtpIds = [currentCampaign.smtpSettingsId];
        }
        if (currentSmtpIds.length === 0 && profiles.length > 0) {
          currentSmtpIds = [profiles[0].id ?? 0];
        }
        setSelectedSmtpIds(currentSmtpIds);

        // Seed alias selection: empty saved aliasIds = all active aliases of the selected profiles.
        const activeAliasIdsForSelected = profiles
          .filter((p) => currentSmtpIds.includes(p.id ?? 0))
          .flatMap((p) => (p.aliases ?? []).filter((a) => a.isActive).map((a) => a.id));
        const savedAliasIds = currentCampaign.aliasIds ?? [];
        setSelectedAliasIds(
          savedAliasIds.length > 0
            ? savedAliasIds.filter((id) => activeAliasIdsForSelected.includes(id))
            : activeAliasIdsForSelected
        );

        const primarySmtpId = currentSmtpIds[0];
        const pick = profiles.find((p) => p.id === primarySmtpId) ?? profiles[0];
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          smtpSettingIds: currentSmtpIds,
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
        const currentSmtpIds = currentCampaign.smtpSettingIds ??
          (currentCampaign.smtpSettingsId ? [currentCampaign.smtpSettingsId] : []);
        setSelectedSmtpIds(currentSmtpIds);
        setFormData({
          name: currentCampaign.name,
          subject: currentCampaign.subject,
          emailContent: currentCampaign.emailContent,
          smtpSettingIds: currentSmtpIds,
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
    } else if (currentCampaign.emailContent?.trim()) {
      // ED-03: HTML that is not one of the built-in templates was written as Custom HTML.
      setTemplateId('custom');
      setTemplateData({ ...TEMPLATE_DEFAULTS.custom, html: currentCampaign.emailContent });
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

    const sw = currentCampaign.sendWeekdays;
    if (sw && sw.length > 0) {
      setSendWeekdaysEnabled(true);
      setSelectedSendWeekdays(sw);
    } else {
      setSendWeekdaysEnabled(false);
      setSelectedSendWeekdays([1, 2, 3, 4, 5]);
    }

    if (currentCampaign.dailySendWindowStart && currentCampaign.dailySendWindowEnd) {
      setSendWindowEnabled(true);
      setSendWindowStart(currentCampaign.dailySendWindowStart.slice(0, 5));
      setSendWindowEnd(currentCampaign.dailySendWindowEnd.slice(0, 5));
    } else {
      setSendWindowEnabled(false);
    }

    setScheduleEnabled(Boolean(currentCampaign.scheduledAt));
    setDailyCapEnabled(currentCampaign.dailySendLimit != null);
    setPauseEnabled(
      Boolean(currentCampaign.pauseAt) ||
        (currentCampaign.autoPauseAfterMinutes != null && currentCampaign.autoPauseAfterMinutes > 0)
    );
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
    if (templateId === 'custom') {
      const rawHtml = templateData.html || '';
      if (!rawHtml.trim()) errors.html = 'HTML content is required';
      else if (rawHtml.length > CAMPAIGN_LIMITS.emailContent) {
        errors.emailContent = emailHtmlTooLongMessage(rawHtml.length, CAMPAIGN_LIMITS.emailContent);
      }
    } else {
      const builtHtml = buildPreviewHtml(templateId, templateData);
      if (builtHtml.length > CAMPAIGN_LIMITS.emailContent) {
        errors.emailContent = emailHtmlTooLongMessage(builtHtml.length, CAMPAIGN_LIMITS.emailContent);
      }
    }
    if (templateId === 'simple') {
      if (!templateData.heading?.trim()) errors.heading = 'Heading is required';
      // CP-01: only spaces / &nbsp; is an empty body.
      if (!htmlHasVisibleText(templateData.body || '')) errors.body = 'Body is required';
      if (!isValidHttpUrl(templateData.ctaUrl || '')) errors.ctaUrl = INVALID_URL_MESSAGE;
    }
    if (templateId === 'announcement') {
      if (!templateData.title?.trim()) errors.title = 'Title is required';
      if (!templateData.description?.trim()) errors.description = 'Description is required';
    }
    if (templateId === 'newsletter') {
      if (!templateData.title?.trim()) errors.title = 'Title is required';
      if (!templateData.intro?.trim()) errors.intro = 'Intro is required';
    }
    if (scheduleEnabled && formData.scheduledAt) {
      const t = localScheduleStringToDate(formData.scheduledAt);
      if (t && t.getTime() <= Date.now()) {
        errors.scheduledAt = 'Scheduled time must be in the future';
      }
    }
    if (dailyCapEnabled) {
      const raw = pausedDailyStr.trim();
      if (!raw) {
        errors.dailySendCap = 'Enter max emails per day or turn off daily spread.';
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          errors.dailySendCap = 'Daily limit must be a whole number of at least 1.';
        } else {
          const hardMax = SMTP_DAILY_EMAIL_LIMIT_MAX * Math.max(selectedSmtpIds.length, 1);
          if (n > hardMax) {
            errors.dailySendCap = `Each account sends at most ${SMTP_DAILY_EMAIL_LIMIT_MAX} emails per day. Enter a value ≤ ${hardMax}.`;
          } else if (!hasUnlimitedSmtp && smtpRemaining !== null && n > smtpRemaining) {
            errors.dailySendCap = `Total remaining daily quota across selected emails is ${smtpRemaining}. Enter a value ≤ ${smtpRemaining}.`;
          }
        }
      }
    }
    if (pauseEnabled) {
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
    }
    if (sendWeekdaysEnabled && selectedSendWeekdays.length === 0) {
      errors.sendWeekdays = 'Pick at least one day, or turn off weekday filtering.';
    }
    // RT-04: same start and end time is ambiguous (0 h or 24 h).
    if (sendWindowEnabled && sendWindowStart === sendWindowEnd) {
      errors.sendWindow = 'Start and end time cannot be the same.';
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const smtpRemaining = useMemo(() => {
    if (selectedSmtpIds.length === 0) return null;
    return selectedSmtpIds.reduce((sum, id) => {
      const r = smtpQuotaMap[id] ?? null;
      return r !== null ? sum + r : sum;
    }, 0);
  }, [selectedSmtpIds, smtpQuotaMap]);
  const hasUnlimitedSmtp = useMemo(() => {
    return selectedSmtpIds.some((id) => smtpQuotaMap[id] === null);
  }, [selectedSmtpIds, smtpQuotaMap]);

  const previewHtml = useMemo(() => buildPreviewHtml(templateId, templateData), [templateId, templateData]);
  const safePreviewHtml = useMemo(() => sanitizeHtmlForIframe(previewHtml), [previewHtml]);

  // Recipients already attached to this campaign — powers the finish-date preview.
  const recipientCountForEstimate =
    currentCampaign?.recipientCount ?? currentCampaign?.recieptCount ?? 0;

  // The shared ScheduleBuilder is controlled over the same scheduling state, so validation and the
  // submit payload keep working unchanged. (campaignDailyCapStr maps to pausedDailyStr here.)
  const scheduleValue: ScheduleBuilderValue = {
    scheduleEnabled,
    scheduledAt: formData.scheduledAt ?? null,
    dailyCapEnabled,
    campaignDailyCapStr: pausedDailyStr,
    sendWindowEnabled,
    sendWindowStart,
    sendWindowEnd,
    sendWeekdaysEnabled,
    selectedSendWeekdays,
    pauseEnabled,
    pauseScheduleMode,
    pauseAt: formData.pauseAt ?? null,
    pauseDurationStr,
    pauseDurationUnit,
  };

  const applySchedulePatch = (p: Partial<ScheduleBuilderValue>) => {
    if ('scheduleEnabled' in p) setScheduleEnabled(p.scheduleEnabled!);
    if ('scheduledAt' in p) setFormData((prev) => ({ ...prev, scheduledAt: p.scheduledAt ?? null }));
    if ('dailyCapEnabled' in p) setDailyCapEnabled(p.dailyCapEnabled!);
    if ('campaignDailyCapStr' in p) setPausedDailyStr(p.campaignDailyCapStr!);
    if ('sendWindowEnabled' in p) setSendWindowEnabled(p.sendWindowEnabled!);
    if ('sendWindowStart' in p) setSendWindowStart(p.sendWindowStart!);
    if ('sendWindowEnd' in p) setSendWindowEnd(p.sendWindowEnd!);
    if ('sendWeekdaysEnabled' in p) setSendWeekdaysEnabled(p.sendWeekdaysEnabled!);
    if ('selectedSendWeekdays' in p) setSelectedSendWeekdays(p.selectedSendWeekdays!);
    if ('pauseEnabled' in p) setPauseEnabled(p.pauseEnabled!);
    if ('pauseScheduleMode' in p) setPauseScheduleMode(p.pauseScheduleMode!);
    if ('pauseAt' in p) setFormData((prev) => ({ ...prev, pauseAt: p.pauseAt ?? null }));
    if ('pauseDurationStr' in p) setPauseDurationStr(p.pauseDurationStr!);
    if ('pauseDurationUnit' in p) setPauseDurationUnit(p.pauseDurationUnit!);
    setFormErrors((prev) => ({
      ...prev,
      scheduledAt: undefined,
      dailySendCap: undefined,
      sendWindow: undefined,
      pauseAt: undefined,
      pauseDuration: undefined,
      sendWeekdays: undefined,
    }));
  };

  // Forward daily capacity for the finish estimate: each selected sending alias/account sends up to
  // the per-account daily max. null when nothing is selected yet.
  const scheduleCapacity =
    selectedAliasIds.length > 0
      ? selectedAliasIds.length * SMTP_DAILY_EMAIL_LIMIT_MAX
      : selectedSmtpIds.length > 0
        ? selectedSmtpIds.length * SMTP_DAILY_EMAIL_LIMIT_MAX
        : null;
  const scheduleCapacityHint = (() => {
    if (selectedSmtpIds.length === 0) return 'Select SMTP accounts first.';
    return hasUnlimitedSmtp
      ? `Up to ${SMTP_DAILY_EMAIL_LIMIT_MAX} emails/day per selected account.`
      : `Combined remaining daily quota: ${smtpRemaining ?? 0} emails. Up to ${SMTP_DAILY_EMAIL_LIMIT_MAX}/day per account.`;
  })();

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
    const defaultCols = PLACEHOLDER_CHIPS;
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

  // Alias subset for the save payload: all active aliases of the selected profiles → []
  // ("all", so aliases added later are auto-included); otherwise the explicit chosen subset.
  const computeAliasIdsPayload = (): number[] => {
    const allActiveAliasIds = smtpProfileOptions
      .filter((p) => selectedSmtpIds.includes(p.id ?? 0))
      .flatMap((p) => (p.aliases ?? []).filter((a) => a.isActive).map((a) => a.id));
    const chosenAliasIds = selectedAliasIds.filter((id) => allActiveAliasIds.includes(id));
    return chosenAliasIds.length === allActiveAliasIds.length ? [] : chosenAliasIds;
  };

  // Keep the alias selection in step with a profile checkbox: add this profile's
  // active aliases when turning it on, drop them when turning it off.
  const syncAliasesOnProfileToggle = (p: SmtpSettingsResponse, turningOn: boolean) => {
    const profileAliasIds = (p.aliases ?? []).filter((a) => a.isActive).map((a) => a.id);
    setSelectedAliasIds((prev) =>
      turningOn
        ? Array.from(new Set([...prev, ...profileAliasIds]))
        : prev.filter((x) => !profileAliasIds.includes(x))
    );
  };

  // Per-alias selection: shown only when a profile is chosen and has more than one alias.
  const renderAliasSubList = (p: SmtpSettingsResponse) => {
    const activeAliases = (p.aliases ?? []).filter((a) => a.isActive);
    if (!(selectedSmtpIds.includes(p.id ?? 0) && activeAliases.length > 1)) return null;
    return (
      <div className="ml-7 mt-1.5 mb-1 space-y-1 border-l border-gray-200 pl-3">
        <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Send from aliases</p>
        {activeAliases.map((a) => (
          <label key={a.id} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-3.5 h-3.5 rounded accent-gray-900 cursor-pointer"
              checked={selectedAliasIds.includes(a.id)}
              onChange={() => {
                setSelectedAliasIds((prev) =>
                  prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]
                );
              }}
            />
            <span className="text-xs text-gray-700">
              {a.fromEmail}{a.isPrimary ? ' (primary)' : ''}
            </span>
          </label>
        ))}
      </div>
    );
  };

  // The account's "remaining today" is the whole-account total; once the user keeps only some
  // aliases, this campaign is bounded by the chosen aliases' combined daily cap, so reflect that.
  const profileRemainingHint = (p: SmtpSettingsResponse, remaining: number | null): string => {
    const activeAliases = (p.aliases ?? []).filter((a) => a.isActive);
    const selectedActive = activeAliases.filter((a) => selectedAliasIds.includes(a.id));
    const isChecked = selectedSmtpIds.includes(p.id ?? 0);
    const usingSubset =
      isChecked && activeAliases.length > 1 && selectedActive.length < activeAliases.length;
    if (usingSubset) {
      const cap = selectedActive.reduce(
        (s, a) =>
          s +
          (a.dailyEmailLimit == null
            ? SMTP_DAILY_EMAIL_LIMIT_MAX
            : Math.max(0, Math.min(a.dailyEmailLimit, SMTP_DAILY_EMAIL_LIMIT_MAX))),
        0
      );
      const shown = remaining !== null ? Math.min(remaining, cap) : cap;
      return `Up to ${shown} emails/day · ${selectedActive.length} of ${activeAliases.length} aliases selected`;
    }
    return remaining !== null
      ? `${remaining} emails remaining today · max ${SMTP_DAILY_EMAIL_LIMIT_MAX}/day per account`
      : `Max ${SMTP_DAILY_EMAIL_LIMIT_MAX} emails/day per account`;
  };

  const handlePausedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smtpReady) {
      setSmtpModalOpen(true);
      return;
    }
    if (selectedSmtpIds.length === 0) {
      toast.error('Select at least one SMTP account');
      return;
    }
    if (sendWindowEnabled && sendWindowStart === sendWindowEnd) {
      toast.error('Daily send window: start and end time cannot be the same.');
      return;
    }
    let dailySendLimit: number | null = null;
    if (pausedDailyStr.trim()) {
      const n = Number(pausedDailyStr);
      if (!Number.isInteger(n) || n < 1) {
        toast.error('Daily send cap must be a whole number of at least 1, or empty');
        return;
      }
      dailySendLimit = Math.floor(n);
      if (!hasUnlimitedSmtp && smtpRemaining !== null && dailySendLimit > smtpRemaining) {
        toast.error(`The combined remaining daily limit is ${smtpRemaining} emails. Please enter a value less than or equal to the remaining limit.`);
        return;
      }
    }
    setSaving(true);
    try {
      await updateCampaign(campaignId, {
        smtpSettingIds: selectedSmtpIds,
        aliasIds: computeAliasIdsPayload(),
        dailySendLimit,
        dailySendWindowStart: sendWindowEnabled ? sendWindowStart : null,
        dailySendWindowEnd: sendWindowEnabled ? sendWindowEnd : null,
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
        smtpSettingIds: selectedSmtpIds,
        aliasIds: computeAliasIdsPayload(),
        fromName: formData.fromName ?? '',
        fromEmail: formData.fromEmail ?? '',
        scheduledAt: scheduleEnabled ? formData.scheduledAt || null : null,
        pauseAt: pauseEnabled && pauseScheduleMode === 'datetime' ? formData.pauseAt || null : null,
        autoPauseAfterMinutes: pauseEnabled && pauseScheduleMode === 'duration' ? pauseMinutes : null,
        sendWeekdays: sendWeekdaysEnabled ? selectedSendWeekdays : null,
        dailySendWindowStart: sendWindowEnabled ? sendWindowStart : null,
        dailySendWindowEnd: sendWindowEnabled ? sendWindowEnd : null,
        dailySendLimit:
          dailyCapEnabled && pausedDailyStr.trim() ? Math.floor(Number(pausedDailyStr)) : null,
        // ED-03: Custom HTML is saved as raw emailContent (same as the create wizard).
        ...(templateId === 'custom'
          ? { emailContent: templateData.html || '' }
          : { templateId, templateData: withNormalizedBody(templateId, templateData) as Record<string, unknown> }),
      };
      await updateCampaign(campaignId, payload);
      toast.success('Campaign updated successfully!');
      navigate(`/campaigns/${campaignId}`);
    } catch {
      // store handles error display
    }
    setSaving(false);
  };

  const invalidId = !Number.isInteger(campaignId) || campaignId < 1;
  if (isLoading && !currentCampaign && !invalidId) return <PageLoader />;
  if (!currentCampaign || invalidId) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Campaign not found</h2>
        <Button onClick={() => navigate('/campaigns')}>Back to Campaigns</Button>
      </div>
    );
  }
  if (!['draft', 'paused', 'in_progress', 'scheduled'].includes(currentCampaign.status)) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Cannot edit this campaign</h2>
        <p className="text-gray-500 mb-4">Only draft, paused, in-progress, or scheduled campaigns can be edited.</p>
        <Button onClick={() => navigate(`/campaigns/${campaignId}`)}>View Campaign</Button>
      </div>
    );
  }

  // In-progress campaigns are actively sending — only allow limited settings changes.
  // Paused and scheduled campaigns get the full editor below.
  if (currentCampaign.status === 'in_progress') {
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
            Update SMTP account, daily send cap, or send window. Changes apply immediately for running campaigns.
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
                      Send from (SMTP accounts)<span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className="rounded-lg border border-gray-300 p-3 space-y-2 bg-white max-h-48 overflow-y-auto">
                      {smtpProfileOptions.map((p) => {
                        const isChecked = selectedSmtpIds.includes(p.id ?? 0);
                        const remaining = p.id != null ? (smtpQuotaMap[p.id] ?? null) : null;
                        return (
                          <div key={p.id}>
                          <label className="flex items-start gap-3 cursor-pointer group">
                            <input
                              type="checkbox"
                              className="mt-0.5 w-4 h-4 rounded accent-gray-900 cursor-pointer"
                              checked={isChecked}
                              onChange={() => {
                                const id = p.id ?? 0;
                                const turningOn = !selectedSmtpIds.includes(id);
                                setSelectedSmtpIds((prev) => {
                                  const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
                                  return next;
                                });
                                syncAliasesOnProfileToggle(p, turningOn);
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 group-hover:text-gray-700">
                                {p.fromEmail} {p.provider ? `(${p.provider})` : ''}
                              </p>
                              <p className="text-xs text-gray-500">
                                {profileRemainingHint(p, remaining)}
                              </p>
                            </div>
                          </label>
                          {renderAliasSubList(p)}
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Select one or more accounts to distribute sends.</p>
                  </div>
                  <Input
                    label="Daily send cap (optional)"
                    name="pausedDaily"
                    type="number"
                    min={1}
                    value={pausedDailyStr}
                    onChange={(e) => setPausedDailyStr(e.target.value)}
                    placeholder="Empty = only SMTP daily limit applies"
                    helperText={
                      smtpRemaining !== null
                        ? `The remaining Server SMTP daily limit is ${smtpRemaining} emails. Please enter a value less than or equal to the remaining limit.`
                        : 'Spread sends over multiple days. Leave empty to rely on your SMTP profile limit only.'
                    }
                  />
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => setSendWindowEnabled((v) => !v)}
                      className={`toggle-switch mt-0.5 shrink-0 ${sendWindowEnabled ? 'active' : ''}`}
                      role="switch"
                      id="edit-switch-1"
                      aria-checked={sendWindowEnabled}
                    />
                    <div className="min-w-0">
                      <label htmlFor="edit-switch-1" className="cursor-pointer text-sm font-medium text-gray-700">Send only during daily time window</label>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Campaign auto-pauses outside the window and resumes when it opens.
                      </p>
                    </div>
                  </div>
                  {sendWindowEnabled && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input
                        label="Window start"
                        type="time"
                        value={sendWindowStart}
                        onChange={(e) => setSendWindowStart(e.target.value)}
                      />
                      <Input
                        label="Window end"
                        type="time"
                        value={sendWindowEnd}
                        onChange={(e) => setSendWindowEnd(e.target.value)}
                        helperText="End can be earlier than start (crosses midnight)."
                      />
                    </div>
                  )}
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

      <form onSubmit={handleSubmit} noValidate>
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
                      Send from (SMTP accounts)<span className="text-red-500 ml-0.5">*</span>
                    </label>
                    <div className={`rounded-lg border p-3 space-y-2 bg-white max-h-48 overflow-y-auto ${
                      formErrors.smtpSettingsId ? 'border-red-400' : 'border-gray-300'
                    }`}>
                      {smtpProfileOptions.map((p) => {
                        const isChecked = selectedSmtpIds.includes(p.id ?? 0);
                        const remaining = p.id != null ? (smtpQuotaMap[p.id] ?? null) : null;
                        return (
                          <div key={p.id}>
                          <label className="flex items-start gap-3 cursor-pointer group">
                            <input
                              type="checkbox"
                              className="mt-0.5 w-4 h-4 rounded accent-gray-900 cursor-pointer"
                              checked={isChecked}
                              onChange={() => {
                                const id = p.id ?? 0;
                                const turningOn = !selectedSmtpIds.includes(id);
                                setSelectedSmtpIds((prev) => {
                                  const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
                                  const primaryId = next[0];
                                  const primaryProfile = smtpProfileOptions.find((x) => x.id === primaryId);
                                  setFormData((fd) => ({
                                    ...fd,
                                    smtpSettingIds: next,
                                    fromName: primaryProfile?.fromName ?? fd.fromName,
                                    fromEmail: primaryProfile?.fromEmail ?? fd.fromEmail,
                                  }));
                                  return next;
                                });
                                syncAliasesOnProfileToggle(p, turningOn);
                                if (formErrors.smtpSettingsId) {
                                  setFormErrors((prev) => ({ ...prev, smtpSettingsId: undefined }));
                                }
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 group-hover:text-gray-700">
                                {p.fromEmail}{p.fromName ? ` (${p.fromName})` : ''}
                              </p>
                              <p className="text-xs text-gray-500">
                                {profileRemainingHint(p, remaining)}
                              </p>
                            </div>
                          </label>
                          {renderAliasSubList(p)}
                          </div>
                        );
                      })}
                    </div>
                    {formErrors.smtpSettingsId && (
                      <p className="text-sm text-red-500 mt-1">{formErrors.smtpSettingsId}</p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">Select one or more email accounts. Sends rotate across selected accounts — max 20 emails per account per day.</p>
                  </div>
                  {/* F-42: with several accounts every sender is listed, because sends rotate between them. */}
                  {selectedSmtpIds.length > 1 ? (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <p className="text-sm font-medium text-gray-700">Senders ({selectedSmtpIds.length} accounts)</p>
                      <ul className="mt-1 space-y-0.5 text-sm text-gray-900 max-h-40 overflow-y-auto" style={{ listStyle: 'none', padding: 0 }}>
                        {selectedSmtpIds.map((id) => {
                          const p = smtpProfileOptions.find((x) => x.id === id);
                          return p ? <li key={id}>{p.fromName ? `${p.fromName} <${p.fromEmail}>` : p.fromEmail}</li> : null;
                        })}
                      </ul>
                      <p className="text-xs text-gray-500 mt-1">
                        Each email goes out from one of these accounts in turn, so recipients see that account&apos;s name and address.
                      </p>
                    </div>
                  ) : (
                  <div className="grid grid-cols-2 gap-4">
                    <Input label="Sender name" name="fromName" value={formData.fromName || ''} disabled helperText="From the selected SMTP account" />
                    <Input label="Sender email" name="fromEmail" value={formData.fromEmail || ''} disabled helperText="From the selected SMTP account" />
                  </div>
                  )}
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
                  <option value="custom">Custom HTML</option>
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
                  <AddSignatureButton onAdd={(sig) => handleTemplateDataChange('body', appendHtml(templateData.body || '', sig))} />
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
                      error={formErrors.ctaUrl}
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
              {templateId === 'custom' && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700" htmlFor="edit-custom-html">
                    HTML source<span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <p className="text-xs text-gray-500">
                    Write raw HTML. Personalization tokens like <code className="bg-gray-100 px-1 rounded">{'{first_name}'}</code> are replaced at send time.
                  </p>
                  <textarea
                    id="edit-custom-html"
                    value={templateData.html || ''}
                    onChange={(e) => handleTemplateDataChange('html', e.target.value)}
                    rows={16}
                    spellCheck={false}
                    aria-invalid={formErrors.html ? true : undefined}
                    aria-describedby={formErrors.html ? 'edit-custom-html-error' : undefined}
                    className={`w-full px-3 py-2 bg-white border rounded-lg text-gray-900 text-xs font-mono placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 resize-y ${formErrors.html ? 'border-red-500' : 'border-gray-300'}`}
                  />
                  {formErrors.html && (
                    <p id="edit-custom-html-error" className="text-sm text-red-500">{formErrors.html}</p>
                  )}
                  <AddSignatureButton onAdd={(sig) => handleTemplateDataChange('html', appendHtml(templateData.html || '', sig))} />
                </div>
              )}

              <ScheduleBuilder
                value={scheduleValue}
                onChange={applySchedulePatch}
                recipientCount={recipientCountForEstimate}
                dailyCapacity={scheduleCapacity}
                capacityHint={scheduleCapacityHint}
                errors={formErrors}
                mode="edit"
                idPrefix="edit"
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
