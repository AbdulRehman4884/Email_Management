import React, { useState, useEffect } from 'react';
import { Save, Mail, Shield, Bell, Palette, Loader2 } from 'lucide-react';
import { Button, Input, Card, CardContent, CardHeader, Alert } from '../components/ui';
import { settingsApi } from '../lib/api';
import { useThemeStore } from '../store/themeStore';

const SMTP_PROVIDERS = [
  { value: 'hostinger', label: 'Hostinger', host: 'smtp.hostinger.com', port: 587, secure: false },
  { value: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 587, secure: false },
  { value: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, secure: false },
  { value: 'amazon_ses', label: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  { value: 'custom', label: 'Custom', host: '', port: 587, secure: false },
] as const;

export function Settings() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const getEffectiveTheme = useThemeStore((s) => s.getEffectiveTheme);
  const [saved, setSaved] = useState(false);
  const [settings, setSettings] = useState({
    defaultFromName: '',
    defaultFromEmail: '',
    replyToEmail: '',
    sendingRateLimit: '14',
    enableBounceHandling: true,
    enableComplaintHandling: true,
    notifyOnCampaignComplete: true,
    notifyOnHighBounceRate: true,
  });
  const [smtp, setSmtp] = useState({
    provider: 'hostinger',
    host: 'smtp.hostinger.com',
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
        provider: data.provider || 'hostinger',
        host: data.host || prev.host,
        port: data.port ?? 587,
        secure: data.secure ?? false,
        user: data.user || '',
        fromName: data.fromName ?? '',
        fromEmail: data.fromEmail || '',
        trackingBaseUrl: data.trackingBaseUrl ?? '',
      }));
    }).catch(() => setSmtpError('Failed to load SMTP settings')).finally(() => setSmtpLoading(false));
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setSettings((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSmtpChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const checked = type === 'checkbox' ? (e.target as HTMLInputElement).checked : undefined;
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
      return next;
    });
    setSmtpError(null);
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleSmtpSave = async () => {
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
      setSmtpError('Failed to save SMTP settings');
    } finally {
      setSmtpSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-gray-400 mt-1">
          Configure your email campaign preferences
        </p>
      </div>

      {saved && (
        <Alert type="success" message="Settings saved successfully!" />
      )}

      {/* Appearance / Theme */}
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center">
              <Palette className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Appearance</h2>
              <p className="text-sm text-gray-400">
                Choose light, dark, or follow your device
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium text-white">Theme</p>
          <div className="flex flex-wrap gap-4">
            {(['light', 'dark', 'system'] as const).map((value) => {
              const effective = getEffectiveTheme();
              const label =
                value === 'system'
                  ? `System (${effective === 'dark' ? 'Dark' : 'Light'})`
                  : value === 'dark'
                    ? 'Dark'
                    : 'Light';
              return (
                <label key={value} className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    name="theme"
                    value={value}
                    checked={theme === value}
                    onChange={() => setTheme(value)}
                    className="w-4 h-4 text-indigo-600 bg-gray-800 border-gray-700 focus:ring-indigo-500 focus:ring-offset-gray-900"
                  />
                  <span className="text-sm text-gray-300 capitalize">{label}</span>
                </label>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Default Email Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center">
              <Mail className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Default Email Settings</h2>
              <p className="text-sm text-gray-400">
                Set default values for new campaigns
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Default Sender Name"
              name="defaultFromName"
              placeholder="e.g., Your Company"
              value={settings.defaultFromName}
              onChange={handleChange}
            />
            <Input
              label="Default Sender Email"
              name="defaultFromEmail"
              type="email"
              placeholder="e.g., noreply@company.com"
              value={settings.defaultFromEmail}
              onChange={handleChange}
            />
          </div>
          <Input
            label="Reply-To Email"
            name="replyToEmail"
            type="email"
            placeholder="e.g., support@company.com"
            value={settings.replyToEmail}
            onChange={handleChange}
            helperText="Recipients will reply to this address"
          />
        </CardContent>
      </Card>

      {/* Sending Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-green-500/20 rounded-xl flex items-center justify-center">
              <Shield className="w-5 h-5 text-green-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Sending & Safety</h2>
              <p className="text-sm text-gray-400">
                Configure sending rates and safety features
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            label="Sending Rate Limit"
            name="sendingRateLimit"
            type="number"
            value={settings.sendingRateLimit}
            onChange={handleChange}
            helperText="Maximum emails per second (SMTP sending rate)"
          />
          
          <div className="space-y-3">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                name="enableBounceHandling"
                checked={settings.enableBounceHandling}
                onChange={handleChange}
                className="w-5 h-5 rounded bg-gray-800 border-gray-700 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-gray-900"
              />
              <div>
                <p className="text-white font-medium">Enable Bounce Handling</p>
                <p className="text-sm text-gray-400">
                  Automatically add bounced emails to suppression list
                </p>
              </div>
            </label>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                name="enableComplaintHandling"
                checked={settings.enableComplaintHandling}
                onChange={handleChange}
                className="w-5 h-5 rounded bg-gray-800 border-gray-700 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-gray-900"
              />
              <div>
                <p className="text-white font-medium">Enable Complaint Handling</p>
                <p className="text-sm text-gray-400">
                  Automatically suppress emails that report spam
                </p>
              </div>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Notification Settings */}
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-purple-500/20 rounded-xl flex items-center justify-center">
              <Bell className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Notifications</h2>
              <p className="text-sm text-gray-400">
                Configure when to receive notifications
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center space-x-3 cursor-pointer">
            <input
              type="checkbox"
              name="notifyOnCampaignComplete"
              checked={settings.notifyOnCampaignComplete}
              onChange={handleChange}
              className="w-5 h-5 rounded bg-gray-800 border-gray-700 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-gray-900"
            />
            <div>
              <p className="text-white font-medium">Campaign Completion</p>
              <p className="text-sm text-gray-400">
                Notify when a campaign finishes sending
              </p>
            </div>
          </label>

          <label className="flex items-center space-x-3 cursor-pointer">
            <input
              type="checkbox"
              name="notifyOnHighBounceRate"
              checked={settings.notifyOnHighBounceRate}
              onChange={handleChange}
              className="w-5 h-5 rounded bg-gray-800 border-gray-700 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-gray-900"
            />
            <div>
              <p className="text-white font-medium">High Bounce Rate Alert</p>
              <p className="text-sm text-gray-400">
                Notify when bounce rate exceeds 5%
              </p>
            </div>
          </label>
        </CardContent>
      </Card>

      {/* SMTP / Sending provider */}
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-yellow-500/20 rounded-xl flex items-center justify-center">
              <Palette className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">SMTP / Sending</h2>
              <p className="text-sm text-gray-400">
                Choose provider and enter credentials. Used for all campaign emails.
              </p>
              <p className="text-xs text-amber-400/90 mt-1">
                To reduce spam folder placement, set SPF, DKIM and DMARC for your sending domain in DNS, and use a stable SMTP provider.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {smtpError && <Alert type="error" message={smtpError} />}
          {smtpLoading ? (
            <div className="flex items-center gap-2 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              Loading SMTP settings…
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1">Provider</label>
                <select
                  name="provider"
                  value={smtp.provider}
                  onChange={handleSmtpChange}
                  className="w-full rounded-xl bg-gray-800 border border-gray-700 text-white px-4 py-2.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                >
                  {SMTP_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              {smtp.provider === 'custom' && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Input
                    label="SMTP Host"
                    name="host"
                    value={smtp.host}
                    onChange={handleSmtpChange}
                    placeholder="smtp.example.com"
                  />
                  <Input
                    label="Port"
                    name="port"
                    type="number"
                    value={String(smtp.port)}
                    onChange={handleSmtpChange}
                  />
                  <div className="flex items-center pt-8">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        name="secure"
                        checked={smtp.secure}
                        onChange={handleSmtpChange}
                        className="w-5 h-5 rounded bg-gray-800 border-gray-700 text-indigo-600"
                      />
                      <span className="text-gray-300">Use SSL/TLS</span>
                    </label>
                  </div>
                </div>
              )}
              {smtp.provider === 'gmail' && (
                <p className="text-sm text-amber-400/90">
                  Use an App Password, not your normal Gmail password. Generate in Google Account → Security → 2-Step Verification → App passwords.
                </p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label="Sender name"
                  name="fromName"
                  value={smtp.fromName}
                  onChange={handleSmtpChange}
                  placeholder="e.g., Your Company"
                />
                <Input
                  label="From email"
                  name="fromEmail"
                  type="email"
                  value={smtp.fromEmail}
                  onChange={handleSmtpChange}
                  placeholder="noreply@yourdomain.com"
                />
              </div>
              <Input
                label="Username (email)"
                name="user"
                type="email"
                value={smtp.user}
                onChange={handleSmtpChange}
                placeholder="same as From or login email"
              />
              <Input
                label="Password"
                name="password"
                type="password"
                value={smtp.password}
                onChange={handleSmtpChange}
                placeholder="Leave blank to keep existing"
                helperText="Stored securely; leave blank when editing if you do not want to change it."
              />
              <Button
                onClick={handleSmtpSave}
                leftIcon={smtpSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                disabled={smtpSaving || !smtp.user || !smtp.fromEmail}
              >
                {smtpSaving ? 'Saving…' : 'Save SMTP settings'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} leftIcon={<Save className="w-4 h-4" />}>
          Save Settings
        </Button>
      </div>
    </div>
  );
}
