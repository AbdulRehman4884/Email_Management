/**
 * src/components/AgentResponseCard.tsx
 *
 * Renders structured AI agent responses as typed visual cards.
 * Routes on intent + data shape so each tool response gets the right layout
 * instead of a plain text dump.
 *
 * Routing priority:
 *   1. isCapabilitiesText()  → CapabilitiesCard  (general_help)
 *   2. isNeedsInputResult()  → NeedsInputCard
 *   3. isSuccessResult()     → data-specific card (campaign / stats / replies / smtp)
 *   4. default               → PlainTextCard      (safe fallback)
 */

import React from 'react';
import {
  BarChart2,
  CheckCircle2,
  HelpCircle,
  Inbox,
  Megaphone,
  Server,
} from 'lucide-react';
import { MarkdownMessage } from './MarkdownMessage';
import {
  type AgentStructuredResult,
  type CampaignData,
  type StatsData,
  type RepliesData,
  type ReplySummaryData,
  type SmtpData,
  type NeedsInputResult,
  CAMPAIGN_INTENTS,
  SMTP_INTENTS,
  isSuccessResult,
  isNeedsInputResult,
  isCampaignData,
  isStatsData,
  isRepliesData,
  isReplySummaryData,
  isSmtpData,
  isCapabilitiesText,
  fmtRate,
  fmtNum,
  fmtDate,
  fmtScheduleAt,
} from '../lib/agentMessage';

// ── Shared low-level primitives ───────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: '0.65rem',
        fontWeight: 600,
        color: '#9ca3af',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        margin: 0,
      }}
    >
      {children}
    </p>
  );
}

function KVRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '0.75rem',
        padding: '0.3rem 0',
        borderBottom: '1px solid #f3f4f6',
      }}
    >
      <span style={{ fontSize: '0.75rem', color: '#6b7280', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: '0.75rem',
          color: '#111827',
          fontWeight: 500,
          textAlign: 'right',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          minWidth: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: '#f9fafb',
        borderRadius: '0.5rem',
        padding: '0.5rem 0.5rem',
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: '1rem', fontWeight: 700, color: '#111827', margin: 0 }}>{value}</p>
      <p
        style={{
          fontSize: '0.6rem',
          color: '#9ca3af',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          margin: 0,
        }}
      >
        {label}
      </p>
    </div>
  );
}

function Chip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.15rem 0.6rem',
        borderRadius: '9999px',
        background: '#f3f4f6',
        color: '#374151',
        fontSize: '0.7rem',
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  );
}

function CardWrap({
  children,
  'data-testid': testId,
}: {
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        background: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '0.625rem',
        padding: '0.875rem 1rem',
        width: '100%',
      }}
    >
      {children}
    </div>
  );
}

// ── Status badge (accepts any string — not bound to CampaignStatus enum) ─────
//
// MCP CampaignStatus uses "running" (not "in_progress").
// Both values are listed so the badge works regardless of which layer
// produced the status string.

const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  draft:       { bg: '#f3f4f6', color: '#6b7280' },
  scheduled:   { bg: '#dbeafe', color: '#2563eb' },
  running:     { bg: '#fef9c3', color: '#d97706' }, // MCP CampaignStatus
  in_progress: { bg: '#fef9c3', color: '#d97706' }, // MailFlow frontend status
  paused:      { bg: '#ede9fe', color: '#7c3aed' },
  completed:   { bg: '#dcfce7', color: '#16a34a' },
  cancelled:   { bg: '#fee2e2', color: '#dc2626' },
  read:        { bg: '#dcfce7', color: '#16a34a' }, // ReplyStatus
  unread:      { bg: '#dbeafe', color: '#2563eb' }, // ReplyStatus
  archived:    { bg: '#f3f4f6', color: '#9ca3af' }, // ReplyStatus
};

