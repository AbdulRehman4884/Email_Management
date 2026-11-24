import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { Button, Input, Alert } from './ui';
import { settingsApi, type SmtpAliasResponse } from '../lib/api';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../lib/smtpLimits';

const EMAIL_REGEX = /^(?!.*\.\.)[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'yandex.com', 'gmx.com',
]);
const domainOf = (e: string) => e.slice(e.lastIndexOf('@') + 1).toLowerCase();

/** Same rule as the server: an alias is the login itself or a same-company-domain address (not public mail). */
function aliasAllowed(login: string, fromEmail: string): boolean {
  if (login.toLowerCase() === fromEmail.toLowerCase()) return true;
  const d = domainOf(login);
  return d === domainOf(fromEmail) && !PUBLIC_MAIL_DOMAINS.has(d);
}

/** Display the stored cap: null/undefined means the default 20. */
function capLabel(n: number | null | undefined): number {
  if (n === null || n === undefined) return SMTP_DAILY_EMAIL_LIMIT_MAX;
  return Math.min(SMTP_DAILY_EMAIL_LIMIT_MAX, Math.max(0, Math.floor(Number(n))));
}

interface Props {
  profileId: number;
  /** The profile's SMTP username/login, used to validate alias domains before saving. */
  login: string;
  /** Called after any alias change so the parent can refresh its profile list. */
  onChanged?: () => void;
}

