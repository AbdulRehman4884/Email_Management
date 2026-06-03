import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BulkTemplateReview } from '../BulkTemplateReview';

vi.mock('../../lib/api', () => ({
  bulkApi: {
    getTemplates: vi.fn().mockResolvedValue({
      jobId: 12,
      page: 1,
      limit: 10,
      total: 1,
      templates: [{
        id: 1,
        rowId: 10,
        subject: 'Systems Ltd and campaign readiness',
        body: 'Hi Sara,\n\nFull executive email body.',
        followup1: 'Follow-up one body',
        followup2: 'Follow-up two body',
        cta: 'Would a concise preview be useful?',
        rationale: 'Signals used: enterprise delivery complexity.',
        confidence: 0.82,
        persona: 'VP Operations',
        status: 'pending_review',
        company: 'Systems Ltd',
        website: 'https://www.systemsltd.com',
        email: 'sara@example.com',
        name: 'Sara',
        role: 'COO',
        industry: 'enterprise IT services',
      }],
    }),
    updateTemplate: vi.fn().mockResolvedValue({ message: 'ok' }),
  },
}));

describe('BulkTemplateReview', () => {
  it('renders full-width copy-ready template fields without truncation helpers', async () => {
    render(
      <MemoryRouter initialEntries={['/bulk/12/templates']}>
        <Routes>
          <Route path="/bulk/:jobId/templates" element={<BulkTemplateReview />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Systems Ltd')).toBeInTheDocument());
    expect(screen.getByDisplayValue('Systems Ltd and campaign readiness')).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Full executive email body/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Follow-up one body/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Follow-up two body/)).toBeInTheDocument();
    expect(screen.queryByText('...')).not.toBeInTheDocument();
  });
});
