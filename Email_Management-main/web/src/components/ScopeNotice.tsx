import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { settingsApi } from '../lib/api';
import { useReportingScope } from '../lib/reportingScope';

/**
 * F-45: one wording on every scoped page that names the selected SMTP account,
 * e.g. "Showing data for ja5523517@gmail.com · Change". Renders nothing when no account is selected.
 */
export function ScopeNotice({ className = '' }: { className?: string }) {
  const { scopeSmtpProfileId } = useReportingScope();
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (scopeSmtpProfileId == null) return;
    let alive = true;
    settingsApi
      .listSmtpProfiles()
      .then(({ profiles }) => {
        const p = profiles.find((x) => x.id === scopeSmtpProfileId);
        if (alive) setLabel(p ? p.fromEmail || p.user || `account #${scopeSmtpProfileId}` : `account #${scopeSmtpProfileId}`);
      })
      .catch(() => {
        if (alive) setLabel(`account #${scopeSmtpProfileId}`);
      });
    return () => {
      alive = false;
    };
  }, [scopeSmtpProfileId]);

  if (scopeSmtpProfileId == null) return null;
  return (
    <p className={`text-xs text-gray-600 ${className}`}>
      Showing data for <span className="font-medium text-gray-900">{label ?? '…'}</span>
      <span className="text-gray-400"> · </span>
      <Link to="/settings" className="underline hover:text-gray-900">
        Change
      </Link>
    </p>
  );
}
