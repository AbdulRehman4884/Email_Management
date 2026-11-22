import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ScriptFileSavedCard } from '../ScriptFileSavedCard';

describe('ScriptFileSavedCard — QA P4 bug 29', () => {
  const base = { kind: 'script_file' as const, fileId: 7, filename: 'dups.csv', totalRows: 6, reportLine: '6 rows: 1 valid, 5 skipped.' };

  it('"1 company is ready" (not "1 companies are") and the rows that were not saved', () => {
    render(
      <MemoryRouter>
        <ScriptFileSavedCard data={{ ...base, companyCount: 1, skippedRows: ['Row 3 — QA Dup Co: duplicate', 'Row 5 — QA Bad Site Co: invalid website'] }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('script-file-saved-card')).toHaveTextContent('1 company is ready');
    expect(screen.getByTestId('script-file-skipped')).toHaveTextContent('Row 5 — QA Bad Site Co: invalid website');
  });

  it('several companies, nothing skipped → no "Not saved" list', () => {
    render(
      <MemoryRouter>
        <ScriptFileSavedCard data={{ ...base, companyCount: 6, skippedRows: [] }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('script-file-saved-card')).toHaveTextContent('6 companies are ready');
    expect(screen.queryByTestId('script-file-skipped')).not.toBeInTheDocument();
  });
});
