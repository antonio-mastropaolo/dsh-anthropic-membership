import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSpendRecord } from './cost.mjs';
import { buildTurns, latestSessionId, sessionRows, SESSION_ID_RE, MAX_TURNS } from './turns.mjs';

const METERED = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: 'litellm', billing: 'metered' };
const SUB = { ...METERED, source: 'litellm', billing: 'subscription' };
const T0 = Date.parse('2026-11-12T10:00:00Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

/** A cleaned v2 row. `o` overrides: sid, turn, step, purpose, at (ms offset), usage, price, parent, ttft, dur, provider, model, and any raw field. */
function row(o = {}) {
  const { sid = 's1', turn = 1, step = 1, purpose = 'chat', at = 0, usage = { inputTokens: 100, outputTokens: 10 }, price = METERED, parent = null, ttft = 500, dur = 2000, provider = 'google', model = 'm', ...raw } = o;
  return { ...makeSpendRecord({ ts: iso(at), sessionId: sid, provider, model, usage, price, meta: { purpose, turn, step, parentSessionId: parent, ttftMs: ttft, durationMs: dur } }), ...raw };
}
const v1 = (o = {}) => ({ ts: iso(0), sessionId: 's1', provider: 'google', model: 'm', input: 5, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.5, apiEquivUsd: 0.5, priceSource: 'litellm', billing: 'metered', id: 'v1-' + Math.random(), ...o });

test('buildTurns groups a session\'s v2 chat rows by turn, ascending, summing money and tokens', () => {
  const rows = [row({ turn: 2, step: 1, at: 100000, usage: { inputTokens: 1000, outputTokens: 100 } }), row({ turn: 1, step: 1, at: 0 }), row({ turn: 2, step: 2, at: 110000, usage: { inputTokens: 2000, outputTokens: 50, cacheReadTokens: 400 } })];
  const r = buildTurns(rows, 's1');
  assert.deepEqual(r.turns.map((t) => t.turn), [1, 2]);
  const t2 = r.turns[1];
  assert.equal(t2.calls, 2);
  assert.equal(t2.steps, 2);
  assert.equal(t2.input, 3000); assert.equal(t2.output, 150); assert.equal(t2.cacheRead, 400);
  assert.equal(t2.usd, Number((rows[0].usd + rows[2].usd).toFixed(6)));
  assert.equal(r.sessionId, 's1'); assert.equal(r.truncated, false); assert.equal(r.v1Calls, 0);
});

test('billing is the single kind of the turn\'s calls or "mixed"; notChargedUsd is the API value that was not charged', () => {
  const sub = buildTurns([row({ price: SUB, usage: { inputTokens: 1e6, outputTokens: 0 } })], 's1').turns[0];
  assert.equal(sub.usd, 0); assert.equal(sub.billing, 'subscription'); assert.equal(sub.notChargedUsd, sub.apiEquivUsd); assert.ok(sub.apiEquivUsd > 0);
  const met = buildTurns([row()], 's1').turns[0];
  assert.equal(met.billing, 'metered'); assert.equal(met.notChargedUsd, 0); assert.ok(met.usd > 0);
  const mixed = buildTurns([row({ step: 1, billing: 'credits', usd: 0, apiEquivUsd: 0.3 }), row({ step: 2 })], 's1').turns[0];
  assert.equal(mixed.billing, 'mixed'); assert.deepEqual(mixed.billings, { credits: 1, metered: 1 });
  const crossing = buildTurns([row({ usd: 0.2, apiEquivUsd: 0.5 })], 's1').turns[0];
  assert.equal(crossing.notChargedUsd, 0.3);
});

test('cacheReadShare is cacheRead over input+cacheRead+cacheWrite and null with no prompt tokens', () => {
  const t = buildTurns([row({ usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 900 } })], 's1').turns[0];
  assert.equal(t.cacheReadShare, 0.9);
  const z = buildTurns([row({ usage: { inputTokens: 0, outputTokens: 5 } })], 's1').turns[0];
  assert.equal(z.cacheReadShare, null);
});

test('ttftMs is the first call\'s by timestamp (null when absent); durationMs is the sum only when every call has one', () => {
  const t = buildTurns([row({ step: 2, at: 5000, ttft: 900, dur: 1000 }), row({ step: 1, at: 1000, ttft: 300, dur: 2000 })], 's1').turns[0];
  assert.equal(t.ttftMs, 300); assert.equal(t.durationMs, 3000);
  const none = buildTurns([row({ ttft: null, dur: 1000 }), row({ step: 2, at: 9000, dur: null })], 's1').turns[0];
  assert.equal(none.ttftMs, null); assert.equal(none.durationMs, null);
});

test('routes list each provider/model with its call count', () => {
  const t = buildTurns([row({ step: 1 }), row({ step: 2, at: 3000 }), row({ step: 3, at: 6000, provider: 'anthropic', model: 'c' })], 's1').turns[0];
  assert.deepEqual(t.routes, [{ provider: 'google', model: 'm', calls: 2 }, { provider: 'anthropic', model: 'c', calls: 1 }]);
});

