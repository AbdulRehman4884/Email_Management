/**
 * src/components/__tests__/AgentResponseCard.test.tsx
 *
 * Unit tests for AgentResponseCard routing and sub-card rendering.
 *
 * Coverage:
 *   A — Campaign card      (create_campaign, update_campaign, start_campaign)
 *   B — Stats card         (get_campaign_stats)
 *   C — Replies card       (list_replies)
 *   D — Reply summary card (summarize_replies)
 *   E — SMTP card          (check_smtp, update_smtp)
 *   F — Needs-input card   (needs_input status)
 *   G — Capabilities card  (general_help / capabilities text)
 *   H — Plain-text fallback
 *   I — No raw JSON leak   (structured data must not appear as raw JSON in DOM)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AgentResponseCard } from '../AgentResponseCard';
import type {
  SuccessResult,
  NeedsInputResult,
  CampaignData,
  StatsData,
  RepliesData,
  ReplySummaryData,
  SmtpData,
} from '../../lib/agentMessage';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const campaign: CampaignData = {
  id: 42,
  name: 'Summer Sale',
  subject: 'Big deals inside',
  fromName: 'Acme Corp',
  fromEmail: 'acme@example.com',
  status: 'draft',
  createdAt: '2025-06-01T10:00:00Z',
  updatedAt: '2025-06-02T08:00:00Z',
};

const stats: StatsData = {
  campaignId: 42,
  sent: 1000,
  delivered: 980,
  opened: 450,
  clicked: 120,
  bounced: 20,
  replied: 15,
  openRate: 0.459,
  clickRate: 0.122,
  bounceRate: 0.02,
  replyRate: 0.015,
};

const repliesData: RepliesData = {
  items: [
    {
      id: 1,
      fromEmail: 'user@example.com',
      fromName: 'Jane Doe',
      subject: 'Re: Big deals',
      bodyText: 'Sounds great!',
      status: 'unread',
    },
    {
      id: 2,
      fromEmail: 'other@example.com',
      subject: 'Re: Summer Sale',
    },
  ],
  total: 2,
  hasNextPage: false,
};

const replySummary: ReplySummaryData = {
  totalReplies: 42,
  sampleSize: 20,
  statusBreakdown: { read: 10, unread: 32 },
  topKeywords: ['price', 'discount', 'interested'],
  generatedAt: '2025-06-03T12:00:00Z',
};

const smtp: SmtpData = {
  host: 'smtp.sendgrid.net',
  port: 587,
  username: 'apikey',
  encryption: 'tls',
  fromEmail: 'no-reply@example.com',
  fromName: 'MailFlow',
  isVerified: true,
};

// ── A — Campaign card ─────────────────────────────────────────────────────────

describe('A — Campaign card', () => {
  it('renders campaign name and subject for create_campaign', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'create_campaign',
      message: 'Campaign created.',
      data: campaign,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-campaign-card')).toBeInTheDocument();
    expect(screen.getByText('Summer Sale')).toBeInTheDocument();
    expect(screen.getByText('Big deals inside')).toBeInTheDocument();
  });

  it('renders status badge', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'create_campaign',
      message: 'Campaign created.',
      data: campaign,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('renders fromEmail in the From row', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'update_campaign',
      message: 'Campaign updated.',
      data: campaign,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText(/acme@example\.com/)).toBeInTheDocument();
  });

  it('renders mutation label for start_campaign', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'start_campaign',
      message: 'Campaign started.',
      data: { ...campaign, status: 'in_progress' },
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText(/start campaign/i)).toBeInTheDocument();
  });

  it('renders mutation label for pause_campaign', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'pause_campaign',
      message: 'Campaign paused.',
      data: { ...campaign, status: 'paused' },
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText(/pause campaign/i)).toBeInTheDocument();
  });

  it('renders "Running" status chip for MCP "running" status', () => {
    // MCP CampaignStatus uses "running" (not "in_progress")
    const result: SuccessResult = {
      status: 'success',
      intent: 'start_campaign',
      message: 'Campaign started.',
      data: { ...campaign, status: 'running' },
    };
    render(<AgentResponseCard result={result} />);
    // StatusChip label-ises "running" → "Running"
    expect(screen.getByText('Running')).toBeInTheDocument();
  });
});

// ── B — Stats card ────────────────────────────────────────────────────────────

describe('B — Stats card', () => {
  it('renders the stats card testid', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Here are the stats.',
      data: stats,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-stats-card')).toBeInTheDocument();
  });

  it('renders sent count', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: stats,
    };
    render(<AgentResponseCard result={result} />);
    // 1000 formatted with toLocaleString — simplest check: label present
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('1,000')).toBeInTheDocument();
  });

  it('renders open rate as percentage', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: stats,
    };
    render(<AgentResponseCard result={result} />);
    // fmtRate(0.459) = "46%"
    expect(screen.getByText('46%')).toBeInTheDocument();
  });

  it('renders all four rate metrics', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: stats,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('Open Rate')).toBeInTheDocument();
    expect(screen.getByText('Click Rate')).toBeInTheDocument();
    expect(screen.getByText('Bounce Rate')).toBeInTheDocument();
    expect(screen.getByText('Reply Rate')).toBeInTheDocument();
  });

  it('renders replied count', () => {
    // stats.replied = 15
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: stats,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('Replied')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('renders unsubscribed count when present', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: { ...stats, unsubscribed: 7 },
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText("Unsub'd")).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('does not render unsubscribed box when absent', () => {
    const { unsubscribed: _, ...statsNoUnsub } = stats;
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: statsNoUnsub,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.queryByText("Unsub'd")).not.toBeInTheDocument();
  });
});

// ── C — Replies card ──────────────────────────────────────────────────────────

describe('C — Replies card', () => {
  it('renders the replies card testid', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'list_replies',
      message: '2 replies found.',
      data: repliesData,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-replies-card')).toBeInTheDocument();
  });

  it('renders first reply sender name', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'list_replies',
      message: '2 replies.',
      data: repliesData,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('renders reply subject', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'list_replies',
      message: '2 replies.',
      data: repliesData,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('Re: Big deals')).toBeInTheDocument();
  });

  it('renders total count', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'list_replies',
      message: '2 replies.',
      data: repliesData,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('2 total')).toBeInTheDocument();
  });

  it('renders "no replies" message for empty list', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'list_replies',
      message: 'No replies.',
      data: { items: [], total: 0 },
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText(/no replies found/i)).toBeInTheDocument();
  });
});

// ── D — Reply summary card ────────────────────────────────────────────────────

describe('D — Reply summary card', () => {
  it('renders the reply summary testid', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'summarize_replies',
      message: 'Summary ready.',
      data: replySummary,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-reply-summary-card')).toBeInTheDocument();
  });

  it('renders total replies count', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'summarize_replies',
      message: 'Summary.',
      data: replySummary,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders top keywords as chips', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'summarize_replies',
      message: 'Summary.',
      data: replySummary,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('price')).toBeInTheDocument();
    expect(screen.getByText('discount')).toBeInTheDocument();
    expect(screen.getByText('interested')).toBeInTheDocument();
  });
});

// ── E — SMTP card ─────────────────────────────────────────────────────────────

describe('E — SMTP card', () => {
  it('renders the smtp card testid for check_smtp', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'check_smtp',
      message: 'SMTP configured.',
      data: smtp,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-smtp-card')).toBeInTheDocument();
  });

  it('renders host and port', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'check_smtp',
      message: 'SMTP configured.',
      data: smtp,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('smtp.sendgrid.net:587')).toBeInTheDocument();
  });

  it('renders fromEmail', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'check_smtp',
      message: 'SMTP configured.',
      data: smtp,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('no-reply@example.com')).toBeInTheDocument();
  });

  it('renders verified badge when isVerified=true', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'check_smtp',
      message: 'SMTP configured.',
      data: smtp,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText(/✓ Verified/)).toBeInTheDocument();
  });

  it('renders unverified badge when isVerified=false', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'update_smtp',
      message: 'SMTP updated.',
      data: { ...smtp, isVerified: false },
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText(/✗ Unverified/)).toBeInTheDocument();
  });
});

// ── F — Needs-input card ──────────────────────────────────────────────────────

describe('F — Needs-input card', () => {
  it('renders the needs-input testid', () => {
    const result: NeedsInputResult = {
      status: 'needs_input',
      intent: 'create_campaign',
      message: 'Please provide the campaign name.',
      required_fields: ['name', 'subject'],
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-needs-input-card')).toBeInTheDocument();
  });

  it('renders required field labels', () => {
    const result: NeedsInputResult = {
      status: 'needs_input',
      intent: 'create_campaign',
      message: 'I need more info.',
      required_fields: ['campaign_name', 'subject'],
    };
    render(<AgentResponseCard result={result} />);
    // field name underscores are replaced with spaces
    expect(screen.getByText('campaign name')).toBeInTheDocument();
    expect(screen.getByText('subject')).toBeInTheDocument();
  });

  it('renders optional field labels when present', () => {
    const result: NeedsInputResult = {
      status: 'needs_input',
      intent: 'create_campaign',
      message: 'I need more info.',
      required_fields: ['name'],
      optional_fields: ['reply_to_email'],
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('reply to email')).toBeInTheDocument();
    expect(screen.getByText('Optional')).toBeInTheDocument();
  });
});

// ── G — Capabilities card ─────────────────────────────────────────────────────

describe('G — Capabilities card', () => {
  const capText = [
    "Here's what I can help you with:",
    '',
    '**Campaigns**',
    '- Create a new campaign',
    '- Update campaign details',
    '',
    '**Analytics**',
    '- Get campaign statistics',
    '- View open rates',
    '',
    '**Settings**',
    '- Check SMTP configuration',
  ].join('\n');

  it('renders the capabilities card testid', () => {
    render(<AgentResponseCard result={{ message: capText }} />);
    expect(screen.getByTestId('arc-capabilities-card')).toBeInTheDocument();
  });

  it('renders section titles', () => {
    render(<AgentResponseCard result={{ message: capText }} />);
    expect(screen.getByText('Campaigns')).toBeInTheDocument();
    expect(screen.getByText('Analytics')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders bullet items within a section', () => {
    render(<AgentResponseCard result={{ message: capText }} />);
    expect(screen.getByText('Create a new campaign')).toBeInTheDocument();
    expect(screen.getByText('Get campaign statistics')).toBeInTheDocument();
  });

  it('does NOT render the raw opening line', () => {
    render(<AgentResponseCard result={{ message: capText }} />);
    // The "Here's what I can help you with:" header line should NOT be shown
    // as raw text — the card only shows parsed section tiles.
    expect(screen.queryByText(/here's what i can help/i)).not.toBeInTheDocument();
  });
});

// ── H — Plain-text fallback ───────────────────────────────────────────────────

describe('H — Plain-text fallback', () => {
  it('renders arc-plain-text for unknown success intent without matching data', () => {
    const result = {
      status: 'success' as const,
      intent: 'unknown_intent',
      message: 'Something happened.',
      data: null,
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-plain-text')).toBeInTheDocument();
    expect(screen.getByText('Something happened.')).toBeInTheDocument();
  });

  it('renders plain text for error status', () => {
    const result = {
      status: 'error' as const,
      intent: 'create_campaign',
      message: 'Something went wrong.',
    };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByTestId('arc-plain-text')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  });

  it('renders plain text for PlainTextResult (no status)', () => {
    const result = { message: 'Just a plain message.' };
    render(<AgentResponseCard result={result} />);
    expect(screen.getByText('Just a plain message.')).toBeInTheDocument();
  });
});

// ── I — No raw JSON leak ──────────────────────────────────────────────────────

describe('I — No raw JSON leak', () => {
  it('does not render raw JSON for a campaign response', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'create_campaign',
      message: 'Campaign created.',
      data: campaign,
    };
    const { container } = render(<AgentResponseCard result={result} />);
    // The raw JSON string must not appear in the rendered output
    expect(container.textContent).not.toContain('"fromEmail"');
    expect(container.textContent).not.toContain('"status"');
    expect(container.textContent).not.toContain('{');
  });

  it('does not render raw JSON for a stats response', () => {
    const result: SuccessResult = {
      status: 'success',
      intent: 'get_campaign_stats',
      message: 'Stats.',
      data: stats,
    };
    const { container } = render(<AgentResponseCard result={result} />);
    expect(container.textContent).not.toContain('"openRate"');
    expect(container.textContent).not.toContain('"sent"');
  });
});
