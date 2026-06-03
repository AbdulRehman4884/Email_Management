import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownMessageProps {
  content: string;
  className?: string;
}

export function MarkdownMessage({ content, className = '' }: MarkdownMessageProps) {
  if (/^# Outreach Email Templates/m.test(content)) {
    return <TemplateFirstOutreachMessage content={content} className={className} />;
  }

  if (/^# (?:Bulk Campaign Workflow|Template Generation Progress|Template Preview|Campaign Draft Created)/m.test(content)) {
    return <BulkWorkflowMessage content={content} className={className} />;
  }

  if (/^# (?:Executive Campaign Intelligence Report|Company Intelligence Report)/m.test(content)) {
    return <ResearchMarkdownMessage content={content} className={className} />;
  }

  return (
    <div className={`agent-markdown ${className}`.trim()} data-testid="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function BulkWorkflowMessage({ content, className = '' }: MarkdownMessageProps) {
  return (
    <div
      className={`agent-markdown agent-markdown-research agent-markdown-bulk ${className}`.trim()}
      data-testid="agent-markdown"
      data-bulk-workflow="true"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function TemplateFirstOutreachMessage({ content, className = '' }: MarkdownMessageProps) {
  const firstCompany = content.search(/^##\s+/m);
  const summaryIndex = content.search(/^# Template Campaign Summary/m);
  const intro = firstCompany >= 0 ? content.slice(0, firstCompany).trim() : content;
  const companyBlock = firstCompany >= 0
    ? content.slice(firstCompany, summaryIndex >= 0 ? summaryIndex : undefined).trim()
    : '';
  const summary = summaryIndex >= 0 ? content.slice(summaryIndex).trim() : '';
  const sections = companyBlock
    .split(/\n(?=##\s+)/g)
    .map((section) => section.trim())
    .filter(Boolean);

  return (
    <div className={`agent-markdown agent-markdown-research agent-markdown-template-first ${className}`.trim()} data-testid="agent-markdown">
      {intro && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {intro}
        </ReactMarkdown>
      )}
      <div className="template-first-company-stack" data-testid="template-first-company-stack">
        {sections.map((section, index) => {
          const title = section.match(/^##\s+(.+)$/m)?.[1] ?? `Company ${index + 1}`;
          const body = section.replace(/^##\s+.+\n?/, '').trim();
          return (
            <section className="template-first-company-section" key={`${title}-${index}`}>
              <h2>{title}</h2>
              <div className="template-first-company-body">
                {splitResearchDetailSections(body).map((detail, detailIndex) => {
                  const detailClass = templateDetailClass(detail.title);
                  const key = `${title}-${detail.title}-${detailIndex}`;

                  if (detailClass.includes('template-card-supporting')) {
                    return (
                      <details className="research-supporting-details template-supporting-details" key={key}>
                        <summary>Supporting Intelligence</summary>
                        <div className="research-supporting-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {stripMarkdownHeading(detail.markdown)}
                          </ReactMarkdown>
                        </div>
                      </details>
                    );
                  }

                  return (
                    <div className={`research-detail-card template-first-card ${detailClass}`.trim()} key={key}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {detail.markdown}
                      </ReactMarkdown>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {summary && (
        <div className="research-summary-section template-summary-section" data-testid="template-summary-section">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {summary}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function ResearchMarkdownMessage({ content, className = '' }: MarkdownMessageProps) {
  const firstCompany = content.search(/^##\s+/m);
  const summaryIndex = content.search(/^# Portfolio (?:Executive Campaign|Trigger Intelligence) Summary/m);
  const intro = firstCompany >= 0 ? content.slice(0, firstCompany).trim() : content;
  const companyBlock = firstCompany >= 0
    ? content.slice(firstCompany, summaryIndex >= 0 ? summaryIndex : undefined).trim()
    : '';
  const summary = summaryIndex >= 0 ? content.slice(summaryIndex).trim() : '';
  const sections = companyBlock
    .split(/\n(?=##\s+)/g)
    .map((section) => section.trim())
    .filter(Boolean);

  return (
    <div className={`agent-markdown agent-markdown-research ${className}`.trim()} data-testid="agent-markdown">
      {intro && (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {intro}
        </ReactMarkdown>
      )}
      <div className="research-company-stack" data-testid="research-company-stack">
        {sections.map((section, index) => {
          const title = section.match(/^##\s+(.+)$/m)?.[1] ?? `Company ${index + 1}`;
          const body = section.replace(/^##\s+.+\n?/, '').trim();
          return (
            <details className="research-company-section" key={`${title}-${index}`} open={index === 0}>
              <summary>{title}</summary>
              <div className="research-company-body">
                {splitResearchDetailSections(body).map((detail, detailIndex) => {
                  const detailClass = researchDetailClass(detail.title);
                  const key = `${title}-${detail.title}-${detailIndex}`;

                  if (detailClass.includes('research-card-supporting')) {
                    return (
                      <details className="research-supporting-details" key={key}>
                        <summary>Supporting Intelligence</summary>
                        <div className="research-supporting-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {stripMarkdownHeading(detail.markdown)}
                          </ReactMarkdown>
                        </div>
                      </details>
                    );
                  }

                  return (
                    <div
                      className={`research-detail-card ${detailClass}`.trim()}
                      key={key}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {detail.markdown}
                      </ReactMarkdown>
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })}
      </div>
      {summary && (
        <div className="research-summary-section" data-testid="research-summary-section">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {summary}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function splitResearchDetailSections(body: string) {
  const sections = body
    .split(/\n(?=###\s+)/g)
    .map((section) => section.trim())
    .filter(Boolean);

  if (sections.length === 0) {
    return [{ title: 'Details', markdown: body }];
  }

  return sections.map((markdown, index) => ({
    title: markdown.match(/^###\s+(.+)$/m)?.[1] ?? `Details ${index + 1}`,
    markdown,
  }));
}

function researchDetailClass(title: string) {
  const normalized = title.toLowerCase();
  if (/executive outreach email/.test(normalized)) return 'research-card-outreach research-card-email-hero';
  if (/follow-up sequence/.test(normalized)) return 'research-card-outreach research-card-sequence';
  if (/supporting intelligence/.test(normalized)) return 'research-card-supporting';
  if (/campaign recommendation|recommended campaign action/.test(normalized)) return 'research-card-campaign';
  if (/cta|outreach|email|linkedin|subject/.test(normalized)) return 'research-card-outreach';
  if (/executive|strategic narrative|strategic summary|strategic insight|board|priority/.test(normalized)) return 'research-card-executive';
  if (/trigger|why this company|hiring|growth|external/.test(normalized)) return 'research-card-trigger';
  if (/score|confidence|hot lead|urgency/.test(normalized)) return 'research-card-score';
  if (/persona|buyer/.test(normalized)) return 'research-card-persona';
  return 'research-card-default';
}

function templateDetailClass(title: string) {
  const normalized = title.toLowerCase();
  if (/email body/.test(normalized)) return 'template-card-email-body research-card-email-hero';
  if (/recommended subject/.test(normalized)) return 'template-card-subject research-card-outreach';
  if (/follow-up/.test(normalized)) return 'template-card-followup research-card-sequence';
  if (/recommended cta|cta/.test(normalized)) return 'template-card-cta research-card-campaign';
  if (/campaign recommendation/.test(normalized)) return 'template-card-campaign research-card-campaign';
  if (/supporting intelligence/.test(normalized)) return 'template-card-supporting';
  if (/context|rationale/.test(normalized)) return 'template-card-context research-card-executive';
  return 'template-card-default';
}

function stripMarkdownHeading(markdown: string) {
  return markdown.replace(/^###\s+.+\n?/, '').trim();
}
