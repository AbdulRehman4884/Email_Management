/**
 * Run: npm run test:dashboard   (node:test through tsx, no database needed)
 * Covers the lead filters, the funnel and the CSV cells of CRM step 8.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FilterError, contactOrderSql, contactWhereSql, parseContactFilters } from '../crm/contactFilters.js';
import { buildFunnel, csvCell } from '../../controllers/crmDashboardController.js';

test('filters: lists, flags and dates are parsed', () => {
  const f = parseContactFilters({ label: 'interested,question,interested', scoreTier: 'hot', needsReply: '1', from: '2026-01-01', to: '2026-01-31', tagIds: '3,4', search: '  ali ' });
  assert.deepEqual(f.labels, ['interested', 'question']);
  assert.deepEqual(f.scoreTiers, ['hot']);
  assert.equal(f.needsReply, true);
  assert.equal(f.hotOnly, false);
  assert.deepEqual(f.tagIds, [3, 4]);
  assert.equal(f.search, 'ali');
  assert.equal(parseContactFilters({}).labels.length, 0);
});

test('filters: bad values give a clear error', () => {
  for (const q of [{ label: 'nope' }, { scoreTier: 'lukewarm' }, { from: '31-01-2026' }, { from: '2026-02-01', to: '2026-01-01' }, { stageId: 'x' }, { tagIds: 'a' }]) {
    assert.throws(() => parseContactFilters(q), FilterError, JSON.stringify(q));
  }
});

test('filters: SQL keeps every value in parameters', () => {
  const { where, params } = contactWhereSql(7, parseContactFilters({ label: 'interested,none', search: "50%_off'; drop", scoreTier: 'hot' }));
  assert.ok(where.startsWith('cc.user_id = $1'));
  assert.ok(!where.includes('drop'), 'search text is a parameter');
  assert.ok(where.includes('cc.last_reply_label IS NULL'));
  assert.deepEqual(params[0], 7);
  assert.ok(params.includes("%50\\%\\_off'; drop%"), 'LIKE wildcards are escaped');
  const skipped = contactWhereSql(7, parseContactFilters({ stageId: '5' }), { stageId: true });
  assert.ok(!skipped.where.includes('stage_id'));
  assert.ok(contactOrderSql('hot').startsWith('COALESCE('));
  assert.ok(contactOrderSql('anything').includes('updated_at'));
});

test('funnel: reached = in that stage or later now, or before; Lost is not a step', () => {
  const stages = [
    { id: 1, name: 'New', color: '#000', type: 'normal', position: 0 },
    { id: 2, name: 'Replied', color: '#000', type: 'normal', position: 1 },
    { id: 3, name: 'Won', color: '#000', type: 'won', position: 2 },
    { id: 4, name: 'Lost', color: '#000', type: 'lost', position: 3 },
  ];
  // 4 leads: still new, replied, won, lost after replying (max position reached = 1)
  const f = buildFunnel(stages, [0, 1, 2, 1]);
  assert.deepEqual(f.map((s) => [s.name, s.reached, s.conversionFromPrev]), [
    ['New', 4, null],
    ['Replied', 3, 75],
    ['Won', 1, 33.3],
  ]);
  assert.deepEqual(buildFunnel(stages, []).map((s) => s.conversionFromPrev), [null, 0, 0]);
  // grouped counts from SQL give the same funnel
  assert.deepEqual(buildFunnel(stages, [{ pos: 0, n: 1 }, { pos: 1, n: 2 }, { pos: 2, n: 1 }]), f);
});

test('CSV cells: quotes, commas, new lines and formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(5), '5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+123'), "'+123");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@cmd'), "'@cmd");
});
