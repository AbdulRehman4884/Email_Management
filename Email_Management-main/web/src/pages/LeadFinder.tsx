/**
 * Lead Finder (Lead Engine, use case UC-01 + UC-10).
 *   - new search: category + city (+ people, leads per run), run now or schedule
 *   - leads: filters (search, found today, Hot/Warm/Cold, has email, decision maker), select -> Save to CRM,
 *     Add to campaign (draft/paused), Reject
 *   - lead detail: company, people, emails/phones and where every field came from
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, ExternalLink, Linkedin, Loader2, Play, Radar, RefreshCw, UserCheck, X } from 'lucide-react';
import { Button, Card, CardContent, EmptyState, Modal, useToast } from '../components/ui';
import {
  campaignApi, leadGenApi, leadGenErrorText,
  type FinderLead, type FinderLeadDetail, type LeadRun, type LeadSearch, type LeadTier, type LeadUsage,
} from '../lib/api';
import type { Campaign } from '../types';

const TIER_STYLE: Record<LeadTier, string> = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-slate-100 text-slate-600',
};
const STATUS_LABEL: Record<string, string> = {
  new: 'New', reviewed: 'Reviewed', saved_to_crm: 'In CRM', in_campaign: 'In campaign', rejected: 'Rejected',
};
const RUN_STYLE: Record<string, string> = {
  queued: 'text-slate-500', running: 'text-blue-600', done: 'text-green-600', partial: 'text-amber-600', failed: 'text-red-600', cancelled: 'text-slate-400',
};
const SOURCE_LABEL: Record<string, string> = {
  osm: 'OpenStreetMap', ddg: 'DuckDuckGo', serp_api: 'search results', website: 'company website', search_linkedin: 'LinkedIn search result', pdl: 'data provider',
};

function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function fieldLabel(field: string): string {
  return field.replace(/^social_/, '').replace(/_/g, ' ');
}

/** Country picker: names shown, ISO codes sent (free text let "Pakistan" become "PA" = Panama). */
const COUNTRIES: Array<[string, string]> = [
  ['PK', 'Pakistan'], ['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['QA', 'Qatar'], ['OM', 'Oman'], ['KW', 'Kuwait'],
  ['BH', 'Bahrain'], ['IN', 'India'], ['BD', 'Bangladesh'], ['GB', 'United Kingdom'], ['US', 'United States'], ['CA', 'Canada'],
  ['AU', 'Australia'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['IE', 'Ireland'], ['TR', 'Turkey'],
  ['MY', 'Malaysia'], ['SG', 'Singapore'], ['ZA', 'South Africa'], ['EG', 'Egypt'], ['NG', 'Nigeria'], ['KE', 'Kenya'],
];

/**
 * A search in a list: its name plus what tells two similar searches apart (focus if the name lacks it,
 * leads per run, schedule) and its number. "IT and software companies in Lahore · AI automation · 20/run · daily 09:00 · #4"
 */
function searchLabel(s: LeadSearch): string {
  const parts = [s.name];
  const focus = s.category && s.keywords.length ? s.keywords.join(', ') : '';
  if (focus && !s.name.toLowerCase().includes(focus.toLowerCase())) parts.push(focus);
  parts.push(`${s.targetPerRun}/run`);
  if (s.schedule) parts.push(s.schedule.isPaused ? 'paused' : `${s.schedule.frequency === 'weekly' ? 'weekly' : 'daily'} ${s.schedule.runAtLocal}`);
  parts.push(`#${s.id}`);
  return parts.join(' · ');
}

function TierBadge({ tier, score }: { tier: LeadTier; score: number }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TIER_STYLE[tier]}`}>{tier} {score}</span>;
}

// ── New search ───────────────────────────────────────────────────────────────

function NewSearchCard({ categories, usage, onCreated }: {
  categories: Array<{ key: string; label: string }>;
  usage: LeadUsage | null;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [focus, setFocus] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [includePeople, setIncludePeople] = useState(false);
  const [perRun, setPerRun] = useState(20);
  const [scheduleAt, setScheduleAt] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category || !city.trim()) {
      toast.error('Choose a business category and give a city.');
      return;
    }
    setBusy(true);
    try {
      const search = await leadGenApi.createSearch({
        category, focus: focus.trim() || undefined, city: city.trim(), countryCode: country || undefined, includePeople, targetPerRun: perRun,
      });
      if (scheduleAt) {
        await leadGenApi.schedule(search.id, { runAtLocal: scheduleAt });
        toast.success(`${search.name} runs every day at ${scheduleAt}.`);
      } else {
        await leadGenApi.runNow(search.id);
        toast.success(`${search.name}: search started. New leads appear here when it finishes.`);
      }
      setCategory('');
      setFocus('');
      setCity('');
      onCreated();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Find new leads</h2>
            {usage && (
              <span className="text-xs text-gray-500">
                Today: {usage.leadsToday}/{usage.dailyLimit} new leads · {usage.activeSearches}/{usage.maxSearches} searches
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="text-sm">
              <span className="block text-gray-600 mb-1">Business category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                <option value="">Choose a category</option>
                {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-gray-600 mb-1">City</span>
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Lahore" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block text-gray-600 mb-1">Country (optional)</span>
              <select value={country} onChange={(e) => setCountry(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2">
                <option value="">Any country</option>
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-gray-600 mb-1">Leads per run</span>
              <input type="number" min={1} max={100} value={perRun} onChange={(e) => setPerRun(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="block text-gray-600 mb-1">Focus / what they do (optional)</span>
            <input value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={300}
              placeholder="e.g. AI automation, chatbots (comma separated)" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
            <span className="block text-xs text-gray-400 mt-1">
              Companies whose website mentions this get +20 score and a "focus" badge, and come first. The category decides which businesses are searched.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={includePeople} onChange={(e) => setIncludePeople(e.target.checked)} />
              Also find decision makers (owners, CEOs)
            </label>
            <label className="inline-flex items-center gap-2">
              <CalendarClock className="w-4 h-4 text-gray-500" />
              Run daily at
              <input type="time" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} className="rounded border border-gray-300 px-2 py-1" />
              <span className="text-gray-400">(empty = run once now)</span>
            </label>
            <div className="ml-auto">
              <Button type="submit" isLoading={busy} leftIcon={scheduleAt ? <CalendarClock className="w-4 h-4" /> : <Play className="w-4 h-4" />}>
                {scheduleAt ? 'Save and schedule' : 'Find leads now'}
              </Button>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Sources: OpenStreetMap, search results and the companies' own websites. LinkedIn data only from public search results.
            Each run uses your daily lead quota.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Lead detail ──────────────────────────────────────────────────────────────

function LeadDetailModal({ leadId, onClose }: { leadId: number | null; onClose: () => void }) {
  const [detail, setDetail] = useState<FinderLeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (leadId == null) return;
    let alive = true;
    setDetail(null);
    setError(null);
    leadGenApi.lead(leadId).then((d) => alive && setDetail(d)).catch((e) => alive && setError(leadGenErrorText(e)));
    return () => {
      alive = false;
    };
  }, [leadId]);

  const sourceOf = (url: string | null, source: string | null, when: string) =>
    `${SOURCE_LABEL[source ?? ''] ?? source ?? 'unknown source'}${url ? ` (${url.replace(/^https?:\/\//, '').slice(0, 60)})` : ''}, ${ago(when)}`;

  return (
    <Modal isOpen={leadId != null} onClose={onClose} title={detail?.lead.company.name ?? 'Lead'} size="xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!detail && !error && <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>}
      {detail && (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <TierBadge tier={detail.lead.scoreTier} score={detail.lead.fitScore} />
            <span className="text-gray-500">{STATUS_LABEL[detail.lead.status]}</span>
            {detail.lead.company.websiteUrl && (
              <a href={detail.lead.company.websiteUrl} target="_blank" rel="noreferrer noopener" className="text-indigo-600 inline-flex items-center gap-1">
                {detail.lead.company.domain ?? 'website'} <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {detail.lead.company.city && <span className="text-gray-500">{detail.lead.company.city}</span>}
          </div>
          {detail.company.description && <p className="text-gray-700">{detail.company.description}</p>}

          <div>
            <h3 className="font-semibold text-gray-900 mb-1">Why this score</h3>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-gray-600">
              {detail.lead.scoreBreakdown.map((b) => <li key={b.key}>+{b.points} {b.label}</li>)}
              {detail.lead.scoreBreakdown.length === 0 && <li>Nothing known yet: the website check may still be running.</li>}
            </ul>
          </div>

          <div>
            <h3 className="font-semibold text-gray-900 mb-1">Emails and phones</h3>
            {detail.contactPoints.length === 0 && <p className="text-gray-500">None found yet.</p>}
            <ul className="space-y-1">
              {detail.contactPoints.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium text-gray-800">{c.value_normalized}</span>
                  <span className="text-gray-500">{c.type}{c.label ? ` · ${c.label}` : ''}{c.person ? ` · ${c.person}` : ''}</span>
                  {c.type === 'email' && (
                    <span className={c.mx_valid ? 'text-green-600' : c.mx_valid === false ? 'text-red-600' : 'text-gray-400'}>
                      {c.mx_valid ? 'mail domain OK' : c.mx_valid === false ? 'no mail server' : 'not checked'}
                    </span>
                  )}
                  <span className="text-gray-400">— {sourceOf(c.source_url, c.source, c.first_seen_at)}</span>
                </li>
              ))}
            </ul>
          </div>

          {detail.people.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">People</h3>
              <ul className="space-y-1">
                {detail.people.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <UserCheck className="w-4 h-4 text-gray-400" />
                    <span className="font-medium">{p.full_name}</span>
                    <span className="text-gray-500">{p.title}</span>
                    {p.linkedin_url && <a href={p.linkedin_url} target="_blank" rel="noreferrer noopener" className="text-indigo-600"><Linkedin className="w-4 h-4" /></a>}
                    <span className="text-gray-400">confidence {p.confidence}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail.socialProfiles.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Social profiles</h3>
              <ul className="flex flex-wrap gap-3">
                {detail.socialProfiles.map((s) => (
                  <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener" className="text-indigo-600">{s.platform}</a> <span className="text-gray-400">({s.found_via.replace('_', ' ')})</span></li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-gray-600">
            {detail.company.employee_range && <div><div className="text-gray-400 text-xs">Employees</div>{detail.company.employee_range}</div>}
            {detail.company.founded_year && <div><div className="text-gray-400 text-xs">Founded</div>{detail.company.founded_year}</div>}
            {detail.company.hiring_signals?.careers_page && <div><div className="text-gray-400 text-xs">Hiring</div>{detail.company.hiring_signals.open_roles ?? 0} open roles</div>}
            {(detail.company.tech_stack?.length ?? 0) > 0 && <div><div className="text-gray-400 text-xs">Website tech</div>{detail.company.tech_stack!.join(', ')}</div>}
          </div>

          <div>
            <h3 className="font-semibold text-gray-900 mb-1">Where the data came from</h3>
            <table className="w-full text-xs">
              <tbody>
                {detail.fieldSources.map((f) => (
                  <tr key={f.field} className="border-t border-gray-100">
                    <td className="py-1 pr-2 text-gray-500 capitalize">{fieldLabel(f.field)}</td>
                    <td className="py-1 pr-2 text-gray-800 break-all">{typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}</td>
                    <td className="py-1 text-gray-400">{sourceOf(f.source_url, f.source, f.observed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Add to campaign ──────────────────────────────────────────────────────────

function AddToCampaignModal({ open, leadIds, onClose, onDone }: { open: boolean; leadIds: number[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    campaignApi.getAll().then((all) => {
      const editable = all.filter((c) => c.status === 'draft' || c.status === 'paused');
      setCampaigns(editable);
      setCampaignId(editable[0] ? Number(editable[0].id) : null);
    }).catch(() => setCampaigns([]));
  }, [open]);

  const add = async () => {
    if (!campaignId) return;
    setBusy(true);
    try {
      const r = await leadGenApi.addToCampaign(leadIds, campaignId);
      const skipped = r.skippedNoEmail + r.skippedDuplicate + r.skippedSuppressed;
      toast.success(`Added ${r.added} lead(s)${skipped ? `, ${skipped} skipped (no verified email, already in it, or unsubscribed)` : ''}. Nothing was sent.`);
      onDone();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={`Add ${leadIds.length} lead(s) to a campaign`}>
      {campaigns.length === 0 ? (
        <p className="text-sm text-gray-600">You have no draft or paused campaign. <Link to="/campaigns/create" className="text-indigo-600">Create a campaign</Link> first.</p>
      ) : (
        <div className="space-y-4 text-sm">
          <select value={campaignId ?? ''} onChange={(e) => setCampaignId(Number(e.target.value))} className="w-full rounded-lg border border-gray-300 px-3 py-2">
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
          </select>
          <p className="text-gray-500">Only leads with a verified email are added. The campaign does not start: you start it yourself.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button isLoading={busy} onClick={() => void add()}>Add to campaign</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function LeadFinder() {
  const toast = useToast();
  const [params] = useSearchParams();
  const [usage, setUsage] = useState<LeadUsage | null>(null);
  const [categories, setCategories] = useState<Array<{ key: string; label: string }>>([]);
  const [searches, setSearches] = useState<LeadSearch[]>([]);
  const [runs, setRuns] = useState<LeadRun[]>([]);
  const [leads, setLeads] = useState<FinderLead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detailId, setDetailId] = useState<number | null>(null);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [filters, setFilters] = useState({
    savedSearchId: undefined as number | undefined,
    foundToday: params.get('today') === '1',
    tier: [] as LeadTier[],
    hasEmail: false,
    hasDecisionMaker: false,
    matchesFocus: false,
    q: '',
  });
  const LIMIT = 25;

  const loadMeta = useCallback(async () => {
    try {
      const [u, cats, s, r] = await Promise.all([leadGenApi.usage(), leadGenApi.categories(), leadGenApi.searches(), leadGenApi.runs(undefined, 5)]);
      setUsage(u);
      setCategories(cats);
      setSearches(s);
      setRuns(r);
      setBlocked(null);
    } catch (err) {
      setBlocked(leadGenErrorText(err));
    }
  }, []);

  const loadLeads = useCallback(async () => {
    setLoading(true);
    try {
      const r = await leadGenApi.leads({
        savedSearchId: filters.savedSearchId, foundToday: filters.foundToday, tier: filters.tier,
        hasEmail: filters.hasEmail || undefined, hasDecisionMaker: filters.hasDecisionMaker || undefined,
        matchesFocus: filters.matchesFocus || undefined, q: filters.q, page, limit: LIMIT,
      });
      setLeads(r.leads);
      setTotal(r.total);
      setSelected(new Set());
    } catch (err) {
      setBlocked(leadGenErrorText(err));
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);
  useEffect(() => {
    void loadLeads();
  }, [loadLeads]);

  // While a run is going, refresh every 10 seconds.
  const active = runs.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => {
      void loadMeta();
      void loadLeads();
    }, 10_000);
    return () => window.clearInterval(t);
  }, [active, loadMeta, loadLeads]);

  const searchName = useMemo(() => new Map(searches.map((s) => [s.id, s.name])), [searches]);
  const ids = [...selected];
  const toggle = (id: number) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const saveToCrm = async () => {
    try {
      const r = await leadGenApi.saveToCrm(ids);
      toast.success(`CRM: ${r.saved} new, ${r.updated} updated${r.skippedNoEmail ? `, ${r.skippedNoEmail} without email skipped` : ''}${r.skippedSuppressed ? `, ${r.skippedSuppressed} unsubscribed skipped` : ''}.`);
      void loadLeads();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    }
  };
  const reject = async () => {
    try {
      await leadGenApi.reject(ids);
      toast.info(`${ids.length} lead(s) rejected. They will not be shown again.`);
      void loadLeads();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    }
  };
  const cancelRun = async (id: number) => {
    try {
      await leadGenApi.cancelRun(id);
      void loadMeta();
    } catch (err) {
      toast.error(leadGenErrorText(err));
    }
  };

  if (blocked && !usage) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><Radar className="w-8 h-8" /> Lead Finder</h1>
        <Card><CardContent><p className="text-gray-600">{blocked}</p></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-gray-900">
            <Radar className="w-8 h-8" />
            <h1 className="text-2xl font-bold">Lead Finder</h1>
          </div>
          <p className="text-gray-500 mt-1 text-sm">Finds businesses for your target customers every day and shows only leads you have not seen before.</p>
        </div>
        <Link to="/lead-finder/schedules"><Button variant="secondary" leftIcon={<CalendarClock className="w-4 h-4" />}>Searches and schedules</Button></Link>
      </div>

      <NewSearchCard categories={categories} usage={usage} onCreated={() => { void loadMeta(); void loadLeads(); }} />

      {runs.length > 0 && (
        <Card>
          <CardContent>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Recent runs</h2>
            <ul className="text-sm space-y-1">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className={`font-medium ${RUN_STYLE[r.status]}`}>{r.status}</span>
                  <span className="text-gray-700">{searchName.get(r.savedSearchId ?? -1) ?? 'Lead search'}</span>
                  <span className="text-gray-500">{r.stats.new_leads ?? 0} new · {r.stats.discovered ?? 0} found</span>
                  {r.error && <span className="text-amber-600">{r.error}</span>}
                  {(r.status === 'queued' || r.status === 'running') && (
                    <button onClick={() => void cancelRun(r.id)} className="text-gray-400 hover:text-red-600 inline-flex items-center gap-1"><X className="w-3 h-3" />cancel</button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <select value={filters.savedSearchId ?? ''} onChange={(e) => { setPage(1); setFilters({ ...filters, savedSearchId: e.target.value ? Number(e.target.value) : undefined }); }}
              className="rounded-lg border border-gray-300 px-2 py-1.5">
              <option value="">All searches</option>
              {searches.map((s) => <option key={s.id} value={s.id}>{searchLabel(s)}</option>)}
            </select>
            <label className="inline-flex items-center gap-1"><input type="checkbox" checked={filters.foundToday} onChange={(e) => { setPage(1); setFilters({ ...filters, foundToday: e.target.checked }); }} />New today</label>
            {(['hot', 'warm', 'cold'] as LeadTier[]).map((t) => (
              <label key={t} className="inline-flex items-center gap-1 capitalize">
                <input type="checkbox" checked={filters.tier.includes(t)} onChange={(e) => {
                  setPage(1);
                  setFilters({ ...filters, tier: e.target.checked ? [...filters.tier, t] : filters.tier.filter((x) => x !== t) });
                }} />{t}
              </label>
            ))}
            <label className="inline-flex items-center gap-1"><input type="checkbox" checked={filters.hasEmail} onChange={(e) => { setPage(1); setFilters({ ...filters, hasEmail: e.target.checked }); }} />Has email</label>
            <label className="inline-flex items-center gap-1"><input type="checkbox" checked={filters.hasDecisionMaker} onChange={(e) => { setPage(1); setFilters({ ...filters, hasDecisionMaker: e.target.checked }); }} />Decision maker</label>
            <label className="inline-flex items-center gap-1"><input type="checkbox" checked={filters.matchesFocus} onChange={(e) => { setPage(1); setFilters({ ...filters, matchesFocus: e.target.checked }); }} />Matches focus</label>
            <input value={filters.q} onChange={(e) => { setPage(1); setFilters({ ...filters, q: e.target.value }); }} placeholder="Search name or domain" className="rounded-lg border border-gray-300 px-2 py-1.5" />
            <button onClick={() => void loadLeads()} className="text-gray-500 hover:text-gray-800" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 bg-indigo-50 rounded-lg px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <Button size="sm" onClick={() => void saveToCrm()}>Save to CRM</Button>
              <Button size="sm" variant="secondary" onClick={() => setCampaignOpen(true)}>Add to campaign</Button>
              <Button size="sm" variant="ghost" onClick={() => void reject()}>Reject</Button>
            </div>
          )}

          {loading ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
          ) : leads.length === 0 ? (
            <EmptyState icon={<Radar className="w-8 h-8 text-gray-400" />} title="No leads yet" description="Start a search above. New leads show up here when a run finishes." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-2">
                      <input type="checkbox" checked={selected.size === leads.length} onChange={(e) => setSelected(e.target.checked ? new Set(leads.map((l) => l.id)) : new Set())} />
                    </th>
                    <th className="py-2 pr-3">Company</th>
                    <th className="py-2 pr-3">Score</th>
                    <th className="py-2 pr-3">Contact</th>
                    <th className="py-2 pr-3">Decision maker</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2">Found</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setDetailId(l.id)}>
                      <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>
                      <td className="py-2 pr-3">
                        <div className="font-medium text-gray-900">
                          {l.company.name}
                          {l.focusMatch && <span className="ml-2 inline-flex px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-700">✓ {l.focusMatch}</span>}
                        </div>
                        <div className="text-gray-500 text-xs">{[l.company.domain, l.company.city].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="py-2 pr-3"><TierBadge tier={l.scoreTier} score={l.fitScore} /></td>
                      <td className="py-2 pr-3 text-xs">
                        <div>{l.company.email ?? <span className="text-gray-400">no email</span>}</div>
                        <div className="text-gray-500">{l.company.phone}</div>
                      </td>
                      <td className="py-2 pr-3 text-xs">{l.person ? <><div className="font-medium">{l.person.fullName}</div><div className="text-gray-500">{l.person.title}</div></> : <span className="text-gray-400">—</span>}</td>
                      <td className="py-2 pr-3 text-xs">{STATUS_LABEL[l.status]}</td>
                      <td className="py-2 text-xs text-gray-500">{ago(l.foundAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > LIMIT && (
            <div className="flex items-center justify-between text-sm text-gray-500">
              <span>{(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" variant="secondary" disabled={page * LIMIT >= total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <LeadDetailModal leadId={detailId} onClose={() => setDetailId(null)} />
      <AddToCampaignModal open={campaignOpen} leadIds={ids} onClose={() => setCampaignOpen(false)} onDone={() => { setCampaignOpen(false); void loadLeads(); }} />
    </div>
  );
}
