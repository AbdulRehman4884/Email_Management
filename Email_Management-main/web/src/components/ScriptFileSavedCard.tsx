/**
 * src/components/ScriptFileSavedCard.tsx
 *
 * Chat card shown after a company file is saved for script generation,
 * with a link to the file's company list.
 */

import { Link } from 'react-router-dom';
import { ArrowRight, FileSpreadsheet } from 'lucide-react';
import type { ScriptFileData } from '../lib/agentMessage';

export function ScriptFileSavedCard({ data }: { data: ScriptFileData; message?: string }) {
  return (
    <div
      data-testid="script-file-saved-card"
      style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '0.625rem', padding: '0.875rem 1rem', width: '100%' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
        <FileSpreadsheet style={{ width: '0.875rem', height: '0.875rem', color: '#16a34a' }} />
        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#111827' }}>
          Saved for script generation · {data.filename}
        </span>
      </div>
      <p style={{ fontSize: '0.78rem', color: '#374151', margin: '0 0 0.6rem' }}>
        {data.reportLine} {data.companyCount.toLocaleString()} companies are ready — open the file, pick a
        company, and generate its cold email, cold call or LinkedIn script.
      </p>
      <Link
        to={`/scripts/files/${data.fileId}`}
        data-testid="open-script-file-link"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.75rem', fontWeight: 600,
          color: '#fff', background: '#111827', borderRadius: '0.375rem', padding: '0.35rem 0.75rem', textDecoration: 'none',
        }}
      >
        Open companies <ArrowRight style={{ width: '0.75rem', height: '0.75rem' }} />
      </Link>
    </div>
  );
}
