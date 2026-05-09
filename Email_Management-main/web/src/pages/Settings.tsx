import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Save, Loader2, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Card, CardContent, Alert, useToast } from '../components/ui';
import { settingsApi, type SmtpSettingsResponse } from '../lib/api';

const SMTP_PROVIDERS = [
  { value: 'hostinger', label: 'Hostinger', host: 'smtp.hostinger.com', port: 587, secure: false },
  { value: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
  { value: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
  { value: 'amazon_ses', label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  { value: 'custom', label: 'Custom SMTP', host: '', port: 587, secure: false },
] as const;

type SmtpField = 'provider' | 'host' | 'port' | 'user' | 'fromEmail' | 'password';
type SmtpFieldErrors = Partial<Record<SmtpField, string>>;
const SMTP_FIELD_ORDER: SmtpField[] = ['provider', 'host', 'port', 'user', 'fromEmail', 'password'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GMAIL_APP_PASSWORD_LENGTH = 16;

function normalizeSmtpPassword(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function getGmailPasswordError(params: { isGmailSmtp: boolean; password: string; smtpHasPassword: boolean }): string | null {
  if (!params.isGmailSmtp) return null;
  const normalized = normalizeSmtpPassword(params.password);
  if (!normalized) {
    return params.smtpHasPassword ? null : 'Gmail SMTP requires a 16-character Google App Password.';
  }
  if (normalized.length !== GMAIL_APP_PASSWORD_LENGTH) {
    return 'Gmail App Password must be exactly 16 characters.';
  }
  return null;
}

function validateSmtpFields(smtp: {
  provider: string;
  host: string;
  port: number | string;
  user: string;
  fromEmail: string;
}): SmtpFieldErrors {
  const errors: SmtpFieldErrors = {};
  const provider = String(smtp.provider ?? '').trim();
  const host = String(smtp.host ?? '').trim();
  const portRaw = String(smtp.port ?? '').trim();
  const user = String(smtp.user ?? '').trim();
  const fromEmail = String(smtp.fromEmail ?? '').trim();

  if (!provider) errors.provider = 'Provider is required.';
  if (!host) errors.host = 'SMTP host is required.';
  if (!portRaw) {
    errors.port = 'Port is required.';
  } else {
    const portNum = Number(portRaw);
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      errors.port = 'Port must be between 1 and 65535.';
    }
  }
  if (!user) {
    errors.user = 'Username is required.';
  } else if (!EMAIL_REGEX.test(user)) {
    errors.user = 'Username must be a valid email address.';
  }
  if (!fromEmail) {
    errors.fromEmail = 'From email is required.';
  } else if (!EMAIL_REGEX.test(fromEmail)) {
    errors.fromEmail = 'From email must be a valid email address.';
  }
  if (user && fromEmail && EMAIL_REGEX.test(user) && EMAIL_REGEX.test(fromEmail) && user.toLowerCase() !== fromEmail.toLowerCase()) {
    errors.user = 'Username and From email must be the same.';
    errors.fromEmail = 'From email and Username must be the same.';
  }

  return errors;
}

function emptyForm() {
  return {
    provider: 'custom',
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    fromName: '',
    fromEmail: '',
    replyToEmail: '',
    trackingBaseUrl: '',
    dailyEmailLimit: 50,
  };
}

function profileToForm(p: SmtpSettingsResponse) {
  return {
    provider: p.provider || 'custom',
    host: p.host || '',
    port: p.port ?? 587,
    secure: p.secure ?? false,
    user: p.user || '',
    password: '',
    fromName: p.fromName ?? '',
    fromEmail: p.fromEmail || '',
    replyToEmail: p.replyToEmail ?? '',
    trackingBaseUrl: p.trackingBaseUrl ?? '',
    dailyEmailLimit: p.dailyEmailLimit ?? 50,
  };
}

export function Settings() {
  const toast = useToast();
  const [profiles, setProfiles] = useState<SmtpSettingsResponse[]>([]);
  const [maxProfiles, setMaxProfiles] = useState(5);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [smtp, setSmtp] = useState(emptyForm);
  const [smtpLoading, setSmtpLoading] = useState(true);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpError, setSmtpError] = useState<string | null>(null);
  const [smtpFieldErrors, setSmtpFieldErrors] = useState<SmtpFieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [smtpHasPassword, setSmtpHasPassword] = useState(false);
  const smtpErrorAnchorRef = useRef<HTMLDivElement>(null);
  const smtpFieldRefs = useRef<Partial<Record<SmtpField, HTMLInputElement | HTMLSelectElement | null>>>({});
  const isGmailSmtp =
    smtp.provider === 'gmail' ||
    String(smtp.host ?? '').toLowerCase().includes('smtp.gmail.com') ||
    String(smtp.user ?? '').toLowerCase().endsWith('@gmail.com') ||
    String(smtp.fromEmail ?? '').toLowerCase().endsWith('@gmail.com');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSmtpLoading(true);
      try {
        const { profiles: list, max } = await settingsApi.listSmtpProfiles();
        if (cancelled) return;
        setProfiles(list);
        setMaxProfiles(max);
        if (list.length === 0) {
          setEditingId('new');
          setSmtp(emptyForm());
          setSmtpHasPassword(false);
        } else {
          const first = list[0];
          if (first?.id != null) {
            setEditingId(first.id);
            setSmtp(profileToForm(first));
            setSmtpHasPassword(Boolean(first.hasPassword));
          }
        }
      } catch {
        if (!cancelled) setSmtpError('Failed to load SMTP profiles');
      } finally {
        if (!cancelled) setSmtpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (smtpError && smtpErrorAnchorRef.current) {
      smtpErrorAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [smtpError]);

  const selectProfile = (id: number) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    setEditingId(id);
    setSmtp(profileToForm(p));
    setSmtpHasPassword(Boolean(p.hasPassword));
    setSmtpError(null);
    setSmtpFieldErrors({});
  };

  const startNewProfile = () => {
    if (profiles.length >= maxProfiles) {
      toast.error(`You can have at most ${maxProfiles} SMTP accounts.`);
      return;
    }
    setEditingId('new');
    setSmtp(emptyForm());
    setSmtpHasPassword(false);
    setSmtpError(null);
    setSmtpFieldErrors({});
  };

  const handleSmtpChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const checked = type === 'checkbox' ? (e.target as HTMLInputElement).checked : undefined;
    if (name === 'dailyEmailLimit') {
      const n = Number(value);
      setSmtp((prev) => ({
        ...prev,
        dailyEmailLimit: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 50,
      }));
      setSmtpError(null);
      return;
    }
    setSmtp((prev) => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      if (name === 'provider') {
        const preset = SMTP_PROVIDERS.find((p) => p.value === value);
        if (preset) {
          next.host = preset.host;
          next.port = preset.port;
          next.secure = preset.secure;
        }
      }
      setSmtpFieldErrors((currentErrors) => {
        const fieldsToValidate = new Set<SmtpField>();
        if (name === 'provider') {
          fieldsToValidate.add('provider');
          fieldsToValidate.add('host');
          fieldsToValidate.add('port');
        } else if (name === 'host') {
          fieldsToValidate.add('host');
        } else if (name === 'port') {
          fieldsToValidate.add('port');
        } else if (name === 'user' || name === 'fromEmail') {
          fieldsToValidate.add('user');
          fieldsToValidate.add('fromEmail');
        }
        if (fieldsToValidate.size === 0) return currentErrors;

        const nextErrors = { ...currentErrors };
        const liveErrors = validateSmtpFields(next);
        fieldsToValidate.forEach((field) => {
          if (liveErrors[field]) {
            nextErrors[field] = liveErrors[field];
          } else {
            delete nextErrors[field];
          }
        });
        return nextErrors;
      });
      return next;
    });
    setSmtpError(null);
  };

  const focusFirstInvalidSmtpField = (errors: SmtpFieldErrors) => {
    for (const field of SMTP_FIELD_ORDER) {
      if (!errors[field]) continue;
      const element = smtpFieldRefs.current[field];
      if (!element) continue;
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.focus();
      return;
    }
    smtpErrorAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const buildPayload = () => ({
    provider: smtp.provider,
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: Boolean(smtp.secure),
    user: smtp.user,
    ...(normalizeSmtpPassword(smtp.password) ? { password: normalizeSmtpPassword(smtp.password) } : {}),
    fromName: smtp.fromName,
    fromEmail: smtp.fromEmail,
    replyToEmail: smtp.replyToEmail || undefined,
    trackingBaseUrl: smtp.trackingBaseUrl || undefined,
    dailyEmailLimit: typeof smtp.dailyEmailLimit === 'number' ? smtp.dailyEmailLimit : 50,
  });

  const handleSave = async () => {
    const validationErrors = validateSmtpFields(smtp);
    if (Object.keys(validationErrors).length > 0) {
      setSmtpFieldErrors(validationErrors);
      setSmtpError('Please fix the highlighted fields.');
      focusFirstInvalidSmtpField(validationErrors);
      return;
    }
    const gmailPasswordError = getGmailPasswordError({
      isGmailSmtp,
      password: smtp.password,
      smtpHasPassword: editingId === 'new' ? false : smtpHasPassword,
    });
    if (gmailPasswordError) {
      setSmtpFieldErrors((prev) => ({ ...prev, password: gmailPasswordError }));
      setSmtpError(gmailPasswordError);
      return;
    }
    if (editingId === 'new' && !normalizeSmtpPassword(smtp.password) && !isGmailSmtp) {
      setSmtpFieldErrors((prev) => ({ ...prev, password: 'Password is required for a new account.' }));
      setSmtpError('Password is required.');
      return;
    }

    setSmtpSaving(true);
    setSmtpError(null);
    setSmtpFieldErrors({});
    try {
      const payload = buildPayload();
      if (editingId === 'new') {
        await settingsApi.postSmtpProfile({
          ...payload,
          password: normalizeSmtpPassword(smtp.password),
        });
        toast.success('SMTP account added');
      } else if (typeof editingId === 'number') {
        await settingsApi.putSmtpProfile(editingId, {
          ...payload,
          password: normalizeSmtpPassword(smtp.password) || undefined,
        });
        toast.success('SMTP account updated');
      }
      const { profiles: list } = await settingsApi.listSmtpProfiles();
      setProfiles(list);
      if (editingId === 'new' && list.length > 0) {
        const last = list[list.length - 1];
        if (last?.id) selectProfile(last.id);
      } else if (typeof editingId === 'number') {
        selectProfile(editingId);
      }
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data && typeof err.response.data === 'object') {
        const errorPayload = err.response.data as { error?: string; fieldErrors?: SmtpFieldErrors };
        if (errorPayload.fieldErrors && typeof errorPayload.fieldErrors === 'object') {
          setSmtpFieldErrors(errorPayload.fieldErrors);
          focusFirstInvalidSmtpField(errorPayload.fieldErrors);
        }
        if (errorPayload.error) {
          setSmtpError(String(errorPayload.error));
        } else {
          setSmtpError('Failed to save');
        }
      } else {
        setSmtpError('Failed to save');
      }
    } finally {
      setSmtpSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this SMTP account? Campaigns using it must be changed first.')) return;
    try {
      await settingsApi.deleteSmtpProfile(id);
      toast.success('SMTP account removed');
      const { profiles: list } = await settingsApi.listSmtpProfiles();
      setProfiles(list);
      if (list.length === 0) {
        setEditingId('new');
        setSmtp(emptyForm());
        setSmtpHasPassword(false);
      } else {
        const fid = list[0].id;
        if (fid != null) selectProfile(fid);
      }
    } catch (e: unknown) {
      const msg =
        axios.isAxiosError(e) && e.response?.data && typeof e.response.data === 'object' && 'error' in e.response.data
          ? String((e.response.data as { error: string }).error)
          : 'Could not delete';
      toast.error(msg);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1 text-sm">Manage your account and email configuration</p>
      </div>

      <Card>
        <CardContent className="py-5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">SMTP accounts</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Up to {maxProfiles} accounts. Each campaign picks one when you create it.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={startNewProfile}
              disabled={profiles.length >= maxProfiles || smtpLoading}
            >
              Add account
            </Button>
          </div>

          {profiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-4">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => p.id != null && selectProfile(p.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                    editingId === p.id
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {p.fromEmail}
                </button>
              ))}
              {editingId === 'new' && (
                <span className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-full bg-blue-50 text-blue-800 border border-blue-200">
                  New account
                </span>
              )}
            </div>
          )}

          {smtpError && (
            <div ref={smtpErrorAnchorRef} className="mb-4">
              <Alert type="error" message={smtpError} />
            </div>
          )}

          {smtpLoading ? (
            <div className="flex items-center gap-2 text-gray-500 py-4">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading...
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Provider</label>
                <select
                  name="provider"
                  value={smtp.provider}
                  onChange={handleSmtpChange}
                  ref={(element) => {
                    smtpFieldRefs.current.provider = element;
                  }}
                  aria-invalid={Boolean(smtpFieldErrors.provider)}
                  className={`w-full rounded-lg bg-white text-gray-900 px-4 py-2.5 focus:ring-2 focus:ring-gray-400 focus:outline-none ${smtpFieldErrors.provider ? 'border border-red-500' : 'border border-gray-300'}`}
                >
                  {SMTP_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {smtpFieldErrors.provider && <p className="text-sm text-red-500 mt-1.5">{smtpFieldErrors.provider}</p>}
              </div>
              {smtp.provider === 'custom' && (
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    ref={(element) => {
                      smtpFieldRefs.current.host = element;
                    }}
                    label="SMTP Host"
                    name="host"
                    value={smtp.host}
                    onChange={handleSmtpChange}
                    placeholder="smtp.example.com"
                    error={smtpFieldErrors.host}
                  />
                  <Input
                    ref={(element) => {
                      smtpFieldRefs.current.port = element;
                    }}
                    label="Port"
                    name="port"
                    type="number"
                    value={String(smtp.port)}
                    onChange={handleSmtpChange}
                    error={smtpFieldErrors.port}
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Input label="Sender name" name="fromName" value={smtp.fromName} onChange={handleSmtpChange} placeholder="e.g. Your Company" />
                <Input
                  ref={(element) => {
                    smtpFieldRefs.current.fromEmail = element;
                  }}
                  label="From email"
                  name="fromEmail"
                  type="email"
                  value={smtp.fromEmail}
                  onChange={handleSmtpChange}
                  placeholder="noreply@example.com"
                  error={smtpFieldErrors.fromEmail}
                />
              </div>
              <Input
                label="Reply-to email"
                name="replyToEmail"
                type="email"
                value={smtp.replyToEmail}
                onChange={handleSmtpChange}
                placeholder="support@example.com (optional)"
                error={(smtpFieldErrors as Record<string, string>).replyToEmail}
              />
              <Input
                label="Daily email limit (this SMTP account)"
                name="dailyEmailLimit"
                type="number"
                min={0}
                value={String(smtp.dailyEmailLimit ?? 50)}
                onChange={handleSmtpChange}
                helperText="Max sends per calendar day from this account. Use 0 for unlimited."
              />
              <Input
                ref={(element) => {
                  smtpFieldRefs.current.user = element;
                }}
                label="Username (email)"
                name="user"
                type="email"
                value={smtp.user}
                onChange={handleSmtpChange}
                error={smtpFieldErrors.user}
                autoComplete="username"
              />
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-gray-700" htmlFor="smtp-password">
                  SMTP password
                </label>
                <p className="text-xs text-gray-500 mb-1">
                  {editingId === 'new'
                    ? 'Required for a new account (use an app password for Gmail).'
                    : 'Leave blank to keep the current password.'}
                </p>
                <div className="relative">
                  <input
                    id="smtp-password"
                    name="smtp_credential_secret"
                    type={showPassword ? 'text' : 'password'}
                    value={smtp.password}
                    onChange={(e) => {
                      const value = e.target.value;
                      setSmtp((prev) => ({ ...prev, password: value }));
                      setSmtpFieldErrors((prev) => {
                        if (!prev.password) return prev;
                        const next = { ...prev };
                        delete next.password;
                        return next;
                      });
                      setSmtpError(null);
                    }}
                    autoComplete="new-password"
                    placeholder={editingId !== 'new' && smtpHasPassword ? 'Leave blank to keep saved password' : 'SMTP or app password'}
                    className="login-password-field w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent hover:border-gray-400"
                    style={{ paddingRight: '2.75rem' }}
                  />
                  <button
                    type="button"
                    className="login-password-toggle text-gray-500 transition-colors hover:text-gray-800"
                    style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: '0', lineHeight: '0', cursor: 'pointer' }}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" strokeWidth={1.75} aria-hidden /> : <Eye className="w-5 h-5" strokeWidth={1.75} aria-hidden />}
                  </button>
                </div>
                {isGmailSmtp && (
                  <p className="text-xs text-amber-700">
                    Gmail SMTP detected. Use a 16-character Google App Password instead of your regular Gmail account password.
                  </p>
                )}
                {smtpFieldErrors.password && <p className="text-xs text-red-600">{smtpFieldErrors.password}</p>}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                <div className="flex gap-2">
                  <Button onClick={handleSave} isLoading={smtpSaving} leftIcon={<Save className="w-4 h-4" />}>
                    {editingId === 'new' ? 'Add account' : 'Save changes'}
                  </Button>
                  {typeof editingId === 'number' && (
                    <Button type="button" variant="secondary" onClick={() => handleDelete(editingId)} leftIcon={<Trash2 className="w-4 h-4" />}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
