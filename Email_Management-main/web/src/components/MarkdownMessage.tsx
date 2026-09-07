/**
 * src/components/MarkdownMessage.tsx
 *
 * Lightweight renderer for plain-text agent replies. The agent only ever
 * emits a small markdown subset (bold via **text**, "- " bullet lists,
 * "1. " numbered lists, blank-line paragraph breaks), so this avoids pulling
 * in a full markdown dependency.
 */

import React from 'react';

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
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

export function MarkdownMessage({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/);

  return (
    <>
      {blocks.map((block, blockIdx) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length === 0) return null;

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

        return (
          <p key={blockIdx} className={blockIdx > 0 ? 'mt-2' : undefined}>
            {lines.map((line, i) => (
              <React.Fragment key={i}>
                {i > 0 && <br />}
                {renderInline(line, `${blockIdx}-${i}`)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
