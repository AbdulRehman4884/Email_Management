/**
 * The agent's "which email account?" question as a box in the chat: the same account + alias
 * checklist as the campaign wizard. Several accounts take turns sending; [] aliases = all of them.
 */

import React, { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { Button } from './ui';
import { settingsApi, userApi, type SmtpSettingsResponse } from '../lib/api';
import { SMTP_DAILY_EMAIL_LIMIT_MAX } from '../lib/smtpLimits';
import type { SenderChoice } from '../lib/agentMessage';

type Profile = SmtpSettingsResponse & { id: number };

const activeAliases = (p: Profile) => (p.aliases ?? []).filter((a) => a.isActive);

/** The choice the agent gets: [] aliases when every active alias of the chosen accounts is kept (later aliases are included too). */
export function senderChoiceFrom(
  profiles: Profile[],
  smtpIds: number[],
  aliasIds: number[],
): { ok: true; choice: SenderChoice; text: string } | { ok: false; error: string } {
  const chosen = profiles.filter((p) => smtpIds.includes(p.id));
  if (chosen.length === 0) return { ok: false, error: 'Select at least one email account.' };
  const empty = chosen.find((p) => activeAliases(p).length > 1 && !activeAliases(p).some((a) => aliasIds.includes(a.id)));
  if (empty) return { ok: false, error: `Keep at least one alias of ${empty.fromEmail}, or unselect the account.` };
  const all = chosen.flatMap((p) => activeAliases(p).map((a) => a.id));
  const kept = aliasIds.filter((id) => all.includes(id));
  return {
    ok: true,
    choice: { smtpSettingIds: chosen.map((p) => p.id), aliasIds: kept.length === all.length ? [] : kept },
    text: `Send from: ${chosen.map((p) => p.fromEmail).join(', ')}`,
  };
}

export function ChatSenderForm({
  disabled,
  onSubmit,
  withAliases = true,
}: {
  disabled?: boolean;
  onSubmit: (choice: SenderChoice, text: string) => void;
  /** false: accounts only (automations send from the account itself, not its aliases). */
  withAliases?: boolean;
}) {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [quota, setQuota] = useState<Record<number, number | null>>({});
  const [smtpIds, setSmtpIds] = useState<number[]>([]);
  const [aliasIds, setAliasIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    settingsApi
      .getSmtp()
      .then((data) => {
        const list = (data.profiles && data.profiles.length > 0 ? data.profiles : data.id ? [data] : []).filter(
          (p): p is Profile => typeof p.id === 'number',
        );
        if (!alive) return;
        setProfiles(list);
        // Like the wizard: the first account and its aliases are selected.
        if (list[0]) {
          setSmtpIds([list[0].id]);
          setAliasIds(activeAliases(list[0]).map((a) => a.id));
        }
      })
      .catch(() => alive && setProfiles([]));
    userApi
      .getSmtpQuota()
      .then(({ profiles: q }) => {
        if (alive) setQuota(Object.fromEntries(q.map((p) => [p.smtpSettingsId, p.remaining])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggleAccount = (p: Profile) => {
    const on = !smtpIds.includes(p.id);
    const ids = activeAliases(p).map((a) => a.id);
    setSmtpIds((prev) => (on ? [...prev, p.id] : prev.filter((x) => x !== p.id)));
    setAliasIds((prev) => (on ? Array.from(new Set([...prev, ...ids])) : prev.filter((x) => !ids.includes(x))));
    setError(null);
  };

  const toggleAlias = (id: number) => {
    setAliasIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setError(null);
  };

  const confirm = () => {
    // Accounts only: every alias is "kept", so the answer has no alias selection.
    const r = senderChoiceFrom(profiles ?? [], smtpIds, withAliases ? aliasIds : (profiles ?? []).flatMap((p) => activeAliases(p).map((a) => a.id)));
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onSubmit(r.choice, r.text);
  };

  return (
    <div data-testid="chat-sender-form" className="mt-2 w-full rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <fieldset disabled={disabled} className="space-y-3">
        <p className="text-sm font-semibold text-gray-900">Send from (email accounts)</p>
        {profiles === null ? (
          <p className="text-sm text-gray-500">Loading your email accounts…</p>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-gray-500">No email account found. Add one in Settings, or reply with the email address.</p>
        ) : (
          <div className={`max-h-64 space-y-2 overflow-y-auto rounded-lg border bg-white p-3 ${error ? 'border-red-400' : 'border-gray-300'}`}>
            {profiles.map((p) => {
              const checked = smtpIds.includes(p.id);
              const aliases = activeAliases(p);
              const remaining = quota[p.id] ?? null;
              const keptAliases = aliases.filter((a) => aliasIds.includes(a.id)).length;
              return (
                <div key={p.id}>
                  <label className="group flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 cursor-pointer rounded accent-gray-900"
                      checked={checked}
                      onChange={() => toggleAccount(p)}
                      aria-label={p.fromEmail}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">
                        {p.fromEmail}
                        {p.fromName ? ` (${p.fromName})` : ''}
                      </p>
                      <p className="text-xs text-gray-500">
                        {withAliases && checked && aliases.length > 1 && keptAliases < aliases.length
                          ? `${keptAliases} of ${aliases.length} aliases selected`
                          : remaining !== null
                            ? `${remaining} emails remaining today · max ${SMTP_DAILY_EMAIL_LIMIT_MAX}/day per account`
                            : `Max ${SMTP_DAILY_EMAIL_LIMIT_MAX} emails/day per account`}
                      </p>
                    </div>
                  </label>
                  {withAliases && checked && aliases.length > 1 && (
                    <div className="mb-1 ml-7 mt-1.5 space-y-1 border-l border-gray-200 pl-3">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Send from aliases</p>
                      {aliases.map((a) => (
                        <label key={a.id} className="flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 cursor-pointer rounded accent-gray-900"
                            checked={aliasIds.includes(a.id)}
                            onChange={() => toggleAlias(a.id)}
                          />
                          <span className="text-xs text-gray-700">
                            {a.fromEmail}
                            {a.isPrimary ? ' (primary)' : ''}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {error && (
          <p className="text-sm text-red-500" role="alert">
            {error}
          </p>
        )}
        <p className="text-xs text-gray-500">
          Select one or more email accounts. Sends rotate across selected accounts — max {SMTP_DAILY_EMAIL_LIMIT_MAX} emails per account per day.
        </p>
        <div className="flex justify-end">
          <Button size="sm" onClick={confirm} disabled={!profiles || profiles.length === 0} data-testid="confirm-sender">
            <Send className="mr-1.5 h-4 w-4" aria-hidden />
            Confirm sender
          </Button>
        </div>
      </fieldset>
    </div>
  );
}
