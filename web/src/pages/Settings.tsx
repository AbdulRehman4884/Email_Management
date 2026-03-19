import React, { useState, useEffect } from 'react';
import { Save, Loader2 } from 'lucide-react';
import { Button, Input, Card, CardContent, Alert } from '../components/ui';
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
  const [saved, setSaved] = useState(false);
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

  useEffect(() => {
    settingsApi.getSmtp().then((data) => {
      setSmtp((prev) => ({
        ...prev,
        provider: data.provider || 'custom',
        host: data.host || prev.host,
        port: data.port ?? 587,
        secure: data.secure ?? false,
        user: data.user || '',
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
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setSmtpError('Failed to save settings');
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

      {saved && <Alert type="success" message="Settings saved successfully!" />}

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
          {smtpError && <Alert type="error" message={smtpError} />}
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
              <Input label="Password" name="password" type="password" value={smtp.password} onChange={handleSmtpChange} placeholder="Leave blank to keep existing" />
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
