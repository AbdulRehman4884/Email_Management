import React, { useEffect, useState } from 'react';
import { BellRing, Check, Loader2 } from 'lucide-react';
import { crmApi, apiErrorMessage, type CrmSettings } from '../../lib/api';
import { Card, CardContent, useToast } from '../ui';
import { controlStyle } from './builderStyles';

const PRESETS = [4, 12, 24, 48, 72];

/** Settings → "Reply reminders" (CRM step 6): hours before a reminder, and the daily email. */
export function CrmReminderSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [hours, setHours] = useState('24');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    crmApi
      .getCrmSettings()
      .then((s) => {
        setSettings(s);
        setHours(String(s.needsReplyAfterHours));
      })
      .catch(() => setHidden(true)); // no CRM in the plan: the rest of Settings still works
  }, []);

  if (hidden || !settings) return null;

  const save = async (patch: Partial<Pick<CrmSettings, 'needsReplyAfterHours' | 'reminderEmailDigest'>>) => {
    setState('saving');
    try {
      const s = await crmApi.saveCrmSettings(patch);
      setSettings(s);
      setHours(String(s.needsReplyAfterHours));
      setState('saved');
    } catch (e) {
      setState('idle');
      setHours(String(settings.needsReplyAfterHours));
      toast.error(apiErrorMessage(e, 'Could not save the reminder settings'));
    }
  };

  const commitHours = () => {
    const n = Number(hours);
    if (!Number.isInteger(n) || n === settings.needsReplyAfterHours) {
      setHours(String(settings.needsReplyAfterHours));
      return;
    }
    void save({ needsReplyAfterHours: n });
  };

  const half = settings.needsReplyAfterHours / 2;

  return (
    <Card>
      <CardContent className="py-5">
        <div className="flex items-center gap-2">
          <BellRing className="w-4 h-4 text-gray-500" />
          <h2 className="text-base font-semibold text-gray-900">Reply reminders</h2>
          {state === 'saving' && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
          {state === 'saved' && (
            <span className="text-xs" style={{ color: '#16a34a', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Check size={12} /> Saved
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 mt-0.5 mb-4">
          When a lead replies and you have not answered, you get a reminder in the bell and the lead shows in Inbox → Needs reply.
        </p>

        <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="crm-needs-reply-hours">
          Remind me after
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            id="crm-needs-reply-hours"
            type="number"
            min={settings.limits.minHours}
            max={settings.limits.maxHours}
            step={1}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            onBlur={commitHours}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            style={{ ...controlStyle, width: 90 }}
          />
          <span className="text-sm text-gray-600">hours</span>
          <span style={{ width: 8 }} />
          {PRESETS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => void save({ needsReplyAfterHours: h })}
              className={`text-xs rounded-full ${settings.needsReplyAfterHours === h ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              style={{ padding: '3px 10px', border: '1px solid #e5e7eb' }}
            >
              {h < 48 ? `${h}h` : `${h / 24} days`}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          🟢 Interested and 🔵 Question replies are reminded sooner: after {Number.isInteger(half) ? half : half.toFixed(1)} hours. Out-of-office replies never need a reply.
        </p>

        <div style={{ borderTop: '1px solid #f3f4f6', marginTop: 16, paddingTop: 14 }}>
          <label className="flex items-start gap-3" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.reminderEmailDigest}
              onChange={(e) => void save({ reminderEmailDigest: e.target.checked })}
              style={{ marginTop: 3, width: 16, height: 16 }}
            />
            <span>
              <span className="text-sm font-medium text-gray-900">Daily email digest</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                Once a day (from {String(settings.digestHour).padStart(2, '0')}:00) you get one email listing every lead waiting for your reply, highest score first.
                It is sent to your account email through your own SMTP. Days without waiting leads send nothing.
              </span>
              {settings.reminderEmailDigest && !settings.smtpConfigured && (
                <span className="block text-xs mt-1" style={{ color: '#b45309' }}>
                  Add an SMTP account below first, otherwise the digest cannot be sent.
                </span>
              )}
              {settings.lastDigestSentAt && (
                <span className="block text-xs text-gray-400 mt-1">Last checked: {new Date(settings.lastDigestSentAt).toLocaleString()}</span>
              )}
            </span>
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
