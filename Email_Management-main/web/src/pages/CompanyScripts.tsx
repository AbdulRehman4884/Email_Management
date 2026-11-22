/**
 * src/pages/CompanyScripts.tsx — /scripts/companies/:companyId
 *
 * One company's scripts. Three buttons — cold email (medium), cold call (long),
 * LinkedIn (short). A button shows the saved script, or generates it on first
 * click. "Regenerate" writes a new one. Nothing is generated without a click.
 */

import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, Linkedin, Mail, Phone, RefreshCw, UserRound } from 'lucide-react';
import { Button, Card, CardContent, Input, PageLoader } from '../components/ui';
import { scriptsApi } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import {
  SCRIPT_TYPES,
  SCRIPT_TYPE_META,
  displayHost,
  loadScriptSender,
  saveScriptSender,
  type SavedScript,
  type ScriptCompanyDetail,
  type ScriptSender,
  type ScriptType,
} from '../lib/scripts';

/**
 * "Whose name goes in the scripts?" — asked before the first script is written, remembered per user.
 * Scripts used to always say "Reyan from Dalta Prime AI Solution" (bug B19-10).
 */
function SenderForm({ initial, onSave, onCancel, saveLabel }: {
  initial: ScriptSender;
  onSave: (sender: ScriptSender) => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  const [name, setName] = React.useState(initial.name);
  const [company, setCompany] = React.useState(initial.company);
  const ready = name.trim().length > 0 && company.trim().length > 0;
  return (
    <form
      data-testid="sender-form"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSave({ name: name.trim(), company: company.trim() });
      }}
    >
      <div>
        <p className="text-sm font-semibold text-gray-900">Whose name should the scripts use?</p>
        <p className="text-sm text-gray-500">The scripts introduce you and sign off with this name and company. You can change it any time.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Input label="Your name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. Abdul Rahman" data-testid="sender-name" required />
        <Input label="Your company" value={company} maxLength={150} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Delta Prime AI Solutions" data-testid="sender-company" required />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!ready} data-testid="sender-save">{saveLabel}</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

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
  const navigate = useNavigate();

  const [company, setCompany] = React.useState<ScriptCompanyDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ScriptType | null>(null);
  const [busy, setBusy] = React.useState<ScriptType | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const user = useAuthStore((s) => s.user);
  const [sender, setSender] = React.useState<ScriptSender | null>(() => loadScriptSender(user?.id));
  /** The script waiting for the sender's name (asked first), or 'edit' when the user changes it. */
  const [askSender, setAskSender] = React.useState<{ type: ScriptType; regenerate: boolean } | 'edit' | null>(null);

  React.useEffect(() => { setSender(loadScriptSender(user?.id)); }, [user?.id]);

  React.useEffect(() => {
    let cancelled = false;
    // Moving to another company (Next / Previous) starts the page fresh.
    setCompany(null);
    setLoadError(null);
    setSelected(null);
    setBusy(null);
    setError(null);
    window.scrollTo?.({ top: 0 });
    scriptsApi
      .getCompany(companyId)
      .then((c) => { if (!cancelled) setCompany(c); })
      .catch(() => { if (!cancelled) setLoadError('Could not load this company. It may have been deleted.'); });
    return () => { cancelled = true; };
  }, [companyId]);

  const run = async (type: ScriptType, regenerate: boolean, who: ScriptSender | null = sender) => {
    setSelected(type);
    setError(null);
    // A saved script is shown straight away — no request, no cost.
    if (!regenerate && company?.scripts[type]) return;
    // A new script needs to know whose name to use: ask first.
    if (!who) {
      setAskSender({ type, regenerate });
      return;
    }

    setBusy(type);
    const res = await scriptsApi.generate(companyId, type, regenerate, who);
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

      {/* Whose name the scripts use */}
      {askSender ? (
        <Card>
          <CardContent>
            <SenderForm
              initial={sender ?? { name: user?.name ?? '', company: '' }}
              saveLabel={askSender === 'edit' ? 'Save' : 'Save and write the script'}
              onCancel={() => setAskSender(null)}
              onSave={(next) => {
                saveScriptSender(user?.id, next);
                setSender(next);
                const pending = askSender;
                setAskSender(null);
                if (pending !== 'edit') void run(pending.type, pending.regenerate, next);
              }}
            />
          </CardContent>
        </Card>
      ) : sender ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-gray-500" data-testid="sender-line">
          <UserRound className="w-4 h-4" />
          New scripts are written as <span className="font-medium text-gray-800">{sender.name}</span> from{' '}
          <span className="font-medium text-gray-800">{sender.company}</span>.
          <button type="button" className="text-blue-600 hover:underline" onClick={() => setAskSender('edit')} data-testid="sender-change">
            Change
          </button>
          <span className="text-gray-400">Saved scripts keep their old name until you click Regenerate.</span>
        </p>
      ) : null}

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

      {/* Previous / Next lead in the same file */}
      <div className="flex items-center justify-between gap-3 pt-2" data-testid="company-nav">
        <Button
          variant="outline"
          disabled={!company.previousCompanyId || busy !== null}
          onClick={() => company.previousCompanyId && navigate(`/scripts/companies/${company.previousCompanyId}`)}
          leftIcon={<ChevronLeft className="w-4 h-4" />}
          data-testid="previous-company"
        >
          Previous
        </Button>
        {company.position && company.companyCount ? (
          <span className="text-sm text-gray-500">
            Company {company.position} of {company.companyCount}
          </span>
        ) : null}
        <Button
          disabled={!company.nextCompanyId || busy !== null}
          onClick={() => company.nextCompanyId && navigate(`/scripts/companies/${company.nextCompanyId}`)}
          rightIcon={<ChevronRight className="w-4 h-4" />}
          data-testid="next-company"
        >
          {company.nextCompanyId === null ? 'Last company' : 'Next company'}
        </Button>
      </div>
    </div>
  );
}
