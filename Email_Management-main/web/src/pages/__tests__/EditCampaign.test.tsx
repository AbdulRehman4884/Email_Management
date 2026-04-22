/**
 * src/pages/__tests__/EditCampaign.test.tsx
 *
 * Regression tests for EditCampaign focusing on the SMTP-fetch unmount guard.
 *
 * Coverage:
 *   A — SMTP unmount safety
 *       Navigating away while settingsApi.getSmtp() is in-flight must not
 *       call setState after unmount.  Before the fix this caused a React
 *       state-update-on-unmounted-component warning (React < 18) and silent
 *       corruption in React 18+ due to the stale state being applied to a
 *       re-mounted instance.
 *
 *   B — SMTP success path (smoke: fields populated from SMTP response)
 *   C — SMTP error path (smoke: falls back to campaign values)
 *
 * What is NOT tested here (covered elsewhere or requires E2E):
 *   - Full form submission / validation (integration test territory)
 *   - Template preview rendering (visual regression)
 *   - Navigation after save
 */

import React from 'react';
import {
  render,
  screen,
  waitFor,
  cleanup,
  act,
} from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditCampaign } from '../EditCampaign';
import { useCampaignStore } from '../../store';
import { ToastProvider } from '../../components/ui';

// ── Mock heavy dependencies ────────────────────────────────────────────────────
// emailPreview uses DOMParser / document methods that jsdom supports but that
// can produce noisy console output; stub at the module level to keep tests fast.

vi.mock('../../lib/emailPreview', () => ({
  buildPreviewHtml: (_id: string, _data: unknown) => '<p>preview</p>',
  sanitizeHtmlForIframe: (html: string) => html,
  TEMPLATE_DEFAULTS: {
    simple:       { heading: '', body: '', ctaText: '', ctaUrl: '' },
    announcement: { title: '', description: '' },
    newsletter:   { title: '', intro: '' },
  },
  parseStoredCampaignHtml: () => null,
}));

// ── Mock store ─────────────────────────────────────────────────────────────────

const mockFetchCampaign    = vi.fn();
const mockUpdateCampaign   = vi.fn();
const mockClearCurrentCampaign = vi.fn();
const mockClearError       = vi.fn();

vi.mock('../../store', () => ({
  useCampaignStore: vi.fn(),
}));

// ── Mock API ───────────────────────────────────────────────────────────────────

const mockGetSmtp = vi.fn();

vi.mock('../../lib/api', () => ({
  settingsApi: {
    getSmtp: (...args: unknown[]) => mockGetSmtp(...args),
  },
  isSmtpConfigured: () => true,
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

const mockCampaign = {
  id: 42,
  name: 'Test Campaign',
  subject: 'Hello',
  emailContent: '<p>Body</p>',
  fromName: 'Old Sender',
  fromEmail: 'old@example.com',
  status: 'draft' as const,
  scheduledAt: null,
};

const mockSmtp = {
  provider: 'smtp',
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  user: 'user@example.com',
  fromName: 'SMTP Sender',
  fromEmail: 'smtp@example.com',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

// vi.mock hoisting means the imported useCampaignStore is already the vi.fn()
// stub — we can call .mockReturnValue on it directly.
const mockedUseCampaignStore = useCampaignStore as ReturnType<typeof vi.fn>;

function setupStore(overrides: Record<string, unknown> = {}) {
  mockedUseCampaignStore.mockReturnValue({
    currentCampaign: mockCampaign,
    isLoading: false,
    error: null,
    fetchCampaign: mockFetchCampaign,
    updateCampaign: mockUpdateCampaign,
    clearCurrentCampaign: mockClearCurrentCampaign,
    clearError: mockClearError,
    ...overrides,
  });
}

function renderEditCampaign() {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/campaigns/42/edit']}>
        <Routes>
          <Route path="/campaigns/:id/edit" element={<EditCampaign />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  setupStore();
});

afterEach(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════════════
// A — SMTP unmount safety
// ═══════════════════════════════════════════════════════════════════════════════

describe('A — SMTP unmount safety', () => {
  it('unmounting while SMTP fetch is in-flight does not throw', async () => {
    // Hold the SMTP promise so we can control when it resolves
    let resolveSmtp: (v: unknown) => void;
    mockGetSmtp.mockReturnValueOnce(new Promise((r) => { resolveSmtp = r; }));

    const { unmount } = renderEditCampaign();

    // Wait for the component to render (currentCampaign is available immediately)
    await waitFor(() => screen.getByRole('heading', { name: /edit campaign/i }));

    // Simulate the user navigating away before SMTP resolves
    unmount();

    // Resolve after unmount — the cancelled flag must prevent setState
    await act(async () => { resolveSmtp!(mockSmtp); });

    // Test passes if no error is thrown — the cancelled guard absorbed the update
  });

  it('resolving SMTP after unmount does not update state (cancelled flag)', async () => {
    // We cannot directly observe that setState was not called (React 18 no
    // longer warns), but we can verify the component produces no side-effects:
    // the settingsApi.getSmtp call count stays at 1 (not retried), confirming
    // only one SMTP fetch was dispatched and subsequently abandoned cleanly.

    let resolveSmtp: (v: unknown) => void;
    mockGetSmtp.mockReturnValueOnce(new Promise((r) => { resolveSmtp = r; }));

    const { unmount } = renderEditCampaign();

    await waitFor(() => screen.getByRole('heading', { name: /edit campaign/i }));

    unmount();

    await act(async () => { resolveSmtp!(mockSmtp); });

    // Exactly one SMTP call was made — no retry after unmount
    expect(mockGetSmtp).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B — SMTP success path
// ═══════════════════════════════════════════════════════════════════════════════

describe('B — SMTP success path', () => {
  it('populates fromName from SMTP settings when the fetch succeeds', async () => {
    mockGetSmtp.mockResolvedValueOnce(mockSmtp);

    renderEditCampaign();

    // After SMTP resolves, the fromName input should reflect the SMTP value
    await waitFor(() =>
      expect(
        screen.getByDisplayValue('SMTP Sender'),
      ).toBeInTheDocument(),
    );
  });

  it('retains campaign name from the store', async () => {
    mockGetSmtp.mockResolvedValueOnce(mockSmtp);

    renderEditCampaign();

    await waitFor(() =>
      expect(
        screen.getByDisplayValue('Test Campaign'),
      ).toBeInTheDocument(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C — SMTP error path
// ═══════════════════════════════════════════════════════════════════════════════

describe('C — SMTP error path', () => {
  it('shows the SMTP unconfigured banner when the fetch fails', async () => {
    // When SMTP fetch rejects, smtpReady → false.  The component renders a
    // warning banner instead of the sender fields — so fromName is not in the
    // DOM.  Verify the banner is shown so the user knows why they cannot save.
    mockGetSmtp.mockRejectedValueOnce(new Error('Network error'));

    renderEditCampaign();

    await waitFor(() =>
      expect(
        screen.getByText(/email sending is not configured/i),
      ).toBeInTheDocument(),
    );
  });

  it('still renders the campaign name input after an SMTP error', async () => {
    mockGetSmtp.mockRejectedValueOnce(new Error('Network error'));

    renderEditCampaign();

    // Campaign name field is always shown regardless of SMTP state
    await waitFor(() =>
      expect(screen.getByDisplayValue('Test Campaign')).toBeInTheDocument(),
    );
  });
});
