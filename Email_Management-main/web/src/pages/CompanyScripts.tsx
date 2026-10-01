/**
 * src/pages/CompanyScripts.tsx — /scripts/companies/:companyId
 *
 * One company's scripts. Three buttons — cold email (medium), cold call (long),
 * LinkedIn (short). A button shows the saved script, or generates it on first
 * click. "Regenerate" writes a new one. Nothing is generated without a click.
 */

import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, Copy, ExternalLink, Linkedin, Mail, Phone, RefreshCw } from 'lucide-react';
import { Button, Card, CardContent, PageLoader } from '../components/ui';
import { scriptsApi } from '../lib/api';
import {
  SCRIPT_TYPES,
  SCRIPT_TYPE_META,
  displayHost,
  type SavedScript,
  type ScriptCompanyDetail,
  type ScriptType,
} from '../lib/scripts';

const TYPE_ICON: Record<ScriptType, React.ReactNode> = {
  cold_email: <Mail className="w-4 h-4" />,
  cold_call: <Phone className="w-4 h-4" />,
  linkedin: <Linkedin className="w-4 h-4" />,
};

function ScriptPanel({ script, onRegenerate, regenerating }: {
  script: SavedScript;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const meta = SCRIPT_TYPE_META[script.type];

  const copy = async () => {
    const text = script.subject ? `Subject: ${script.subject}\n\n${script.script}` : script.script;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — nothing else to do.
    }
  };

  if (script.status !== 'ok') {
    return (
      <div className="space-y-3" data-testid="script-panel">
        <p className="text-sm text-gray-600">
          No {meta.label.toLowerCase()}: the website didn’t show a clear problem our services solve, or it couldn’t be read.
        </p>
        <Button variant="outline" size="sm" isLoading={regenerating} onClick={onRegenerate} leftIcon={<RefreshCw className="w-4 h-4" />}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="script-panel">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Problem statement</p>
          {script.angle === 'industry' ? (
            <span
              data-testid="angle-badge"
              title="No clear problem on their website — this angle is based on common pain points in their industry."
              className="text-xs bg-amber-50 text-amber-700 rounded-full px-2 py-0.5"
            >
              Industry-based angle
            </span>
          ) : (
            <span data-testid="angle-badge" className="text-xs bg-green-50 text-green-700 rounded-full px-2 py-0.5">
              From their website
            </span>
          )}
        </div>
        <p className="text-sm text-gray-700">{script.problemStatement}</p>
      </div>

      <div className="rounded-lg bg-gray-50 border border-gray-100 p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            {meta.label} · {script.wordCount} words
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void copy()} leftIcon={copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} data-testid="copy-script">
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="outline" size="sm" isLoading={regenerating} onClick={onRegenerate} leftIcon={<RefreshCw className="w-4 h-4" />} data-testid="regenerate-script">
              Regenerate
            </Button>
          </div>
        </div>
        {script.subject && (
          <p className="text-sm text-gray-900 mb-2" data-testid="script-subject">
            <span className="font-semibold">Subject:</span> {script.subject}
          </p>
        )}
        <p className="text-sm text-gray-900 whitespace-pre-wrap leading-relaxed" data-testid="script-text">{script.script}</p>
      </div>

      <div className="flex flex-wrap gap-6">
        {script.recommendedServices.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Recommended services</p>
            <div className="flex flex-wrap gap-1">
              {script.recommendedServices.map((s) => (
                <span key={s} className="text-xs bg-indigo-50 text-indigo-700 rounded-full px-2.5 py-0.5">{s}</span>
              ))}
            </div>
          </div>
        )}
        {script.whatTheySell && (
          <div className="max-w-md">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">What they sell</p>
            <p className="text-sm text-gray-600">{script.whatTheySell}</p>
          </div>
        )}
      </div>

      {script.painPoints.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Pain points</p>
          <ul className="list-disc pl-5 text-sm text-gray-600 space-y-0.5">
            {script.painPoints.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export function CompanyScripts() {
  const { companyId: companyIdParam } = useParams();
  const companyId = Number(companyIdParam);

  const [company, setCompany] = React.useState<ScriptCompanyDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ScriptType | null>(null);
  const [busy, setBusy] = React.useState<ScriptType | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    scriptsApi
      .getCompany(companyId)
      .then((c) => { if (!cancelled) setCompany(c); })
      .catch(() => { if (!cancelled) setLoadError('Could not load this company. It may have been deleted.'); });
    return () => { cancelled = true; };
  }, [companyId]);

  const run = async (type: ScriptType, regenerate: boolean) => {
    setSelected(type);
    setError(null);
    // A saved script is shown straight away — no request, no cost.
    if (!regenerate && company?.scripts[type]) return;

    setBusy(type);
    const res = await scriptsApi.generate(companyId, type, regenerate);
    setBusy(null);
    if (!res.success) {
      setError(res.error);
      return;
    }
    setCompany((prev) => (prev ? { ...prev, scripts: { ...prev.scripts, [type]: res.data.script } } : prev));
  };

  if (loadError) {
    return (
      <div className="space-y-4">
        <Link to="/scripts" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft className="w-4 h-4" /> All files
        </Link>
        <p className="text-sm text-red-600">{loadError}</p>
      </div>
    );
  }
  if (!company) return <PageLoader />;

  const current = selected ? company.scripts[selected] : undefined;
  const extra = Object.entries(company.extraFields ?? {});

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/scripts/files/${company.fileId}`} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
          <ArrowLeft className="w-4 h-4" /> {company.filename}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">{company.companyName}</h1>
        <a href={company.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mt-1">
          {displayHost(company.website)} <ExternalLink className="w-3 h-3" />
        </a>
        {extra.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
            {extra.map(([k, v]) => <span key={k}><span className="text-gray-400">{k}:</span> {v}</span>)}
          </div>
        )}
      </div>

      {/* The three script buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {SCRIPT_TYPES.map((type) => {
          const meta = SCRIPT_TYPE_META[type];
          const saved = company.scripts[type];
          const active = selected === type;
          return (
            <button
              key={type}
              type="button"
              data-testid={`generate-${type}`}
              disabled={busy !== null}
              onClick={() => void run(type, false)}
              className={`text-left rounded-xl border p-4 transition-colors disabled:opacity-60 ${
                active ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white hover:border-gray-400'
              }`}
            >
              <div className="flex items-center gap-2 font-semibold text-sm">
                {TYPE_ICON[type]} {meta.label}
              </div>
              <p className={`text-xs mt-1 ${active ? 'text-gray-300' : 'text-gray-500'}`}>{meta.length}</p>
              <p className={`text-xs mt-2 font-medium ${active ? 'text-gray-200' : saved?.status === 'ok' ? 'text-green-600' : 'text-gray-400'}`}>
                {busy === type ? 'Generating…' : saved?.status === 'ok' ? 'Ready — click to view' : saved ? 'Not enough data' : 'Click to generate'}
              </p>
            </button>
          );
        })}
      </div>

      {(selected || error) && (
        <Card>
          <CardContent>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            {busy && busy === selected && !current ? (
              <p className="text-sm text-gray-500">Reading the website and writing the {SCRIPT_TYPE_META[busy].label.toLowerCase()}…</p>
            ) : current ? (
              <ScriptPanel
                script={current}
                regenerating={busy === selected}
                onRegenerate={() => selected && void run(selected, true)}
              />
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
