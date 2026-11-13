// receipt.mjs: a session's receipt, its plain text and its Markdown, from cleaned ledger rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReceipt, receiptText, receiptMarkdown, MAX_SUB_SESSIONS } from './receipt.mjs';
import { DEMO_TEXT } from '../demo/constants.mjs';

let n = 0;
const row = (o = {}) => ({
  ts: '2026-11-12T10:00:00.000Z', sessionId: 's1', parentSessionId: null, provider: 'google', model: 'gemini', billing: 'metered',
  usd: 0.1, apiEquivUsd: 0.1, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, priceSource: 'litellm', id: `r${++n}`,
  v: 2, purpose: 'chat', turn: 1, step: 1, ...o,
});
const v1 = (o = {}) => { const r = row(o); delete r.v; delete r.purpose; delete r.turn; delete r.step; return r; };

// the pinned fixture: 4 own calls (2 turns, 1 compaction), one direct subagent call, one other session
const FIX = () => [
  row({ ts: '2026-11-12T10:00:00.000Z', usd: 0.5, apiEquivUsd: 0.5, input: 1000, cacheRead: 3000, turn: 1 }),
  row({ ts: '2026-11-12T10:05:00.000Z', usd: 0.25, apiEquivUsd: 0.25, input: 1000, cacheRead: 3000, turn: 1, step: 2 }),
  row({ ts: '2026-11-12T10:10:00.000Z', provider: 'anthropic', model: 'claude', billing: 'subscription', usd: 0, apiEquivUsd: 1.5, input: 500, turn: 2 }),
  row({ ts: '2026-11-12T10:12:30.000Z', usd: 0.0025, apiEquivUsd: 0.0025, input: 100, purpose: 'compaction', turn: null, step: null }),
  row({ ts: '2026-11-12T10:20:00.000Z', sessionId: 's1-a', parentSessionId: 's1', provider: 'rocco', model: 'qwen', billing: 'local', usd: 0, apiEquivUsd: 0.05, input: 50 }),
  row({ ts: '2026-11-12T10:30:00.000Z', sessionId: 'other', usd: 9, apiEquivUsd: 9 }),
];

test('buildReceipt totals only the session own rows and counts distinct v2 chat turns (s1 vs s10 prefix trap)', () => {
  const rows = [...FIX(), row({ sessionId: 's10', usd: 7, apiEquivUsd: 7, turn: 5 })];
  const rc = buildReceipt(rows, 's1');
  assert.equal(rc.sessionId, 's1');
  assert.equal(rc.calls, 4);
  assert.equal(rc.usd, 0.7525);
  assert.equal(rc.apiEquivUsd, 2.2525);
  assert.equal(rc.notChargedUsd, 1.5);
  assert.equal(rc.turns, 2);
  assert.equal(rc.withSubagents.calls, 5);
  assert.equal(rc.withSubagents.apiEquivUsd, 2.3025);
});

test('by route lists provider/model with its billing kind in API-value order; one model under two kinds is two lines', () => {
  const rows = [...FIX(), row({ ts: '2026-11-12T10:11:00.000Z', usd: 0, apiEquivUsd: 0.2, billing: 'credits' })];
  const rc = buildReceipt(rows, 's1');
  assert.deepEqual(rc.byRoute.map((r) => `${r.provider}/${r.model}|${r.billing}|${r.calls}`), ['anthropic/claude|subscription|1', 'google/gemini|metered|3', 'google/gemini|credits|1']);
  for (const r of rc.byRoute) assert.ok(r.billing);
  assert.equal(rc.byRoute[0].notChargedUsd, 1.5);
  assert.deepEqual(rc.byBilling.metered, { calls: 3, usd: 0.7525, apiEquivUsd: 0.7525, notChargedUsd: 0 });
});

test('by purpose splits chat / compaction / session-title / auto-review / other and keeps unknown valid names; v1 rows are never in a purpose', () => {
  const rows = [
    row({ purpose: 'chat' }), row({ purpose: 'compaction', turn: null }), row({ purpose: 'session-title', turn: null }), row({ purpose: 'auto-review', turn: null }),
    row({ purpose: 'other', turn: null }), row({ purpose: 'fancy-new', turn: null }), v1(), v1(),
  ];
  const rc = buildReceipt(rows, 's1');
  assert.deepEqual(Object.keys(rc.byPurpose).sort(), ['auto-review', 'chat', 'compaction', 'fancy-new', 'other', 'session-title']);
  assert.equal(Object.values(rc.byPurpose).reduce((a, p) => a + p.calls, 0), 6);
});

