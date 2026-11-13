import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { dashboardApi, type BestSendTime } from '../lib/api';
import { Card, CardContent } from './ui';

/** Below this many opens the suggestion is not reliable enough to show. */
const MIN_OPENS = 10;

const formatHour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;

/** 570 -> "9:30 AM", 600 -> "10 AM". */
const formatMinute = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return mm ? `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}` : formatHour(h);
};

/** Analytics: the hour of day the user's leads open emails most (first opens, the viewer's time zone). */
export function BestSendTimeCard({ campaignIds, scopeSmtpId }: { campaignIds: number[]; scopeSmtpId: number | null }) {
  const [data, setData] = useState<BestSendTime | null>(null);
  const idsKey = campaignIds.join(',');

  useEffect(() => {
    let alive = true;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    dashboardApi
      .getBestSendTime({ timezone, campaignIds, scopeSmtpId })
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, scopeSmtpId]);

  if (!data) return null;
  const max = Math.max(1, ...data.hours.map((h) => h.opens));
  const enough = data.totalOpens >= MIN_OPENS && data.bestHour != null;
  const countries = data.countries ?? []; // an older API has no per-country data
  const withoutCountry = data.opensWithoutCountry ?? 0;

  return (
    <Card>
      <CardContent>
        <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
          <Clock className="w-4 h-4 text-gray-400" aria-hidden />
          Best Time to Send
        </h2>
        {enough ? (
          <p className="text-sm text-gray-700 mb-3">
            Your leads open emails most around <strong>{formatHour(data.bestHour!)}</strong>. Try scheduling campaigns
            a little before then.
          </p>
        ) : (
          <p className="text-xs text-gray-500 mb-3">
            Not enough opens yet ({data.totalOpens} so far). A suggestion appears after {MIN_OPENS} opens.
          </p>
        )}
        <div className="flex items-end h-12" style={{ gap: 1 }} aria-label="Opens by hour of day">
          {data.hours.map((h) => (
            <div
              key={h.hour}
              title={`${formatHour(h.hour)}: ${h.opens} open${h.opens === 1 ? '' : 's'}`}
              className={`flex-1 rounded ${enough && h.hour === data.bestHour ? 'bg-green-600' : 'bg-gray-300'}`}
              style={{ height: `${Math.max(4, (h.opens / max) * 100)}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span>
        </div>
        <p className="text-xs text-gray-400 mt-2">First opens, shown in your time zone ({data.timezone}).</p>

        <h3 className="text-sm font-semibold text-gray-900 mt-4 mb-1">By country</h3>
        {countries.length > 0 ? (
          <>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="py-1 font-medium">Country</th>
                  <th className="py-1 font-medium">Opens</th>
                  <th className="py-1 font-medium">Best (their time)</th>
                  <th className="py-1 font-medium">Schedule at (your time)</th>
                </tr>
              </thead>
              <tbody>
                {countries.map((c) => (
                  <tr key={c.country} className="border-b border-gray-100 text-gray-700" title={c.timezone}>
                    <td className="py-1">{c.country}</td>
                    <td className="py-1">{c.opens}</td>
                    <td className="py-1">{formatHour(c.bestLocalHour)}</td>
                    <td className="py-1 font-semibold text-gray-900">{formatMinute(c.bestViewerMinute)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {withoutCountry > 0 && (
              <p className="text-xs text-gray-400 mt-1">{withoutCountry} open{withoutCountry === 1 ? '' : 's'} without a country are not in this table.</p>
            )}
          </>
        ) : (
          <p className="text-xs text-gray-500">
            Add a <code>country</code> (or <code>timezone</code>) column to your recipient file to see the best time in each
            lead's own time.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
