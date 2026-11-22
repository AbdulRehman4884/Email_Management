import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownMessage } from '../MarkdownMessage';

describe('MarkdownMessage', () => {
  it('QA P4 bug 17: [name](/campaigns/434) becomes a link to the campaign page; other sites do not', () => {
    const { container } = render(
      <MarkdownMessage content={'1. [DRY RUN](/campaigns/434) (#434) — completed\n2. [Bad](https://evil.example) (#1) — draft'} />,
    );
    expect(screen.getByRole('link', { name: 'DRY RUN' })).toHaveAttribute('href', '/campaigns/434');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.textContent).toContain('[Bad](https://evil.example)');
  });

  it('QA P4 bug 24: *"Summer Sale 2026"* is shown in italics without the stars', () => {
    const { container } = render(
      <MarkdownMessage content={'Example: *"Summer Sale 2026"*, *"Monthly Newsletter"*, **Step 1**'} />,
    );
    const ems = container.querySelectorAll('em');
    expect([...ems].map((e) => e.textContent)).toEqual(['"Summer Sale 2026"', '"Monthly Newsletter"']);
    expect(container.textContent).not.toContain('*');
    expect(container.querySelector('strong')?.textContent).toBe('Step 1');
  });
});