test('v1 rows are in every total and listed as not attributed', () => {
  const rows = [v1({ usd: 1, apiEquivUsd: 1 }), v1({ usd: 2, apiEquivUsd: 2 }), row(), row(), row()];
  const rc = buildReceipt(rows, 's1');
  assert.equal(rc.calls, 5);
  assert.equal(rc.usd, 3.3);
  assert.deepEqual(rc.notAttributed, { calls: 2, usd: 3, apiEquivUsd: 3, notChargedUsd: 0 });
  assert.equal(rc.byRoute.reduce((a, r) => a + r.calls, 0), 5);
  assert.equal(rc.byBilling.metered.calls, 5);
  assert.equal(rc.turns, 1);
});

test('subagents are rolled up one level with their own breakdown; a grandchild is not; withSubagents adds the totals', () => {
  const rows = [...FIX(), row({ sessionId: 's1-b', parentSessionId: 's1-a', usd: 100, apiEquivUsd: 100 })];
  const rc = buildReceipt(rows, 's1');
  assert.equal(rc.subagents.levels, 1);
  assert.equal(rc.subagents.sessionCount, 1);
  assert.deepEqual(rc.subagents.sessions, [{ sessionId: 's1-a', calls: 1, usd: 0, apiEquivUsd: 0.05, notChargedUsd: 0.05 }]);
  assert.equal(rc.subagents.byRoute[0].billing, 'local');
  assert.deepEqual(Object.keys(rc.subagents.byPurpose), ['chat']);
  assert.equal(rc.withSubagents.usd, 0.7525);
  assert.equal(rc.withSubagents.apiEquivUsd, 2.3025);
  const empty = buildReceipt(FIX().slice(0, 1), 's1');
  assert.equal(empty.subagents.calls, 0);
  assert.deepEqual(empty.subagents.sessions, []);
});

test('the subagent session list is capped at 50 and moreSessions counts the rest', () => {
  const rows = [];
  for (let i = 0; i < 53; i++) rows.push(row({ sessionId: `sub-${String(i).padStart(2, '0')}`, parentSessionId: 's1', apiEquivUsd: 1 + i }));
  const rc = buildReceipt(rows, 's1');
  assert.equal(MAX_SUB_SESSIONS, 50);
  assert.equal(rc.subagents.sessionCount, 53);
  assert.equal(rc.subagents.sessions.length, 50);
  assert.equal(rc.subagents.moreSessions, 3);
  assert.equal(rc.subagents.calls, 53);
  assert.equal(rc.subagents.sessions[0].sessionId, 'sub-52');
});

test('cache read share is cacheRead over billed prompt tokens (null without any); first and last call are the min and max time', () => {
  const rc = buildReceipt(FIX(), 's1');
  assert.equal(rc.cache.input, 2600); assert.equal(rc.cache.cacheRead, 6000);
  assert.ok(Math.abs(rc.cache.readShare - 6000 / 8600) < 1e-12);
  assert.equal(rc.firstTs, '2026-11-12T10:00:00.000Z');
  assert.equal(rc.lastTs, '2026-11-12T10:12:30.000Z');
  const none = buildReceipt([row({ input: 0, output: 5 })], 's1');
  assert.equal(none.cache.readShare, null);
  const badTs = buildReceipt([row({ ts: 'garbage' })], 's1');
  assert.equal(badTs.firstTs, null); assert.equal(badTs.lastTs, null);
});

test('an unknown session gives zeros and null times, no throw', () => {
  const rc = buildReceipt(FIX(), 'nobody');
  assert.equal(rc.calls, 0); assert.equal(rc.usd, 0); assert.equal(rc.turns, 0);
  assert.equal(rc.firstTs, null); assert.equal(rc.lastTs, null);
  assert.deepEqual(rc.byRoute, []); assert.deepEqual(rc.byPurpose, {});
  assert.equal(rc.cache.readShare, null);
  assert.equal(rc.subagents.calls, 0); assert.equal(rc.withSubagents.calls, 0);
  assert.deepEqual(buildReceipt([], 'x').byBilling, {});
});

