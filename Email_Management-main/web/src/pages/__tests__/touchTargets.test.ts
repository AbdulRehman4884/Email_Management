import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// QA P4 bug 30: on a 375px phone the chips were 31px, Send 37px, Confirm / Cancel 34px and side by side.
// jsdom does not apply media queries, so the rule itself is checked.
describe('AI Agent touch targets on phones', () => {
  const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (max-width: 640px), (pointer: coarse)'));

  it('chips, attach, Send, Stop and the approval buttons are at least 44px', () => {
    expect(block).toMatch(/\.chat-prompt-chip,[\s\S]*\[data-testid="send-button"\][\s\S]*\.approval-actions button\s*\{\s*min-height: 44px;\s*min-width: 44px;/);
  });

  it('Confirm and Cancel get a wide gap', () => {
    expect(block).toMatch(/\.approval-actions \{ gap: 1\.5rem !important; \}/);
  });
});
