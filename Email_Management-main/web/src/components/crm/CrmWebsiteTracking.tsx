import React, { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Globe, Plus, Trash2 } from 'lucide-react';
import { crmApi, apiErrorMessage, type CrmSite } from '../../lib/api';
import { Button, Card, CardContent, useToast } from '../ui';
import { controlStyle, iconButtonStyle } from './builderStyles';

/** How often the list refreshes while a website still waits for its first visit ("Installed" within a minute). */
const WAIT_POLL_MS = 15_000;

const pagesText = (pages: string[]) => pages.join(', ');
const parsePages = (text: string) => text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function SiteRow({ site, scriptUrl, onChange, onDelete }: { site: CrmSite; scriptUrl: string; onChange: (s: CrmSite) => void; onDelete: () => void }) {
  const toast = useToast();
  const [pages, setPages] = useState(pagesText(site.keyPages));
  const [copied, setCopied] = useState(false);
  useEffect(() => setPages(pagesText(site.keyPages)), [site.keyPages]);

  const snippet = `<script src="${scriptUrl}" data-site="${site.siteKey}" async></script>`;

  const update = async (body: { keyPages?: string[]; requireConsent?: boolean; isActive?: boolean }) => {
    try {
      onChange(await crmApi.updateSite(site.id, body));
    } catch (e) {
      setPages(pagesText(site.keyPages));
      toast.error(apiErrorMessage(e, 'Could not save the website'));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed: select the script line and copy it by hand');
    }
  };

  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="text-sm font-semibold text-gray-900">{site.domain}</span>
        <span
          className="text-xs"
          style={{
            borderRadius: 999,
            padding: '1px 8px',
            fontWeight: 600,
            background: site.installed ? '#dcfce7' : '#fef3c7',
            color: site.installed ? '#15803d' : '#b45309',
          }}
          title={site.installedAt ? `First visit ${new Date(site.installedAt).toLocaleString()}` : undefined}
        >
          {site.installed ? 'Installed' : 'Waiting for the first visit'}
        </span>
        {!site.isActive && <span className="text-xs text-gray-400">Paused</span>}
        <span style={{ flex: 1 }} />
        <span className="text-xs text-gray-500">
          Last 30 days: {site.last30Days.visitors} visitor{site.last30Days.visitors === 1 ? '' : 's'}, {site.last30Days.pageviews} page view
          {site.last30Days.pageviews === 1 ? '' : 's'} · {site.leads} known lead{site.leads === 1 ? '' : 's'}
        </span>
        <button type="button" aria-label={`Remove ${site.domain}`} title="Remove website" onClick={onDelete} style={iconButtonStyle}>
          <Trash2 size={14} />
        </button>
      </div>

      <label className="block text-xs font-medium text-gray-700" style={{ margin: '10px 0 4px' }}>
        Add this line to every page of your website, before &lt;/head&gt;
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <code
          className="text-xs"
          style={{ flex: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '7px 10px' }}
        >
          {snippet}
        </code>
        <Button variant="secondary" size="sm" onClick={() => void copy()} leftIcon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <label className="block text-xs font-medium text-gray-700" style={{ margin: '10px 0 4px' }} htmlFor={`key-pages-${site.id}`}>
        Key pages (you get an alert when a lead opens one)
      </label>
      <input
        id={`key-pages-${site.id}`}
        value={pages}
        placeholder="/pricing, /book-demo"
        onChange={(e) => setPages(e.target.value)}
        onBlur={() => {
          if (pages !== pagesText(site.keyPages)) void update({ keyPages: parsePages(pages) });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        style={{ ...controlStyle, width: '100%' }}
      />

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
        <label className="flex items-start gap-2 text-xs text-gray-700" style={{ cursor: 'pointer', maxWidth: 420 }}>
          <input type="checkbox" checked={site.requireConsent} onChange={(e) => void update({ requireConsent: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            Only track after the visitor gives consent
            <span className="block text-gray-400">
              Your cookie banner calls <code>window.mailflow.consent()</code>, or add <code>data-consent="granted"</code> to the script line.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-700" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={site.isActive} onChange={(e) => void update({ isActive: e.target.checked })} />
          Tracking on
        </label>
      </div>
    </div>
  );
}

/** Settings → "Website tracking" (step 10): websites, script line, key pages, consent. */
export function CrmWebsiteTracking() {
  const toast = useToast();
  const [sites, setSites] = useState<CrmSite[] | null>(null);
  const [scriptUrl, setScriptUrl] = useState('');
  const [retentionDays, setRetentionDays] = useState(180);
  const [hidden, setHidden] = useState(false);
  const [domain, setDomain] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const r = await crmApi.listSites();
    setSites(r.sites);
    setScriptUrl(r.scriptUrl);
    setRetentionDays(r.retentionDays);
  }, []);

  useEffect(() => {
    load().catch(() => setHidden(true)); // no CRM in the plan: the rest of Settings still works
  }, [load]);

  const waiting = sites?.some((s) => !s.installed && s.isActive) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => void load().catch(() => undefined), WAIT_POLL_MS);
    return () => window.clearInterval(t);
  }, [waiting, load]);

  if (hidden || !sites) return null;

  const add = async () => {
    if (!domain.trim()) return;
    setAdding(true);
    try {
      const site = await crmApi.createSite({ domain: domain.trim() });
      setSites([...sites, site]);
      setDomain('');
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add the website'));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (site: CrmSite) => {
    if (!window.confirm(`Remove ${site.domain}? Its tracked visits are deleted too.`)) return;
    try {
      await crmApi.deleteSite(site.id);
      setSites(sites.filter((s) => s.id !== site.id));
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not remove the website'));
    }
  };

  return (
    <Card>
      <CardContent className="py-5">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-gray-500" />
          <h2 className="text-base font-semibold text-gray-900">Website tracking</h2>
        </div>
        <p className="text-sm text-gray-500 mt-0.5">
          See which leads visit your website. Links to your website in campaign and follow-up emails get a private code, so a
          click shows on the lead. Visitors with Do Not Track on are never tracked, IP addresses are not stored, and visits are
          deleted after {retentionDays} days.
        </p>

        {sites.map((s) => (
          <SiteRow
            key={s.id}
            site={s}
            scriptUrl={scriptUrl}
            onChange={(n) => setSites(sites.map((x) => (x.id === n.id ? n : x)))}
            onDelete={() => void remove(s)}
          />
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            aria-label="Website address"
            value={domain}
            placeholder="www.myshop.com"
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
            style={{ ...controlStyle, flex: 1, minWidth: 0 }}
          />
          <Button variant="secondary" onClick={() => void add()} isLoading={adding} leftIcon={<Plus className="w-4 h-4" />}>
            Add website
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
