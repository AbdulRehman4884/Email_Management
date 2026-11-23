import { useEffect, useState } from 'react';
import { Bot, Save } from 'lucide-react';
import { Button, Card, CardContent, useToast } from './ui';
import { useAuthStore } from '../store/authStore';
import { loadBookingLink } from '../lib/composerStorage';
import { aiReplyApi, apiError, type AiReplyMode, type AiReplySettings as Settings } from '../lib/aiFeaturesApi';

const LABELS: Array<{ value: string; name: string }> = [
  { value: 'interested', name: 'Interested' },
  { value: 'question', name: 'Question' },
  { value: 'neutral', name: 'Neutral' },
  { value: 'not_interested', name: 'Not interested (polite thank-you, no push)' },
];

const MODES: Array<{ value: AiReplyMode; name: string; help: string }> = [
  { value: 'off', name: 'Off', help: 'The AI does not answer by itself. You can still click “Write with AI” in the Inbox.' },
  { value: 'approve', name: 'Approve first', help: 'The AI writes an answer to each new reply. It waits in the Inbox until you use or discard it.' },
  { value: 'auto', name: 'Full auto', help: 'The AI answers by itself after the delay below. It stops when you answer, a meeting is booked or a limit is reached.' },
];

/** Settings → "AI reply agent". */
export function AiReplySettings() {
  const toast = useToast();
  const userId = useAuthStore((s) => s.user?.id);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [aiReady, setAiReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    aiReplyApi
      .getSettings()
      .then((d) => {
        if (!alive) return;
        // The Inbox meeting link (saved in this browser) is offered when the server has none yet.
        const link = d.settings.meetingLink || (userId ? loadBookingLink(userId) : '');
        setSettings({ ...d.settings, meetingLink: link });
        setAiReady(d.aiConfigured);
      })
      .catch((e) => alive && setError(apiError(e, 'Could not load the AI reply settings')));
    return () => {
      alive = false;
    };
  }, [userId]);

  if (error) {
    return (
      <Card>
        <CardContent className="py-5">
          <h2 className="text-base font-semibold text-gray-900">AI reply agent</h2>
          <p className="text-sm text-gray-500 mt-1" data-testid="ai-reply-settings-error">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (!settings) return null;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((s) => (s ? { ...s, [key]: value } : s));
  const linkOk = settings.meetingLink.trim() === '' || /^https?:\/\/\S+$/i.test(settings.meetingLink.trim());

  const save = async () => {
    if (!linkOk) {
      toast.error('Enter a full meeting link starting with https://');
      return;
    }
    if (settings.mode !== 'off' && !settings.offer.trim()) {
      toast.error('Describe what you offer first: the AI only uses what you write there.');
      return;
    }
    setSaving(true);
    try {
      const d = await aiReplyApi.saveSettings({ ...settings, meetingLink: settings.meetingLink.trim() });
      setSettings(d.settings);
      setAiReady(d.aiConfigured);
      toast.success('AI reply settings saved');
    } catch (e) {
      toast.error(apiError(e, 'Could not save the AI reply settings'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="py-5 space-y-4" data-testid="ai-reply-settings">
        <div>
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Bot className="w-4 h-4" /> AI reply agent
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            When a lead replies, the AI reads it (interested, a question, “too expensive”, “busy, later”) and writes an answer
            that moves the talk to a call. It never answers out-of-office, bounce or unsubscribe replies, or leads with a meeting booked.
          </p>
          {!aiReady && <p className="text-sm text-amber-700 mt-2">AI is not set up on this server yet, so no answers can be written.</p>}
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-gray-900 mb-2">Mode</legend>
          <div className="space-y-2">
            {MODES.map((m) => (
              <label key={m.value} className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" name="ai-reply-mode" className="mt-1" checked={settings.mode === m.value} onChange={() => set('mode', m.value)} />
                <span>
                  <span className="font-medium text-gray-900">{m.name}</span>
                  <span className="block text-gray-500">{m.help}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="ai-reply-offer" className="text-sm font-medium text-gray-900">What you offer</label>
          <p className="text-xs text-gray-500 mb-1">Your service, who it is for and real results. The AI uses only this (it never invents prices or features).</p>
          <textarea
            id="ai-reply-offer"
            value={settings.offer}
            maxLength={2000}
            rows={4}
            onChange={(e) => set('offer', e.target.value)}
            placeholder="We build websites for dentists. Clients get 30% more bookings in 3 months. Plans start after a free 15-minute call."
            className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400"
          />
        </div>

        <div>
          <label htmlFor="ai-reply-link" className="text-sm font-medium text-gray-900">Meeting link</label>
          <input
            id="ai-reply-link"
            type="url"
            value={settings.meetingLink}
            maxLength={500}
            onChange={(e) => set('meetingLink', e.target.value)}
            placeholder="https://calendly.com/your-name/15min"
            className={`w-full px-3 py-2 bg-white border rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 ${linkOk ? 'border-gray-300' : 'border-red-400'}`}
          />
          <p className="text-xs text-gray-500 mt-1">The AI offers this link to book a call. Without it, the AI asks for a time.</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-gray-900 mb-2">Answer these replies</legend>
          <div className="grid gap-1 sm:grid-cols-2">
            {LABELS.map((l) => (
              <label key={l.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.labels.includes(l.value)}
                  onChange={(e) => set('labels', e.target.checked ? [...settings.labels, l.value] : settings.labels.filter((x) => x !== l.value))}
                />
                {l.name}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField id="ai-reply-delay" label="Auto send after (minutes)" value={settings.delayMinutes} min={0} max={120} onChange={(v) => set('delayMinutes', v)} />
          <NumberField id="ai-reply-thread" label="Max AI replies per lead" value={settings.maxPerThread} min={1} max={10} onChange={(v) => set('maxPerThread', v)} />
          <NumberField id="ai-reply-daily" label="Max AI replies per day" value={settings.dailyLimit} min={1} max={1000} onChange={(v) => set('dailyLimit', v)} />
        </div>

        <div className="flex justify-end">
          <Button size="sm" leftIcon={<Save className="w-4 h-4" />} onClick={() => void save()} isLoading={saving} disabled={saving}>
            Save AI reply settings
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NumberField(props: { id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label htmlFor={props.id} className="text-sm font-medium text-gray-900">{props.label}</label>
      <input
        id={props.id}
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, Math.round(n))));
        }}
        className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400"
      />
    </div>
  );
}
