import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Save, Loader2, Eye, EyeOff } from 'lucide-react';
import { Button, Input, Card, CardContent, Alert, useToast } from '../components/ui';
import { settingsApi } from '../lib/api';

const SMTP_PROVIDERS = [
  { value: 'hostinger', label: 'Hostinger', host: 'smtp.hostinger.com', port: 587, secure: false },
  { value: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
  { value: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
  { value: 'amazon_ses', label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  { value: 'custom', label: 'Custom SMTP', host: '', port: 587, secure: false },
] as const;

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: () => void; label: string; description?: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm font-medium text-gray-900">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`toggle-switch ${checked ? 'active' : ''}`}
      />
    </div>
  );
}

export function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState({
    defaultFromName: '',
    defaultFromEmail: '',
    replyToEmail: '',
    sendingRateLimit: '14',
    enableBounceHandling: true,
    enableComplaintHandling: false,
    notifyOnCampaignComplete: true,
    notifyOnHighBounce: false,
  });
  const [smtp, setSmtp] = useState({
    provider: 'custom',
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    fromName: '',
    fromEmail: '',
    trackingBaseUrl: '',
  });
  const [smtpLoading, setSmtpLoading] = useState(true);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpError, setSmtpError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const smtpErrorAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (smtpError && smtpErrorAnchorRef.current) {
      smtpErrorAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [smtpError]);

  useEffect(() => {
    settingsApi.getSmtp().then((data) => {
      setSmtp((prev) => ({
        ...prev,
        provider: data.provider || 'custom',
        host: data.host || prev.host,
        port: data.port ?? 587,
        secure: data.secure ?? false,
        user: data.user || '',
        password: data.password ?? '',
        fromName: data.fromName ?? '',
        fromEmail: data.fromEmail || '',
        trackingBaseUrl: data.trackingBaseUrl ?? '',
      }));
      setSettings(prev => ({
        ...prev,
        defaultFromName: data.fromName ?? '',
        defaultFromEmail: data.fromEmail || '',
      }));
    }).catch(() => setSmtpError('Failed to load SMTP settings')).finally(() => setSmtpLoading(false));
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setSettings((prev) => ({ ...prev, [name]: value }));
  };

  const handleSmtpChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const checked = type === 'checkbox' ? (e.target as HTMLInputElement).checked : undefined;
    setSmtp((prev) => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      if (name === 'provider') {
        const preset = SMTP_PROVIDERS.find((p) => p.value === value);
        if (preset) { next.host = preset.host; next.port = preset.port; next.secure = preset.secure; }
      }
      return next;
    });
    setSmtpError(null);
  };

  const handleSave = async () => {
    setSmtpSaving(true);
    setSmtpError(null);
    try {
      await settingsApi.putSmtp({
        provider: smtp.provider,
        host: smtp.host,
        port: Number(smtp.port) || 587,
        secure: smtp.secure,
        user: smtp.user,
        ...(smtp.password ? { password: smtp.password } : {}),
        fromName: smtp.fromName,
        fromEmail: smtp.fromEmail,
        trackingBaseUrl: smtp.trackingBaseUrl || undefined,
      });
      const fresh = await settingsApi.getSmtp();
      setSmtp((prev) => ({
        ...prev,
        provider: fresh.provider || 'custom',
        host: fresh.host || prev.host,
        port: fresh.port ?? 587,
        secure: fresh.secure ?? false,
        user: fresh.user || '',
        password: fresh.password ?? '',
        fromName: fresh.fromName ?? '',
        fromEmail: fresh.fromEmail || '',
        trackingBaseUrl: fresh.trackingBaseUrl ?? '',
      }));
      toast.success('Settings saved successfully!');
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.data && typeof err.response.data === 'object' && 'error' in err.response.data) {
        setSmtpError(String((err.response.data as { error: string }).error));
      } else {
        setSmtpError('Failed to save settings');
      }
    } finally {
      setSmtpSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1 text-sm">Manage your account and email configuration</p>
      </div>

      {/* Default Email Settings */}
      <Card>
        <CardContent className="py-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Default email settings</h2>
          <div className="space-y-4">
            <Input label="Sender name" name="defaultFromName" value={settings.defaultFromName} onChange={handleChange} placeholder="MailFlow Team" />
            <Input label="Sender email" name="defaultFromEmail" type="email" value={settings.defaultFromEmail} onChange={handleChange} placeholder="hello@mailflow.ai" />
            <Input label="Reply-to email" name="replyToEmail" type="email" value={settings.replyToEmail} onChange={handleChange} placeholder="support@mailflow.ai" />
          </div>
        </CardContent>
      </Card>

      {/* Sending & Safety */}
      <Card>
        <CardContent className="py-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Sending & Safety</h2>
          <div className="space-y-3">
            <Input
              label="Sending rate (emails/second)"
              name="sendingRateLimit"
              type="number"
              value={settings.sendingRateLimit}
              onChange={handleChange}
            />
            <Toggle
              checked={settings.enableBounceHandling}
              onChange={() => setSettings(prev => ({ ...prev, enableBounceHandling: !prev.enableBounceHandling }))}
              label="Bounce handling"
              description="Automatically prevent bounced emails"
            />
            <Toggle
              checked={settings.enableComplaintHandling}
              onChange={() => setSettings(prev => ({ ...prev, enableComplaintHandling: !prev.enableComplaintHandling }))}
              label="Complaint handling"
              description="Auto-unsubscribe on complaints"
            />
          </div>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card>
        <CardContent className="py-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Notifications</h2>
          <div className="space-y-1">
            <Toggle
              checked={settings.notifyOnCampaignComplete}
              onChange={() => setSettings(prev => ({ ...prev, notifyOnCampaignComplete: !prev.notifyOnCampaignComplete }))}
              label="Campaign completion"
              description="Get notified when a campaign finishes"
            />
            <Toggle
              checked={settings.notifyOnHighBounce}
              onChange={() => setSettings(prev => ({ ...prev, notifyOnHighBounce: !prev.notifyOnHighBounce }))}
              label="High bounce alerts"
              description="Alert when bounce rate exceeds threshold"
            />
          </div>
        </CardContent>
      </Card>

      {/* SMTP Configuration */}
      <Card>
        <CardContent className="py-5">
          <h2 className="text-base font-semibold text-gray-900 mb-4">SMTP Configuration</h2>
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
                  className="w-full rounded-lg bg-white border border-gray-300 text-gray-900 px-4 py-2.5 focus:ring-2 focus:ring-gray-400 focus:outline-none"
                >
                  {SMTP_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              {smtp.provider === 'custom' && (
                <div className="grid grid-cols-2 gap-4">
                  <Input label="SMTP Host" name="host" value={smtp.host} onChange={handleSmtpChange} placeholder="smtp.example.com" />
                  <Input label="Port" name="port" type="number" value={String(smtp.port)} onChange={handleSmtpChange} />
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Input label="Sender name" name="fromName" value={smtp.fromName} onChange={handleSmtpChange} placeholder="e.g. Your Company" />
                <Input label="From email" name="fromEmail" type="email" value={smtp.fromEmail} onChange={handleSmtpChange} placeholder="noreply@example.com" />
              </div>
              <Input label="Username (email)" name="user" type="email" value={smtp.user} onChange={handleSmtpChange} />
              {/* Password field with visibility toggle */}
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-gray-700" htmlFor="smtp-password">Password</label>
                <div className="relative">
                  <input
                    id="smtp-password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    value={smtp.password}
                    onChange={handleSmtpChange}
                    placeholder="Leave blank to keep existing"
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
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end pb-8">
        <Button
          onClick={handleSave}
          isLoading={smtpSaving}
          leftIcon={<Save className="w-4 h-4" />}
        >
          Save settings
        </Button>
      </div>
    </div>
  );
}
