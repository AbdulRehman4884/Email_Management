import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Workflow } from 'lucide-react';
import { Button, Card, CardContent, useToast } from '../ui';
import { crmAutomationsApi, apiErrorMessage, type CampaignAutomationInfo, type CrmAutomation } from '../../lib/api';
import { controlStyle } from './builderStyles';

/**
 * Campaign page: the campaign's follow-up automation. One automation per campaign; it can be picked, changed or removed
 * while the campaign is a draft or scheduled, and is locked once the campaign has started.
 * Shows nothing until the automation tables exist (the API answers 503 before migrations 0040 + 0041).
 */
export function CampaignAutomationCard({ campaignId }: { campaignId: number }) {
  const toast = useToast();
  const [info, setInfo] = useState<CampaignAutomationInfo | null>(null);
  const [choices, setChoices] = useState<CrmAutomation[]>([]);
  const [picked, setPicked] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    crmAutomationsApi
      .getCampaign(campaignId)
      .then((i) => {
        if (!alive) return;
        setInfo(i);
        setPicked(i.automationId != null ? String(i.automationId) : '');
      })
      .catch(() => alive && setInfo(null));
    crmAutomationsApi
      .list()
      .then((list) => alive && setChoices(list.filter((a) => a.kind === 'campaign')))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [campaignId]);

  if (!info) return null;

  const save = async () => {
    setSaving(true);
    try {
      const next = await crmAutomationsApi.setCampaign(campaignId, picked ? Number(picked) : null);
      setInfo(next);
      toast.success(next.automationId ? `Follow-ups: "${next.automationName}"` : 'No follow-up automation for this campaign');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save the automation'));
    } finally {
      setSaving(false);
    }
  };

  const changed = picked !== (info.automationId != null ? String(info.automationId) : '');

  return (
    <Card>
      <CardContent className="py-4">
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
          <Workflow className="w-4 h-4 text-gray-400" aria-hidden />
          Follow-up automation
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          After the first email, follow-ups go out by themselves as replies in the same thread, until the lead replies.
          One automation per campaign. It is locked once the campaign starts.
        </p>
        {info.canChange ? (
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <select aria-label="Follow-up automation" value={picked} onChange={(e) => setPicked(e.target.value)} style={{ ...controlStyle, minWidth: 240 }}>
              <option value="">None</option>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.isActive ? '' : ' (off)'}</option>
              ))}
            </select>
            <Button size="sm" onClick={() => void save()} isLoading={saving} disabled={!changed}>Save</Button>
            <Link to="/crm/automations" className="text-xs text-indigo-600">Manage automations</Link>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-3 text-sm text-gray-700">
            <Lock className="w-4 h-4 text-gray-400" aria-hidden />
            {info.automationId ? (
              <>
                <Link to={`/crm/automations/${info.automationId}`} className="text-indigo-600">{info.automationName}</Link>
                {info.automationActive === false && <span className="text-xs" style={{ color: '#b45309' }}>(off: follow-ups wait until it is on)</span>}
              </>
            ) : (
              <span className="text-gray-500">No follow-up automation</span>
            )}
            <span className="text-xs text-gray-400">· The campaign has started, so this cannot change.</span>
          </div>
        )}
        {info.canChange && choices.length === 0 && (
          <p className="text-xs text-gray-400 mt-2">
            No campaign automation yet. <Link to="/crm/automations" className="text-indigo-600">Create one</Link> (New automation, For campaigns).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
