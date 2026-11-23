import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import type { AiReplyDraft, FirstLineLead } from '../../lib/aiFeaturesApi';

const aiReplyApi = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  threadDraft: vi.fn(),
  writeDraft: vi.fn(),
  discard: vi.fn(),
  markUsed: vi.fn(),
}));
const firstLinesApi = vi.hoisted(() => ({ get: vi.fn(), start: vi.fn(), save: vi.fn() }));
vi.mock('../../lib/aiFeaturesApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/aiFeaturesApi')>()),
  aiReplyApi,
  firstLinesApi,
}));

import { AiDraftPanel } from '../AiDraftPanel';
import { FirstLinesCard } from '../FirstLinesCard';
import { AiReplySettings } from '../AiReplySettings';
import { withoutSignOff } from '../../lib/aiFeaturesApi';

const draft = (over: Partial<AiReplyDraft> = {}): AiReplyDraft => ({
  id: 7, replyId: 3, threadRootId: 3, campaignId: 1, recipientId: 2, label: 'interested', objection: 'price',
  body: 'Hi Ali,\n\nHappy to help.\n\nBest regards,\nSara', status: 'pending', sendAfter: null, sentAt: null, note: null,
  createdAt: '2026-11-22T10:00:00.000Z', ...over,
});

const wrap = (ui: React.ReactElement) => render(<ToastProvider>{ui}</ToastProvider>);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AiDraftPanel (Inbox)', () => {
  it('no draft: offers "Write with AI" and shows the new draft', async () => {
    aiReplyApi.threadDraft.mockResolvedValue(null);
    aiReplyApi.writeDraft.mockResolvedValue(draft());
    wrap(<AiDraftPanel threadRootId={3} hasSignature={false} onUse={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /write with ai/i }));
    expect(aiReplyApi.writeDraft).toHaveBeenCalledWith(3, false);
    expect(await screen.findByTestId('ai-draft-body')).toHaveTextContent('Happy to help.');
    expect(screen.getByText(/price worry/)).toBeInTheDocument();
  });

  it('"Use draft" fills the reply box (sign-off dropped when a signature is added) and marks it used', async () => {
    aiReplyApi.threadDraft.mockResolvedValue(draft());
    aiReplyApi.markUsed.mockResolvedValue(draft({ status: 'used' }));
    const onUse = vi.fn();
    wrap(<AiDraftPanel threadRootId={3} hasSignature onUse={onUse} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use draft' }));
    expect(aiReplyApi.markUsed).toHaveBeenCalledWith(7);
    expect(onUse).toHaveBeenCalledWith('Hi Ali,\n\nHappy to help.');
    expect(screen.queryByTestId('ai-draft-body')).not.toBeInTheDocument();
  });

  it('a scheduled auto reply shows when it goes out and can be cancelled', async () => {
    aiReplyApi.threadDraft.mockResolvedValue(draft({ status: 'scheduled', sendAfter: '2026-11-22T10:05:00.000Z' }));
    aiReplyApi.discard.mockResolvedValue(draft({ status: 'discarded' }));
    wrap(<AiDraftPanel threadRootId={3} hasSignature={false} onUse={vi.fn()} />);
    expect(await screen.findByTestId('ai-draft-scheduled')).toHaveTextContent('Sends by itself');
    await userEvent.click(screen.getByRole('button', { name: /cancel auto send/i }));
    expect(aiReplyApi.discard).toHaveBeenCalledWith(7);
    await waitFor(() => expect(screen.queryByTestId('ai-draft-body')).not.toBeInTheDocument());
  });

  it('server error is shown; an old server (no AI route) leaves the Inbox as before', async () => {
    aiReplyApi.threadDraft.mockRejectedValue(new Error('404'));
    aiReplyApi.writeDraft.mockRejectedValue({ response: { data: { error: 'AI is not set up on this server.' } } });
    wrap(<AiDraftPanel threadRootId={3} hasSignature={false} onUse={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /write with ai/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AI is not set up on this server.');
  });

  it('sign-off removal keeps the body', () => {
    expect(withoutSignOff('Hi,\n\nText.\n\nBest regards,\nSara')).toBe('Hi,\n\nText.');
    expect(withoutSignOff('Hi,\n\nText.')).toBe('Hi,\n\nText.');
  });
});

const lead = (over: Partial<FirstLineLead> = {}): FirstLineLead => ({
  recipientId: 1, email: 'ali@acme.io', name: 'Ali', status: 'pending', firstLine: '', source: null, ...over,
});

describe('FirstLinesCard (campaign)', () => {
  it('asks to add {first_line} when the email does not use it, and starts a run', async () => {
    firstLinesApi.get.mockResolvedValue({ leads: [lead()], usesPlaceholder: false, run: null });
    firstLinesApi.start.mockResolvedValue({ status: 'done', total: 1, done: 1, fromWebsite: 1, fallback: 0, empty: 0, failed: 0, startedAt: '', finishedAt: '', error: null });
    wrap(<FirstLinesCard campaignId={5} campaignStatus="draft" />);
    expect(await screen.findByTestId('first-lines-placeholder-hint')).toHaveTextContent('{first_line}');
    await userEvent.click(screen.getByRole('button', { name: /write first lines/i }));
    expect(firstLinesApi.start).toHaveBeenCalledWith(5, false);
    expect(await screen.findByTestId('first-lines-summary')).toHaveTextContent('1 from the website');
  });

  it('a line can be edited; emailed leads are read-only', async () => {
    firstLinesApi.get.mockResolvedValue({
      leads: [lead({ firstLine: 'Old line.', source: 'website' }), lead({ recipientId: 2, email: 'b@x.io', status: 'sent', firstLine: 'Sent line.' })],
      usesPlaceholder: true,
      run: null,
    });
    firstLinesApi.save.mockResolvedValue(lead({ firstLine: 'New line.', source: 'manual' }));
    const onChanged = vi.fn();
    wrap(<FirstLinesCard campaignId={5} campaignStatus="draft" onChanged={onChanged} />);
    const input = await screen.findByLabelText('First line for ali@acme.io');
    await userEvent.clear(input);
    await userEvent.type(input, 'New line.{Enter}');
    expect(firstLinesApi.save).toHaveBeenCalledWith(5, 1, 'New line.');
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByLabelText('First line for b@x.io')).not.toBeInTheDocument();
    expect(screen.getByText('Sent line.')).toBeInTheDocument();
  });
});

describe('AiReplySettings (Settings)', () => {
  it('loads (off by default), needs an offer before turning on, saves', async () => {
    const settings = { mode: 'off', labels: ['interested', 'question', 'neutral'], delayMinutes: 3, maxPerThread: 3, dailyLimit: 50, offer: '', meetingLink: '' };
    aiReplyApi.getSettings.mockResolvedValue({ settings, aiConfigured: true });
    aiReplyApi.saveSettings.mockImplementation(async (s) => ({ settings: s, aiConfigured: true }));
    wrap(<AiReplySettings />);
    const off = await screen.findByRole('radio', { name: /^off/i });
    expect(off).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: /approve first/i }));
    await userEvent.click(screen.getByRole('button', { name: /save ai reply settings/i }));
    expect(aiReplyApi.saveSettings).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('What you offer'), 'Websites for dentists');
    await userEvent.click(screen.getByRole('button', { name: /save ai reply settings/i }));
    await waitFor(() => expect(aiReplyApi.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: 'approve', offer: 'Websites for dentists' })));
  });
});