function StatusChip({ status }: { status: string }) {
  const cfg = STATUS_COLORS[status] ?? { bg: '#f3f4f6', color: '#6b7280' };
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.2rem 0.6rem',
        borderRadius: '9999px',
        background: cfg.bg,
        color: cfg.color,
        fontSize: '0.7rem',
        fontWeight: 600,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

// ── Campaign card ─────────────────────────────────────────────────────────────

function CampaignCard({ data, intent }: { data: CampaignData; intent: string }) {
  const isMutation = ['start_campaign', 'pause_campaign', 'resume_campaign'].includes(intent);
  const mutationLabel = intent.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <CardWrap data-testid="arc-campaign-card">
      {isMutation && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.3rem',
            marginBottom: '0.625rem',
          }}
        >
          <CheckCircle2
            style={{ width: '0.875rem', height: '0.875rem', color: '#16a34a', flexShrink: 0 }}
          />
          <span style={{ fontSize: '0.72rem', color: '#16a34a', fontWeight: 600 }}>
            {mutationLabel}
          </span>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '0.5rem',
          marginBottom: '0.625rem',
          minWidth: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
          <p
            style={{
              fontWeight: 700,
              fontSize: '0.9rem',
              color: '#111827',
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.name}
          </p>
          <p
            style={{
              fontSize: '0.75rem',
              color: '#6b7280',
              margin: '0.1rem 0 0',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.subject}
          </p>
        </div>
        <StatusChip status={data.status} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Split name and email onto separate lines when both are long */}
        <KVRow label="From" value={
          data.fromName
            ? <>{data.fromName}<br /><span style={{ color: '#9ca3af' }}>{data.fromEmail}</span></>
            : data.fromEmail
        } />
        {data.scheduledAt != null && (
          <KVRow label="Scheduled" value={fmtScheduleAt(data.scheduledAt)} />
        )}
        {data.createdAt && <KVRow label="Created" value={fmtDate(data.createdAt)} />}
        {data.updatedAt && <KVRow label="Updated" value={fmtDate(data.updatedAt)} />}
        <KVRow label="ID" value={String(data.id)} />
      </div>
    </CardWrap>
  );
}

// ── Stats card ────────────────────────────────────────────────────────────────

function StatsResultCard({ data }: { data: StatsData }) {
  return (
    <CardWrap data-testid="arc-stats-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.75rem',
        }}
      >
        <BarChart2 style={{ width: '0.875rem', height: '0.875rem', color: '#6b7280' }} />
        <SectionLabel>Campaign Analytics</SectionLabel>
      </div>
      {/* Volume row — counts */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(68px, 1fr))',
          gap: '0.4rem',
          marginBottom: '0.4rem',
        }}
      >
        <MetricBox label="Sent"         value={fmtNum(data.sent)} />
        <MetricBox label="Delivered"    value={fmtNum(data.delivered)} />
        <MetricBox label="Opened"       value={fmtNum(data.opened)} />
        <MetricBox label="Clicked"      value={fmtNum(data.clicked)} />
        <MetricBox label="Replied"      value={fmtNum(data.replied)} />
        <MetricBox label="Bounced"      value={fmtNum(data.bounced)} />
        {data.unsubscribed != null && (
          <MetricBox label="Unsub'd" value={fmtNum(data.unsubscribed)} />
        )}
      </div>
      {/* Rate row — percentages */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(68px, 1fr))',
          gap: '0.4rem',
        }}
      >
        <MetricBox label="Open Rate"   value={fmtRate(data.openRate)} />
        <MetricBox label="Click Rate"  value={fmtRate(data.clickRate)} />
        <MetricBox label="Reply Rate"  value={fmtRate(data.replyRate)} />
        <MetricBox label="Bounce Rate" value={fmtRate(data.bounceRate)} />
      </div>
      {data.calculatedAt && (
        <p
          style={{
            fontSize: '0.65rem',
            color: '#d1d5db',
            marginTop: '0.5rem',
            textAlign: 'right',
          }}
        >
          Updated {fmtDate(data.calculatedAt)}
        </p>
      )}
    </CardWrap>
  );
}

// ── Replies list card ─────────────────────────────────────────────────────────

function RepliesResultCard({ data }: { data: RepliesData }) {
  return (
    <CardWrap data-testid="arc-replies-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.625rem',
        }}
      >
        <Inbox style={{ width: '0.875rem', height: '0.875rem', color: '#6b7280' }} />
        <SectionLabel>Inbox Replies</SectionLabel>
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: '#9ca3af' }}>
          {data.total} total
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {data.items.length === 0 ? (
          <p
            style={{
              fontSize: '0.8rem',
              color: '#9ca3af',
              textAlign: 'center',
              padding: '0.5rem 0',
            }}
          >
            No replies found.
          </p>
        ) : (
          data.items.slice(0, 10).map((item) => (
            <div
              key={String(item.id)}
              style={{ borderBottom: '1px solid #f3f4f6', paddingBottom: '0.5rem' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                }}
              >
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: '#374151',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}
                >
                  {item.fromName ?? item.fromEmail}
                </span>
                {item.status && <StatusChip status={item.status} />}
              </div>
              <p
                style={{
                  fontSize: '0.72rem',
                  color: '#6b7280',
                  margin: '0.1rem 0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {item.subject}
              </p>
              {item.bodyText && (
                <p
                  style={{
                    fontSize: '0.7rem',
                    color: '#9ca3af',
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.bodyText}
                </p>
              )}
            </div>
          ))
        )}
        {(data.hasNextPage || data.items.length > 10) && (
          <p
            style={{
              fontSize: '0.7rem',
              color: '#9ca3af',
              textAlign: 'center',
              margin: 0,
            }}
          >
            Showing {Math.min(data.items.length, 10)} of {data.total} — ask for more to see the next page
          </p>
        )}
      </div>
    </CardWrap>
  );
}

