/**
 * src/components/MarkdownMessage.tsx
 *
 * Lightweight renderer for plain-text agent replies. The agent only ever
 * emits a small markdown subset (bold via **text**, "- " bullet lists,
 * "1. " numbered lists, blank-line paragraph breaks), so this avoids pulling
 * in a full markdown dependency.
 */

import React from 'react';

/** [text](/campaigns/434) — only links inside the app (a path starting with one "/"), never other sites. */
const IN_APP_LINK = /^\[([^\]]+)\]\((\/(?!\/)[\w\-/?=&.%]*)\)$/;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // **bold**, *italic* (QA P4 bug 24: wizard examples showed the stars), [text](/in-app/path).
  const parts = text
    .split(/(\*\*[^*]+\*\*|\*[^*\s](?:[^*]*[^*\s])?\*|\[[^\]]+\]\(\/[^)\s]*\))/g)
    .filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    if (/^\*[^*\s](?:[^*]*[^*\s])?\*$/.test(part)) {
      return <em key={`${keyPrefix}-${i}`}>{part.slice(1, -1)}</em>;
    }
    const link = IN_APP_LINK.exec(part);
    if (link) {
      return (
        <a key={`${keyPrefix}-${i}`} href={link[2]} className="font-semibold text-blue-700 hover:underline">
          {link[1]}
        </a>
      );
    }
    return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>;
  });
}

function isBulletLine(line: string): boolean {
  return /^[-*•]\s+/.test(line);
}

function isNumberedLine(line: string): boolean {
  return /^\d+\.\s+/.test(line);
}

/** "> text" / ">" — the agent quotes an email exactly as it will be sent. */
function isQuoteLine(line: string): boolean {
  return /^>( |$)/.test(line);
}

/** A quoted email shown like the real email: plain text, its own line breaks, no ">" markers. */
function EmailPreview({ lines }: { lines: string[] }) {
  const text = lines.map((l) => l.replace(/^> ?/, '')).join('\n').replace(/^\n+|\n+$/g, '');
  return (
    <div
      data-testid="email-preview"
      className="my-2 whitespace-pre-wrap break-words rounded-lg border border-gray-200 bg-white px-4 py-3 text-[14px] leading-relaxed text-gray-800 shadow-sm"
    >
      {text}
    </div>
  );
}

function Paragraph({ lines, keyPrefix, spaced }: { lines: string[]; keyPrefix: string; spaced: boolean }) {
  return (
    <p className={spaced ? 'mt-2' : undefined}>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {i > 0 && <br />}
          {renderInline(line, `${keyPrefix}-${i}`)}
        </React.Fragment>
      ))}
    </p>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/);

  return (
    <>
      {blocks.map((block, blockIdx) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length === 0) return null;

        // Quoted email lines become an email box; the text around them stays as it is.
        if (lines.some(isQuoteLine)) {
          const groups: Array<{ quote: boolean; lines: string[] }> = [];
          for (const line of lines) {
            const quote = isQuoteLine(line);
            const last = groups[groups.length - 1];
            if (last && last.quote === quote) last.lines.push(line);
            else groups.push({ quote, lines: [line] });
          }
          return (
            <React.Fragment key={blockIdx}>
              {groups.map((g, gi) =>
                g.quote ? (
                  <EmailPreview key={gi} lines={g.lines} />
                ) : (
                  <Paragraph key={gi} lines={g.lines} keyPrefix={`${blockIdx}-${gi}`} spaced={blockIdx > 0 || gi > 0} />
                ),
              )}
            </React.Fragment>
          );
        }

        if (lines.every(isBulletLine)) {
          return (
            <ul key={blockIdx} className="list-disc pl-5 my-1 space-y-0.5">
              {lines.map((line, i) => (
                <li key={i}>{renderInline(line.replace(/^[-*•]\s+/, ''), `${blockIdx}-${i}`)}</li>
              ))}
            </ul>
          );
        }

        if (lines.every(isNumberedLine)) {
          return (
            <ol key={blockIdx} className="list-decimal pl-5 my-1 space-y-0.5">
              {lines.map((line, i) => (
                <li key={i}>{renderInline(line.replace(/^\d+\.\s+/, ''), `${blockIdx}-${i}`)}</li>
              ))}
            </ol>
          );
        }

        return <Paragraph key={blockIdx} lines={lines} keyPrefix={String(blockIdx)} spaced={blockIdx > 0} />;
      })}
    </>
  );
}