test('v1 rows are counted in v1Calls and never get a turn; a v2 chat row with turn null and a v2 non-chat row go to outside', () => {
  const rows = [v1(), v1(), row({ turn: null, step: null, at: 10000 }), row({ purpose: 'compaction', turn: null, at: 20000 }), { ...row({ turn: null, at: 30000 }), purpose: null }, row({ turn: 1 })];
  const r = buildTurns(rows, 's1');
  assert.equal(r.v1Calls, 2);
  assert.deepEqual(r.turns.map((t) => t.turn), [1]);
  assert.equal(r.outside.calls, 3);
  assert.deepEqual(r.outside.byPurpose.map((p) => p.purpose), ['chat', 'compaction', 'unknown']);
});

test('a non-chat call whose time falls inside a turn\'s window is listed under that turn\'s during, by purpose; others are outside', () => {
  const rows = [
    row({ turn: 1, at: 0, dur: 2000 }),
    row({ turn: 2, step: 1, at: 100000, dur: 4000 }), row({ turn: 2, step: 2, at: 120000, dur: 4000 }),
    row({ purpose: 'compaction', turn: null, at: 110000 }),
    row({ purpose: 'session-title', turn: null, at: -60000 }),
    row({ purpose: 'auto-review', turn: null, at: 200000 }),
  ];
  rows[5].ts = 'not a time';
  const r = buildTurns(rows, 's1');
  assert.deepEqual(r.turns[1].during.map((d) => [d.purpose, d.calls]), [['compaction', 1]]);
  assert.equal(r.turns[0].during.length, 0);
  assert.deepEqual(r.outside.byPurpose.map((p) => p.purpose), ['auto-review', 'session-title']);
});

test('only the exact session id matches: a prefix, another session, and a subagent\'s rows are not in the index', () => {
  const rows = [row({ sid: 's1' }), row({ sid: 's10' }), row({ sid: 'sub', parent: 's1' })];
  const r = buildTurns(rows, 's1');
  assert.equal(r.turns.length, 1); assert.equal(r.turns[0].calls, 1);
  const sr = sessionRows(rows, 's1');
  assert.equal(sr.own.length, 1); assert.equal(sr.sub.length, 1); assert.equal(sr.sub[0].sessionId, 'sub');
});

test('more than MAX_TURNS turns keep the newest MAX_TURNS and set truncated', () => {
  const rows = [];
  for (let i = 1; i <= MAX_TURNS + 1; i++) rows.push(row({ turn: i, at: i * 1000 }));
  const r = buildTurns(rows, 's1');
  assert.equal(r.turns.length, MAX_TURNS); assert.equal(r.turns[0].turn, 2); assert.equal(r.truncated, true);
});

test('unpriced metered calls are counted in unpricedCalls', () => {
  const unpriced = { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, source: 'unpriced', billing: 'metered' };
  const t = buildTurns([row({ price: unpriced }), row({ step: 2, at: 4000 })], 's1').turns[0];
  assert.equal(t.unpricedCalls, 1);
});

test('latestSessionId follows a subagent row to its parent, ignores empty ids and unparseable times, and is null for an empty ledger', () => {
  assert.equal(latestSessionId([]), null);
  assert.equal(latestSessionId([row({ sid: 'a', at: 0 }), row({ sid: 'b', at: 5000 })]), 'b');
  assert.equal(latestSessionId([row({ sid: 'a', at: 0 }), row({ sid: 'sub', parent: 'a', at: 5000 })]), 'a');
  const empty = row({ sid: '', at: 9000 });
  const bad = row({ sid: 'z', at: 9500 }); bad.ts = 'garbage';
  assert.equal(latestSessionId([row({ sid: 'a', at: 0 }), empty, bad]), 'a');
});

test('SESSION_ID_RE accepts DSH ids and refuses traversal, space, empty and 129 characters', () => {
  for (const ok of ['agent-session-0b8f3c2e-1111-4222-8333-444455556666', 'a:b_c.d-1', 'x'.repeat(128)]) assert.ok(SESSION_ID_RE.test(ok), ok);
  for (const bad of ['', '../x', 'a/b', 'a b', 'a%2Fb', 'x'.repeat(129), 'a\nb']) assert.ok(!SESSION_ID_RE.test(bad), JSON.stringify(bad));
});

test('the index holds only documented numeric/id fields (no text)', () => {
  const rows = [row({ provider: 'p'.repeat(150), model: 'm'.repeat(150) }), row({ purpose: 'compaction', turn: null, at: 1000 })];
  const r = buildTurns(rows, 's1');
  assert.deepEqual(Object.keys(r).sort(), ['outside', 'sessionId', 'truncated', 'turns', 'v1Calls']);
  assert.deepEqual(Object.keys(r.turns[0]).sort(), ['apiEquivUsd', 'billing', 'billings', 'cacheRead', 'cacheReadShare', 'cacheWrite', 'calls', 'durationMs', 'during', 'firstTs', 'input', 'lastTs', 'notChargedUsd', 'output', 'routes', 'steps', 'ttftMs', 'turn', 'unpricedCalls', 'usd']);
  assert.deepEqual(Object.keys(r.outside).sort(), ['apiEquivUsd', 'byPurpose', 'calls', 'usd']);
  assert.deepEqual(Object.keys(r.turns[0].routes[0]).sort(), ['calls', 'model', 'provider']);
});
