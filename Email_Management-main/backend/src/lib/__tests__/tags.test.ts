/**
 * Run: npm run test:tags   (node:test through tsx, no database needed)
 * Covers tag input checks and id lists used by the step 5 APIs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanIdList, validateTagInput, TAG_COLORS } from '../crm/tags.js';

test('a new tag gets defaults for color and scope', () => {
  const r = validateTagInput({ name: '  Hot   lead ' });
  assert.deepEqual(r, { ok: true, value: { name: 'Hot lead', color: TAG_COLORS[0], scope: 'both' } });
});

test('tag name is required and at most 50 characters', () => {
  assert.equal(validateTagInput({ name: '' }).ok, false);
  assert.equal(validateTagInput({}).ok, false);
  assert.equal(validateTagInput({ name: 'x'.repeat(51) }).ok, false);
  assert.equal(validateTagInput({ name: 'x'.repeat(50) }).ok, true);
});

test('color must be #rrggbb and is lower-cased', () => {
  assert.equal(validateTagInput({ name: 'a', color: 'red' }).ok, false);
  assert.equal(validateTagInput({ name: 'a', color: '#fff' }).ok, false);
  const r = validateTagInput({ name: 'a', color: '#22C55E' });
  assert.ok(r.ok && r.value.color === '#22c55e');
});

test('scope must be both, contact or campaign', () => {
  assert.equal(validateTagInput({ name: 'a', scope: 'lead' }).ok, false);
  for (const scope of ['both', 'contact', 'campaign']) assert.equal(validateTagInput({ name: 'a', scope }).ok, true);
});

test('PATCH only checks the fields that were sent', () => {
  assert.deepEqual(validateTagInput({ color: '#000000' }, true), { ok: true, value: { color: '#000000' } });
  assert.deepEqual(validateTagInput({}, true), { ok: true, value: {} });
  assert.equal(validateTagInput({ name: '' }, true).ok, false);
});

test('id lists: whole positive numbers, no duplicates, limited size', () => {
  assert.deepEqual(cleanIdList([3, '4', 3]), [3, 4]);
  assert.deepEqual(cleanIdList(undefined), []);
  assert.equal(cleanIdList('1,2'), null);
  assert.equal(cleanIdList([1, 0]), null);
  assert.equal(cleanIdList([1.5]), null);
  assert.equal(cleanIdList(['x']), null);
  assert.equal(cleanIdList([1, 2, 3], 2), null);
  assert.deepEqual(cleanIdList([1, 1, 1], 1), [1]);
});