export function SmtpAliasesManager({ profileId, login, onChanged }: Props) {
  const [aliases, setAliases] = useState<SmtpAliasResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // New-alias form
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newLimit, setNewLimit] = useState<number | ''>(SMTP_DAILY_EMAIL_LIMIT_MAX);
  const [newError, setNewError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Bulk add (paste a list)
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkLimit, setBulkLimit] = useState<number | ''>(SMTP_DAILY_EMAIL_LIMIT_MAX);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ added: number; skipped: { email: string; reason: string }[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { aliases: list } = await settingsApi.listAliases(profileId);
      setAliases(list);
    } catch {
      setError('Could not load aliases for this account.');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCapacity = aliases.filter((a) => a.isActive).reduce((s, a) => s + capLabel(a.dailyEmailLimit), 0);

  async function handleAdd() {
    const email = newEmail.trim();
    if (!email) return setNewError('From email is required.');
    if (!EMAIL_REGEX.test(email)) return setNewError('Enter a valid email address.');
    if (!aliasAllowed(login, email)) {
      return setNewError(`Alias must be on the same company domain as ${login} (public mailboxes like Gmail are not allowed).`);
    }
    setAdding(true);
    setNewError(null);
    try {
      await settingsApi.postAlias(profileId, {
        fromEmail: email,
        fromName: newName.trim() || undefined,
        dailyEmailLimit: newLimit === '' ? null : Number(newLimit),
      });
      setNewEmail('');
      setNewName('');
      setNewLimit(SMTP_DAILY_EMAIL_LIMIT_MAX);
      await load();
      onChanged?.();
    } catch (e) {
      const msg = (e as { response?: { data?: { fieldErrors?: { fromEmail?: string }; error?: string } } })?.response?.data;
      setNewError(msg?.fieldErrors?.fromEmail || msg?.error || 'Could not add this alias.');
    } finally {
      setAdding(false);
    }
  }

  async function handleBulkAdd() {
    // Split on newlines, commas, semicolons or spaces; trim; drop blanks; de-dupe (case-insensitive).
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const raw of bulkText.split(/[\s,;]+/)) {
      const e = raw.trim();
      if (!e) continue;
      const key = e.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      emails.push(e);
    }
    if (emails.length === 0) { setBulkResult({ added: 0, skipped: [] }); return; }

    const existing = new Set(aliases.map((a) => a.fromEmail.toLowerCase()));
    const limit = bulkLimit === '' ? null : Number(bulkLimit);
    const skipped: { email: string; reason: string }[] = [];
    let added = 0;

    setBulkBusy(true);
    setBulkResult(null);
    for (const email of emails) {
      if (existing.has(email.toLowerCase())) { skipped.push({ email, reason: 'already added' }); continue; }
      if (!EMAIL_REGEX.test(email)) { skipped.push({ email, reason: 'invalid email' }); continue; }
      if (!aliasAllowed(login, email)) { skipped.push({ email, reason: 'wrong domain' }); continue; }
      try {
        await settingsApi.postAlias(profileId, { fromEmail: email, dailyEmailLimit: limit });
        existing.add(email.toLowerCase());
        added += 1;
      } catch (e) {
        const msg = (e as { response?: { data?: { fieldErrors?: { fromEmail?: string }; error?: string } } })?.response?.data;
        skipped.push({ email, reason: msg?.fieldErrors?.fromEmail || msg?.error || 'could not add' });
      }
    }
    setBulkBusy(false);
    setBulkResult({ added, skipped });
    if (added > 0) {
      setBulkText('');
      await load();
      onChanged?.();
    }
  }

  async function handleLimitChange(alias: SmtpAliasResponse, raw: string) {
    const value = raw.trim();
    const parsed = value === '' ? null : Math.max(0, Math.min(SMTP_DAILY_EMAIL_LIMIT_MAX, Math.floor(Number(value))));
    if (value !== '' && !Number.isFinite(Number(value))) return;
    setBusyId(alias.id);
    try {
      await settingsApi.putAlias(profileId, alias.id, { dailyEmailLimit: parsed });
      await load();
      onChanged?.();
    } catch {
      setError('Could not update the alias limit.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleActive(alias: SmtpAliasResponse) {
    setBusyId(alias.id);
    try {
      await settingsApi.putAlias(profileId, alias.id, { isActive: !alias.isActive });
      await load();
      onChanged?.();
    } catch {
      setError('Could not update the alias.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(alias: SmtpAliasResponse) {
    setBusyId(alias.id);
    try {
      await settingsApi.deleteAlias(profileId, alias.id);
      await load();
      onChanged?.();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Could not delete this alias.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-5">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Sending aliases</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Each alias sends up to {SMTP_DAILY_EMAIL_LIMIT_MAX} emails per day on its own.
            This account can send <span className="font-medium text-gray-700">{totalCapacity}</span> emails/day in total
            {aliases.length > 0 ? ` across ${aliases.length} ${aliases.length === 1 ? 'alias' : 'aliases'}.` : '.'}
          </p>
        </div>
      </div>

      {error && <div className="my-3"><Alert type="error" message={error} /></div>}

      {loading ? (
        <div className="flex items-center gap-2 text-gray-500 py-4 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading aliases…
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
          {aliases.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 bg-white">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-gray-900">{a.fromEmail}</span>
                  {a.isPrimary && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 uppercase tracking-wide">
                      Primary
                    </span>
                  )}
                  {!a.isActive && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 uppercase tracking-wide">
                      Off
                    </span>
                  )}
                </div>
                {a.fromName && <p className="text-xs text-gray-500 truncate">{a.fromName}</p>}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <span>Daily</span>
                <input
                  type="number"
                  min={0}
                  max={SMTP_DAILY_EMAIL_LIMIT_MAX}
                  defaultValue={capLabel(a.dailyEmailLimit)}
                  disabled={busyId === a.id}
                  onBlur={(e) => {
                    if (Number(e.target.value) !== capLabel(a.dailyEmailLimit)) void handleLimitChange(a, e.target.value);
                  }}
                  className="w-16 px-2 py-1 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-60"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleToggleActive(a)}
                disabled={busyId === a.id}
                className="text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-60"
              >
                {a.isActive ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(a)}
                disabled={a.isPrimary || busyId === a.id}
                title={a.isPrimary ? "The primary alias can't be removed; it's the account's own From." : 'Delete alias'}
                className="text-gray-400 hover:text-red-600 disabled:opacity-40 disabled:hover:text-gray-400"
              >
                {busyId === a.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </li>
          ))}
          {aliases.length === 0 && (
            <li className="px-3 py-3 text-sm text-gray-500 bg-white">No aliases yet.</li>
          )}
        </ul>
      )}

      {/* Add a new alias */}
      <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-3 bg-gray-50/60">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-700">{bulkOpen ? 'Add many aliases' : 'Add an alias'}</p>
          <button
            type="button"
            onClick={() => { setBulkOpen((v) => !v); setBulkResult(null); setNewError(null); }}
            className="text-xs font-medium text-gray-600 hover:text-gray-900"
          >
            {bulkOpen ? 'Add one at a time' : 'Add a list'}
          </button>
        </div>

        {bulkOpen ? (
          <div>
            <p className="text-xs text-gray-500 mb-2">
              Paste one email per line (commas or spaces also work). Each must be on {login ? `${domainOf(login)}'s domain` : "the account's domain"}.
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => { setBulkText(e.target.value); setBulkResult(null); }}
              rows={5}
              placeholder={`sales@${domainOf(login) || 'yourcompany.com'}\nsupport@${domainOf(login) || 'yourcompany.com'}\ninfo@${domainOf(login) || 'yourcompany.com'}`}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 font-mono"
            />
            <div className="flex items-center gap-3 mt-2">
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <span>Daily each</span>
                <input
                  type="number"
                  min={0}
                  max={SMTP_DAILY_EMAIL_LIMIT_MAX}
                  value={bulkLimit}
                  onChange={(e) => setBulkLimit(e.target.value === '' ? '' : Math.max(0, Math.min(SMTP_DAILY_EMAIL_LIMIT_MAX, Math.floor(Number(e.target.value)))))}
                  className="w-16 px-2 py-1.5 border border-gray-300 rounded text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
              </label>
              <Button type="button" size="sm" onClick={() => void handleBulkAdd()} isLoading={bulkBusy} leftIcon={<Plus className="w-4 h-4" />}>
                Add all
              </Button>
            </div>
            {bulkResult && (
              <div className="mt-2 text-xs">
                {bulkResult.added > 0 && (
                  <p className="text-green-700 font-medium">Added {bulkResult.added} alias{bulkResult.added === 1 ? '' : 'es'}.</p>
                )}
                {bulkResult.skipped.length > 0 && (
                  <div className="text-gray-600 mt-1">
                    <p className="font-medium text-amber-700">Skipped {bulkResult.skipped.length}:</p>
                    <ul className="list-disc list-inside">
                      {bulkResult.skipped.slice(0, 8).map((s) => (
                        <li key={s.email}><span className="font-mono">{s.email}</span> — {s.reason}</li>
                      ))}
                      {bulkResult.skipped.length > 8 && <li>…and {bulkResult.skipped.length - 8} more</li>}
                    </ul>
                  </div>
                )}
                {bulkResult.added === 0 && bulkResult.skipped.length === 0 && <p className="text-gray-500">Nothing to add.</p>}
              </div>
            )}
          </div>
        ) : (
        <>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <Input
            label="From email"
            name="aliasFromEmail"
            value={newEmail}
            onChange={(e) => { setNewEmail(e.target.value); setNewError(null); }}
            placeholder={`sales@${domainOf(login) || 'yourcompany.com'}`}
          />
          <Input
            label="Sender name (optional)"
            name="aliasFromName"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Sales Team"
          />
          <div className="flex items-end gap-2">
            <label className="block">
              <span className="block text-sm font-medium text-gray-700 mb-1.5">Daily</span>
              <input
                type="number"
                min={0}
                max={SMTP_DAILY_EMAIL_LIMIT_MAX}
                value={newLimit}
                onChange={(e) => setNewLimit(e.target.value === '' ? '' : Math.max(0, Math.min(SMTP_DAILY_EMAIL_LIMIT_MAX, Math.floor(Number(e.target.value)))))}
                className="w-20 px-2 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
            </label>
            <Button type="button" size="sm" onClick={() => void handleAdd()} isLoading={adding} leftIcon={<Plus className="w-4 h-4" />}>
              Add
            </Button>
          </div>
        </div>
        {newError && <p className="text-xs text-red-600 mt-2">{newError}</p>}
        </>
        )}
      </div>
    </div>
  );
}
