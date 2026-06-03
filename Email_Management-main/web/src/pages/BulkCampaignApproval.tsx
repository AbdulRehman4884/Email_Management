import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { bulkApi, campaignApi, settingsApi, type SmtpProfileItem } from '../lib/api';
import { Button, Card, CardContent, CardHeader, Input } from '../components/ui';

export function BulkCampaignApproval() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const numericJobId = Number(jobId);
  const [profiles, setProfiles] = React.useState<SmtpProfileItem[]>([]);
  const [smtpSettingsId, setSmtpSettingsId] = React.useState('');
  const [campaignName, setCampaignName] = React.useState(`Bulk Executive Outreach - ${new Date().toISOString().slice(0, 10)}`);
  const [dailySendLimit, setDailySendLimit] = React.useState(50);
  const [result, setResult] = React.useState<null | {
    campaignId: number;
    recipients: number;
    estimatedSendDurationDays: number;
    smtpSafeDailyCapacity: number;
    message: string;
  }>(null);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState('');
  const [starting, setStarting] = React.useState(false);

  React.useEffect(() => {
    settingsApi.listSmtpProfiles().then((response) => {
      setProfiles(response.data);
      if (response.data[0]) {
        setSmtpSettingsId(String(response.data[0].id));
        setDailySendLimit(Math.min(50, response.data[0].dailyLimit || 50));
      }
    }).catch(() => setProfiles([]));
  }, []);

  const selected = profiles.find((profile) => String(profile.id) === smtpSettingsId);
  const estimated = selected ? Math.max(1, Math.ceil(1000 / Math.max(1, Math.min(dailySendLimit, selected.dailyLimit || dailySendLimit)))) : null;

  const createDraft = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await bulkApi.approve(numericJobId, {
        campaignName,
        smtpSettingsId: Number(smtpSettingsId),
        dailySendLimit,
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create campaign draft.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Campaign Approval</h1>
        <p className="mt-1 text-sm text-gray-600">
          This creates a draft campaign using existing MailFlow campaign, recipient, SMTP, and worker infrastructure. It does not send.
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Draft Settings</h2>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Campaign name</span>
            <Input className="mt-1" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">SMTP profile</span>
            <select
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={smtpSettingsId}
              onChange={(event) => setSmtpSettingsId(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.fromEmail} ({profile.provider}, {profile.dailyLimit}/day)
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-gray-700">Campaign daily send cap</span>
            <Input
              className="mt-1"
              type="number"
              min={1}
              max={selected?.dailyLimit || 1000}
              value={dailySendLimit}
              onChange={(event) => setDailySendLimit(Number(event.target.value))}
            />
          </label>

          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
            <div className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <p className="font-medium">Safety checkpoint</p>
                <p className="mt-1">
                  Draft creation attaches recipients and personalized templates only. Sending still requires opening the campaign and explicitly starting it.
                </p>
                {estimated && (
                  <p className="mt-1">At this cap, 1000 recipients would take about {estimated} day(s). Exact duration depends on approved template count and SMTP availability.</p>
                )}
              </div>
            </div>
          </div>

          {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

          <div className="flex flex-wrap gap-3">
            <Button onClick={createDraft} isLoading={saving} disabled={!smtpSettingsId}>Create draft campaign</Button>
            <Button variant="secondary" onClick={() => navigate(`/bulk/${numericJobId}/templates`)}>Back to review</Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardContent className="space-y-3">
            <h2 className="text-lg font-semibold text-gray-900">Draft created</h2>
            <p className="text-sm text-gray-700">{result.message}</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Recipients" value={result.recipients} />
              <Metric label="Daily cap" value={result.smtpSafeDailyCapacity} />
              <Metric label="Estimated days" value={result.estimatedSendDurationDays} />
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-medium">Final confirmation required before sending</p>
              <p className="mt-1">
                Recipients: {result.recipients}. Daily limit: {result.smtpSafeDailyCapacity}/day. Estimated duration: {result.estimatedSendDurationDays} day(s).
                Unsubscribe, reply stop rules, bounce handling, SMTP limits, and worker scheduling remain handled by the existing MailFlow send pipeline.
              </p>
              <p className="mt-2">Type CONFIRM to start this campaign now.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Input className="max-w-xs" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} placeholder="CONFIRM" />
                <Button
                  variant="danger"
                  isLoading={starting}
                  disabled={confirmText.trim() !== 'CONFIRM'}
                  onClick={async () => {
                    setStarting(true);
                    try {
                      await campaignApi.start(result.campaignId);
                      navigate(`/campaigns/${result.campaignId}`);
                    } finally {
                      setStarting(false);
                    }
                  }}
                >
                  Start Campaign
                </Button>
              </div>
            </div>
            <Link className="inline-flex rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white" to={`/campaigns/${result.campaignId}`}>
              Open campaign draft without starting
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}