const TEXT = [
  'Session s1',
  'charged $0.7525 · API value $1.50, not charged · 4 calls · 2 turns · cache read 70%',
  'first call 2026-11-12 10:00Z · last call 2026-11-12 10:12Z',
  'by route:',
  '  anthropic/claude (subscription): 1 call, $0.00 charged, API value $1.50 not charged',
  '  google/gemini (metered): 3 calls, $0.7525 charged',
  'by purpose: chat 3 · compaction 1',
  'subagents (one level): 1 session, 1 call, $0.00 charged, API value $0.0500 not charged',
].join('\n');

test('receiptText: exact lines for the fixture, none longer than 100 characters, and the empty-session sentence', () => {
  const rc = buildReceipt(FIX(), 's1');
  assert.equal(receiptText(rc), TEXT);
  for (const l of receiptText(rc).split('\n')) assert.ok(l.length <= 100, l);
  assert.equal(receiptText(buildReceipt([], 's1')), 'Session s1\nNo model calls recorded for this session yet.');
  // an empty receipt from a ledger that could not be read in full must not claim there were no calls
  const unknown = receiptText(buildReceipt([], 's1'), { partial: true });
  assert.equal(unknown, 'Session s1\nThe spend ledger could not be read in full, so the calls of this session are not known.');
  assert.ok(!unknown.includes('No model calls recorded'));
  assert.equal(receiptText(buildReceipt([row()], 's1'), { partial: true }), receiptText(buildReceipt([row()], 's1')), 'a receipt with calls is unchanged by partial');
  const withV1 = receiptText(buildReceipt([v1({ usd: 1.5, apiEquivUsd: 1.5 }), row()], 's1'));
  assert.ok(withV1.includes('by purpose: chat 1 · not attributed 1'), withV1);
  assert.ok(withV1.endsWith('not attributed (rows from before ledger v2, no purpose or turn): 1 call, $1.50 charged'), withV1);
  const long = receiptText(buildReceipt([row({ provider: 'p'.repeat(60), model: 'm'.repeat(60) })], 's1'));
  for (const l of long.split('\n')) assert.ok(l.length <= 100, `${l.length} ${l}`);
});

const MD = [
  '# Session receipt',
  '',
  'Session: `s1`',
  '',
  '| | |',
  '|---|---|',
  '| Charged | $0.7525 |',
  '| Charged including subagents | $0.7525 |',
  '| API value, not charged | $1.50 |',
  '| Model calls | 4 |',
  '| Turns | 2 |',
  '| Cache-read share | 70% |',
  '| First call | 2026-11-12 10:00Z |',
  '| Last call | 2026-11-12 10:12Z |',
  '',
  '## By model / route',
  '',
  '| Route | Billing | Calls | Charged | API value, not charged |',
  '|---|---|---|---|---|',
  '| anthropic/claude | subscription | 1 | $0.00 | $1.50 |',
  '| google/gemini | metered | 3 | $0.7525 | $0.00 |',
  '',
  '## By purpose',
  '',
  '| Purpose | Calls | Charged | API value |',
  '|---|---|---|---|',
  '| chat | 3 | $0.7500 | $2.25 |',
  '| compaction | 1 | $0.0025 | $0.0025 |',
  '',
  '## Billing kinds',
  '',
  '| Billing | Calls | Charged | API value |',
  '|---|---|---|---|',
  '| metered | 3 | $0.7525 | $0.7525 |',
  '| subscription | 1 | $0.00 | $1.50 |',
  '',
  '- metered: charged per use',
  '- subscription: covered by a plan, not charged here',
  '',
  '## Subagents (one level)',
  '',
  '| Session | Calls | Charged | API value |',
  '|---|---|---|---|',
  '| s1-a | 1 | $0.00 | $0.0500 |',
  '',
  '### Subagents by model / route',
  '',
  '| Route | Billing | Calls | Charged | API value, not charged |',
  '|---|---|---|---|---|',
  '| rocco/qwen | local | 1 | $0.00 | $0.0500 |',
  '',
  '### Subagents by purpose',
  '',
  '| Purpose | Calls | Charged | API value |',
  '|---|---|---|---|',
  '| chat | 1 | $0.00 | $0.0500 |',
  '',
  'Subagents of subagents are not rolled up here.',
  '',
  'Money comes from the local spend ledger of dsh-model-hub. "API value" is what the calls would cost at list prices; it was not charged on subscription, credits, free or local routes. No prompt or completion text is recorded or shown.',
].join('\n');

