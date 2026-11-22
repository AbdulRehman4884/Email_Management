/**
 * AI Agent chat history: message cleaning and titles (bug A-17).
 * Run: npx tsx --test src/controllers/__tests__/agentChatController.test.ts   (no database)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTitle, cleanMessages } from '../agentChatController.js';

test('keeps only well-formed messages, the newest 300', () => {
  const many = Array.from({ length: 305 }, (_, i) => ({ role: 'user', content: `m${i}`, timestamp: '2026-11-15T10:00:00Z' }));
  const out = cleanMessages([...many, { role: 'hacker', content: 'x' }, { role: 'assistant' }, null]);
  assert.equal(out.length, 300);
  assert.equal(out[0]!.content, 'm5');
  assert.equal(out[299]!.content, 'm304');

  const [one] = cleanMessages([{ role: 'assistant', content: 'hi', timestamp: 'bad', navigatePath: 'https://evil.example' }]);
  assert.equal(one!.role, 'assistant');
  assert.equal(one!.content, 'hi');
  assert.ok(!Number.isNaN(Date.parse(one!.timestamp)));
  assert.equal('navigatePath' in one!, false);

  assert.throws(() => cleanMessages('nope'));
});

test('title: the given one, else the first question, at most 80 characters', () => {
  assert.equal(chatTitle('  My chat ', []), 'My chat');
  assert.equal(chatTitle(undefined, [{ role: 'user', content: 'Show me the stats for DRY RUN', timestamp: '' }]), 'Show me the stats for DRY RUN');
  assert.equal(chatTitle(undefined, []), 'New chat');
  assert.equal(chatTitle('x'.repeat(200), []).length, 78);
});