// ── Reply summary card ────────────────────────────────────────────────────────

function ReplySummaryResultCard({ data }: { data: ReplySummaryData }) {
  return (
    <CardWrap data-testid="arc-reply-summary-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.625rem',
        }}
      >
        <Inbox style={{ width: '0.875rem', height: '0.875rem', color: '#6b7280' }} />
        <SectionLabel>Reply Summary</SectionLabel>
      </div>
      {data.totalReplies != null && (
        <KVRow label="Total replies" value={fmtNum(data.totalReplies)} />
      )}
      {data.sampleSize != null && (
        <KVRow label="Sample size" value={fmtNum(data.sampleSize)} />
      )}
      {data.statusBreakdown && Object.keys(data.statusBreakdown).length > 0 && (
        <div style={{ margin: '0.5rem 0' }}>
          <SectionLabel>Status breakdown</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
            {Object.entries(data.statusBreakdown).map(([k, v]) => (
              <span
                key={k}
                style={{
                  fontSize: '0.7rem',
                  background: '#f3f4f6',
                  borderRadius: '0.4rem',
                  padding: '0.1rem 0.5rem',
                  color: '#374151',
                }}
              >
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}
      {data.topKeywords && data.topKeywords.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <SectionLabel>Top keywords</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
            {data.topKeywords.map((kw) => (
              <Chip key={kw} label={kw} />
            ))}
          </div>
        </div>
      )}
      {data.generatedAt && (
        <p
          style={{
            fontSize: '0.65rem',
            color: '#d1d5db',
            marginTop: '0.5rem',
            textAlign: 'right',
          }}
        >
          Generated {fmtDate(data.generatedAt)}
        </p>
      )}
    </CardWrap>
  );
}

// ── SMTP card ─────────────────────────────────────────────────────────────────

function SmtpResultCard({ data }: { data: SmtpData }) {
  return (
    <CardWrap data-testid="arc-smtp-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.625rem',
        }}
      >
        <Server style={{ width: '0.875rem', height: '0.875rem', color: '#6b7280' }} />
        <SectionLabel>SMTP Settings</SectionLabel>
        {data.isVerified != null && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '0.7rem',
              fontWeight: 600,
              color: data.isVerified ? '#16a34a' : '#dc2626',
            }}
          >
            {data.isVerified ? '✓ Verified' : '✗ Unverified'}
          </span>
        )}
      </div>
      <KVRow label="Host" value={`${data.host}:${data.port}`} />
      {data.encryption && (
        <KVRow label="Encryption" value={data.encryption.toUpperCase()} />
      )}
      {data.username && <KVRow label="Username" value={data.username} />}
      {data.fromEmail && <KVRow label="From email" value={data.fromEmail} />}
      {data.fromName && <KVRow label="From name" value={data.fromName} />}
      {data.updatedAt && <KVRow label="Updated" value={fmtDate(data.updatedAt)} />}
    </CardWrap>
  );
}

// ── Needs-input card ──────────────────────────────────────────────────────────

function NeedsInputCard({ result }: { result: NeedsInputResult }) {
  return (
    <CardWrap data-testid="arc-needs-input-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.3rem',
          marginBottom: '0.5rem',
        }}
      >
        <HelpCircle
          style={{ width: '0.875rem', height: '0.875rem', color: '#f59e0b', flexShrink: 0 }}
        />
        <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#92400e', margin: 0 }}>
          More information needed
        </p>
      </div>
      <div style={{ fontSize: '0.8rem', color: '#374151', marginBottom: '0.625rem' }}>
        <MarkdownMessage content={result.message} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
        {(result.required_fields ?? []).map((f) => (
          <div key={f} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                background: '#fef3c7',
                color: '#b45309',
                borderRadius: '0.25rem',
                padding: '0.1em 0.4em',
                flexShrink: 0,
              }}
            >
              Required
            </span>
            <span style={{ fontSize: '0.75rem', color: '#374151' }}>
              {f.replace(/_/g, ' ')}
            </span>
          </div>
        ))}
        {(result.optional_fields ?? []).map((f) => (
          <div key={f} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                background: '#f3f4f6',
                color: '#9ca3af',
                borderRadius: '0.25rem',
                padding: '0.1em 0.4em',
                flexShrink: 0,
              }}
            >
              Optional
            </span>
            <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>
              {f.replace(/_/g, ' ')}
            </span>
          </div>
        ))}
      </div>
    </CardWrap>
  );
}

