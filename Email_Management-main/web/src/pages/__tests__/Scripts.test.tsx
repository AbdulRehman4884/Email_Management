/**
 * Script generation pages:
 *   A — ScriptFiles (/scripts): file list
 *   B — ScriptFileCompanies (/scripts/files/:fileId): 50 per page + pagination
 *   C — CompanyScripts (/scripts/companies/:companyId): three script buttons
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListFiles, mockListCompanies, mockGetCompany, mockGenerate, mockDeleteFile } = vi.hoisted(() => ({
  mockListFiles: vi.fn(),
  mockListCompanies: vi.fn(),
  mockGetCompany: vi.fn(),
  mockGenerate: vi.fn(),
  mockDeleteFile: vi.fn(),
}));

vi.mock('../../lib/api', () => ({
  scriptsApi: {
    listFiles: (...a: unknown[]) => mockListFiles(...a),
    listCompanies: (...a: unknown[]) => mockListCompanies(...a),
    getCompany: (...a: unknown[]) => mockGetCompany(...a),
    generate: (...a: unknown[]) => mockGenerate(...a),
    deleteFile: (...a: unknown[]) => mockDeleteFile(...a),
  },
}));

vi.mock('../../components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/ui')>()),
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import { ScriptFiles } from '../ScriptFiles';
import { ScriptFileCompanies } from '../ScriptFileCompanies';
import { CompanyScripts } from '../CompanyScripts';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/scripts" element={<ScriptFiles />} />
        <Route path="/scripts/files/:fileId" element={<ScriptFileCompanies />} />
        <Route path="/scripts/companies/:companyId" element={<CompanyScripts />} />
      </Routes>
    </MemoryRouter>,
  );
}

function companiesPage(page: number, total = 120) {
  const limit = 50;
  const count = Math.min(limit, total - (page - 1) * limit);
  return {
    file: { id: 7, filename: 'leads.xlsx', companyCount: total, report: {}, createdAt: '2026-10-01 10:00:00' },
    items: Array.from({ length: count }, (_, i) => {
      const n = (page - 1) * limit + i;
      return { id: 1000 + n, rowNumber: n + 2, companyName: `Company ${n}`, website: `https://c${n}.com`, scriptTypes: n === 0 ? ['linkedin'] : [] };
    }),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

const SCRIPT = (type: string, extra: Record<string, unknown> = {}) => ({
  type, status: 'ok', whatTheySell: 'Dental care', problemStatement: 'Booking is phone-only.',
  painPoints: ['Phone-only booking'], recommendedServices: ['GHL (GoHighLevel)'], subject: null,
  script: `The ${type} script.`, wordCount: 50, updatedAt: '', ...extra,
});

const COMPANY = {
  id: 1000, fileId: 7, filename: 'leads.xlsx', rowNumber: 2, companyName: 'Bright Smile',
  website: 'https://brightsmile.example', extraFields: { City: 'Austin' }, scripts: {},
};

beforeEach(() => vi.clearAllMocks());

// ── A ──────────────────────────────────────────────────────────────────────────

describe('A — ScriptFiles', () => {
  it('lists files with a link to each company list', async () => {
    mockListFiles.mockResolvedValue([{ id: 7, filename: 'leads.xlsx', companyCount: 120, totalRows: 125, createdAt: '2026-10-01 10:00:00', scriptCount: 4 }]);

    renderAt('/scripts');

    const link = await screen.findByRole('link', { name: /leads\.xlsx/ });
    expect(link).toHaveAttribute('href', '/scripts/files/7');
    expect(screen.getByText('120')).toBeInTheDocument();
  });

  it('shows an empty state pointing to the AI agent', async () => {
    mockListFiles.mockResolvedValue([]);
    renderAt('/scripts');
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
  });
});

// ── B ──────────────────────────────────────────────────────────────────────────

describe('B — ScriptFileCompanies', () => {
  it('shows 50 companies per page and pages forward', async () => {
    const u = userEvent.setup();
    mockListCompanies.mockImplementation(async (_id: number, page: number) => companiesPage(page));

    renderAt('/scripts/files/7');

    await waitFor(() => expect(screen.getAllByTestId('script-company-row')).toHaveLength(50));
    expect(mockListCompanies).toHaveBeenCalledWith(7, 1, 50);
    expect(screen.getByTestId('companies-range')).toHaveTextContent('1–50 of 120');
    expect(screen.getByRole('link', { name: 'Company 0' })).toHaveAttribute('href', '/scripts/companies/1000');

    await u.click(screen.getByTestId('next-page'));
    await waitFor(() => expect(mockListCompanies).toHaveBeenLastCalledWith(7, 2, 50));
    await waitFor(() => expect(screen.getByTestId('companies-range')).toHaveTextContent('51–100 of 120'));

    await u.click(screen.getByTestId('next-page'));
    await waitFor(() => expect(screen.getAllByTestId('script-company-row')).toHaveLength(20));
    expect(screen.getByTestId('next-page')).toBeDisabled();
  });
});

// ── C ──────────────────────────────────────────────────────────────────────────

describe('C — CompanyScripts', () => {
  it('shows the three script buttons', async () => {
    mockGetCompany.mockResolvedValue(COMPANY);
    renderAt('/scripts/companies/1000');

    expect(await screen.findByTestId('generate-cold_email')).toHaveTextContent('Cold email script');
    expect(screen.getByTestId('generate-cold_call')).toHaveTextContent('Cold call script');
    expect(screen.getByTestId('generate-linkedin')).toHaveTextContent('LinkedIn script');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('generates a script on click and shows it (email with subject)', async () => {
    const u = userEvent.setup();
    mockGetCompany.mockResolvedValue(COMPANY);
    mockGenerate.mockResolvedValue({ success: true, data: { script: SCRIPT('cold_email', { subject: 'Booking after hours' }), cached: false } });

    renderAt('/scripts/companies/1000');
    await u.click(await screen.findByTestId('generate-cold_email'));

    expect(mockGenerate).toHaveBeenCalledWith(1000, 'cold_email', false);
    expect(await screen.findByTestId('script-text')).toHaveTextContent('The cold_email script.');
    expect(screen.getByTestId('script-subject')).toHaveTextContent('Booking after hours');
  });

  it('labels an industry-based script so the user knows it was not seen on the website', async () => {
    const u = userEvent.setup();
    mockGetCompany.mockResolvedValue({ ...COMPANY, scripts: { cold_call: SCRIPT('cold_call', { angle: 'industry' }) } });

    renderAt('/scripts/companies/1000');
    await u.click(await screen.findByTestId('generate-cold_call'));

    expect(await screen.findByTestId('angle-badge')).toHaveTextContent('Industry-based angle');
  });

  it('shows a saved script without calling the generator', async () => {
    const u = userEvent.setup();
    mockGetCompany.mockResolvedValue({ ...COMPANY, scripts: { linkedin: SCRIPT('linkedin') } });

    renderAt('/scripts/companies/1000');
    await u.click(await screen.findByTestId('generate-linkedin'));

    expect(await screen.findByTestId('script-text')).toHaveTextContent('The linkedin script.');
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('regenerate asks for a new script', async () => {
    const u = userEvent.setup();
    mockGetCompany.mockResolvedValue({ ...COMPANY, scripts: { cold_call: SCRIPT('cold_call') } });
    mockGenerate.mockResolvedValue({ success: true, data: { script: SCRIPT('cold_call', { script: 'A new call script.' }), cached: false } });

    renderAt('/scripts/companies/1000');
    await u.click(await screen.findByTestId('generate-cold_call'));
    await u.click(await screen.findByTestId('regenerate-script'));

    expect(mockGenerate).toHaveBeenCalledWith(1000, 'cold_call', true);
    await waitFor(() => expect(screen.getByTestId('script-text')).toHaveTextContent('A new call script.'));
  });

  it('shows the error when generation fails', async () => {
    const u = userEvent.setup();
    mockGetCompany.mockResolvedValue(COMPANY);
    mockGenerate.mockResolvedValue({ success: false, error: 'Company not found.' });

    renderAt('/scripts/companies/1000');
    await u.click(await screen.findByTestId('generate-linkedin'));

    expect(await screen.findByText('Company not found.')).toBeInTheDocument();
  });
});