test('receiptMarkdown: exact Markdown for the fixture, with the closing sentence', () => {
  assert.equal(receiptMarkdown(buildReceipt(FIX(), 's1')), MD);
});

test('receiptMarkdown: v1 rows are a last purpose row "not attributed"; more subagent sessions say "and N more"; no subagents, no subagent section', () => {
  const md = receiptMarkdown(buildReceipt([v1({ usd: 2, apiEquivUsd: 2 }), row()], 's1'));
  const lines = md.split('\n');
  const i = lines.indexOf('| chat | 1 | $0.1000 | $0.1000 |');
  assert.ok(i > 0); assert.equal(lines[i + 1], '| not attributed | 1 | $2.00 | $2.00 |');
  assert.ok(!md.includes('Subagents'));
  assert.ok(!md.includes('Charged including subagents'));
  const rows = [];
  for (let k = 0; k < 53; k++) rows.push(row({ sessionId: `sub-${k}`, parentSessionId: 's1' }));
  const many = receiptMarkdown(buildReceipt(rows, 's1'));
  assert.ok(many.split('\n').includes('and 3 more subagent sessions.'));
});

test('hostile ledger strings are sanitised in text and Markdown: no @, <, extra |, newline in a cell or path; the module is dependency free', () => {
  const hostile = ['a@b.example', 'x|y', '<img src=x onerror=1>', 'line1\nline2', '/Users/me/secret'];
  const rows = hostile.map((h, i) => row({ provider: h, model: hostile[(i + 1) % 5], billing: i % 2 ? 'metered' : h, purpose: i === 0 ? h : 'chat', turn: null, ts: `2026-11-12T10:0${i}:00.000Z` }));
  rows.push(row({ sessionId: '/Users/me/secret', parentSessionId: 's1' }));
  const rc = buildReceipt(rows, 's1');
  for (const out of [receiptText(rc), receiptMarkdown(rc)]) {
    assert.ok(!out.includes('@'), out); assert.ok(!out.includes('<'), out); assert.ok(!out.includes('/Users'), out); assert.ok(!/line1\s*\nline2/.test(out), out); assert.ok(out.includes('line1_line2'), out);
  }
  for (const l of receiptMarkdown(rc).split('\n')) if (l.startsWith('| ') && !l.startsWith('| |')) assert.equal(l.match(/\|/g).length, l.split(' | ').length + 1, l);
  const src = fs.readFileSync(new URL('./receipt.mjs', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(src)); assert.ok(!src.includes('process.env')); assert.ok(!/\brequire\(/.test(src));
});

test('demo: true puts the DEMO line first and it equals DEMO_TEXT', () => {
  const rc = buildReceipt(FIX(), 's1');
  assert.equal(receiptText(rc, { demo: true }).split('\n')[0], DEMO_TEXT);
  assert.equal(receiptMarkdown(rc, { demo: true }).split('\n')[0], DEMO_TEXT);
  assert.ok(!receiptText(rc).includes('DEMO'));
  assert.ok(!receiptMarkdown(rc).includes('DEMO'));
});

test('a real charge below $0.0001 never prints as $0.0000 in the receipt text or Markdown', async () => {
  const { receiptText, receiptMarkdown, buildReceipt } = await import('./receipt.mjs');
  const { makeSpendRecord } = await import('./cost.mjs');
  const row = makeSpendRecord({ ts: '2026-11-12T10:00:00.000Z', sessionId: 'tiny', provider: 'google', model: 'm', usage: { inputTokens: 10, outputTokens: 1 }, price: { inPerM: 2, outPerM: 10, source: 'litellm', billing: 'metered' }, meta: { purpose: 'chat', turn: 1, step: 1 } });
  assert.ok(row.usd > 0 && row.usd < 0.0001, `fixture is a tiny real charge (${row.usd})`);
  const rc = buildReceipt([row], 'tiny');
  for (const out of [receiptText(rc), receiptMarkdown(rc)]) {
    assert.doesNotMatch(out, /\$0\.0000\b/);
    assert.match(out, /<\$0\.0001/);
  }
});