// ── Capabilities card ─────────────────────────────────────────────────────────

type CapSection = { title: string; items: string[] };

const CAP_ICON_MAP: Array<[string, React.ReactNode]> = [
  ['campaign', <Megaphone key="campaign" style={{ width: '1rem', height: '1rem' }} />],
  ['analytic', <BarChart2 key="analytic" style={{ width: '1rem', height: '1rem' }} />],
  ['inbox',    <Inbox     key="inbox"    style={{ width: '1rem', height: '1rem' }} />],
  ['repl',     <Inbox     key="repl"     style={{ width: '1rem', height: '1rem' }} />],
  ['setting',  <Server    key="setting"  style={{ width: '1rem', height: '1rem' }} />],
  ['smtp',     <Server    key="smtp"     style={{ width: '1rem', height: '1rem' }} />],
];

function getCapIcon(title: string): React.ReactNode {
  const lower = title.toLowerCase();
  for (const [key, icon] of CAP_ICON_MAP) {
    if (lower.includes(key)) return icon;
  }
  return <HelpCircle style={{ width: '1rem', height: '1rem' }} />;
}

function parseCapabilities(text: string): CapSection[] {
  const sections: CapSection[] = [];
  let current: CapSection | null = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^\*\*(.+)\*\*\s*$/);
    const bullet = line.match(/^[ \t]*[-*•]\s+(.+)/);
    if (header) {
      if (current) sections.push(current);
      current = { title: header[1], items: [] };
    } else if (bullet && current) {
      current.items.push(bullet[1].replace(/\*\*/g, ''));
    }
  }
  if (current && current.items.length > 0) sections.push(current);
  return sections;
}

function CapabilitiesCard({ message }: { message: string }) {
  const sections = parseCapabilities(message);

  if (sections.length === 0) {
    return (
      <div data-testid="arc-plain-text">
        <MarkdownMessage content={message} />
      </div>
    );
  }

  return (
    <CardWrap data-testid="arc-capabilities-card">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          marginBottom: '0.75rem',
        }}
      >
        <HelpCircle style={{ width: '0.875rem', height: '0.875rem', color: '#6b7280' }} />
        <SectionLabel>What I can do</SectionLabel>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '0.5rem',
        }}
      >
        {sections.map((sec) => (
          <div
            key={sec.title}
            style={{
              background: '#f9fafb',
              border: '1px solid #f3f4f6',
              borderRadius: '0.5rem',
              padding: '0.625rem 0.75rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                marginBottom: '0.35rem',
                color: '#374151',
              }}
            >
              {getCapIcon(sec.title)}
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#111827' }}>
                {sec.title}
              </span>
            </div>
            <ul style={{ margin: 0, padding: '0 0 0 1rem', listStyle: 'disc' }}>
              {sec.items.slice(0, 4).map((item, i) => (
                <li
                  key={i}
                  style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: '0.1rem' }}
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </CardWrap>
  );
}

// ── Plain-text fallback ───────────────────────────────────────────────────────

function PlainTextCard({ message }: { message: string }) {
  return (
    <div data-testid="arc-plain-text">
      <MarkdownMessage content={message} />
    </div>
  );
}

// ── Main routing component ────────────────────────────────────────────────────

export function AgentResponseCard({ result }: { result: AgentStructuredResult }) {
  // 1. Capabilities detection (independent of status)
  if (isCapabilitiesText(result.message)) {
    return <CapabilitiesCard message={result.message} />;
  }

  // 2. Needs input — show field requirements
  if (isNeedsInputResult(result)) {
    return <NeedsInputCard result={result} />;
  }

  // 3. Success — route by intent + data shape
  if (isSuccessResult(result)) {
    if (CAMPAIGN_INTENTS.has(result.intent) && isCampaignData(result.data)) {
      return <CampaignCard data={result.data} intent={result.intent} />;
    }
    if (result.intent === 'get_campaign_stats' && isStatsData(result.data)) {
      return <StatsResultCard data={result.data} />;
    }
    if (result.intent === 'list_replies' && isRepliesData(result.data)) {
      return <RepliesResultCard data={result.data} />;
    }
    if (result.intent === 'summarize_replies' && isReplySummaryData(result.data)) {
      return <ReplySummaryResultCard data={result.data} />;
    }
    if (SMTP_INTENTS.has(result.intent) && isSmtpData(result.data)) {
      return <SmtpResultCard data={result.data} />;
    }
  }

  // 4. Default — safe plain-text render (handles error status, unknown intents, etc.)
  return <PlainTextCard message={result.message} />;
}
