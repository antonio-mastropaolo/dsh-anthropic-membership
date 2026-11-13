// TurnCost: the quiet cost line under every finished turn (conversation.chat.turnTail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
const SRC = fs.readFileSync(file, 'utf8');

function loadModule(reactStub) {
  let mod;
  const sandbox = { URL, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? reactStub : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : n === 'react-dom' ? { createPortal: (c) => ({ portal: c }) } : { FishLogo: () => ({}) }));
}
const fakeReact = { useState: (i) => [i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f };
const load = (r = fakeReact) => loadModule(r)._test;
const texts = (n, out = []) => {
  if (n === null || n === undefined || typeof n === 'boolean') return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => texts(x, out)); return out; }
  if (n.props) texts(n.props.children, out);
  return out;
};
const find = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { n.forEach((x) => find(x, pred, out)); return out; }
  if (pred(n)) out.push(n);
  if (n.props) find(n.props.children, pred, out);
  return out;
};
const J = (v) => JSON.parse(JSON.stringify(v));

const T = (o = {}) => ({
  turn: 3, calls: 3, steps: 3, usd: 0.0123, apiEquivUsd: 0.0123, notChargedUsd: 0, input: 2400, output: 1200, cacheRead: 10000, cacheWrite: 0, cacheReadShare: 10000 / 12400,
  billing: 'metered', billings: { metered: 3 }, routes: [{ provider: 'google', model: 'gemini-3.8-flash', calls: 3 }], unpricedCalls: 0,
  ttftMs: 800, durationMs: 9000, firstTs: '2026-11-12T10:00:00.000Z', lastTs: '2026-11-12T10:00:09.000Z', during: [], ...o,
});

const parts = (l) => l.text.split(' · ');

test('turnLine: charged money reads "Charged $0.0123", with a solid swatch and nothing that says "not charged"', () => {
  const t = load();
  const l = t.turnLine(T());
  assert.equal(l.head, 'Charged $0.0123');
  assert.equal(l.look, 'solid');
  assert.equal(parts(l)[0], 'Charged $0.0123');
  assert.ok(!/not charged/i.test(l.text), l.text);
  assert.equal(parts(t.turnLine(T({ usd: 0.4, apiEquivUsd: 0.4 })))[0], 'Charged $0.40');
  assert.equal(parts(t.turnLine(T({ usd: 0.2499, apiEquivUsd: 0.2499 })))[0], 'Charged $0.2499');
});

test('turnLine: subscription, local, credits and free say "Not charged", the billing kind and the API value; the swatch tells them apart', () => {
  const t = load();
  const look = { subscription: 'tint', local: 'outline', credits: 'hatch', free: 'outline' };
  for (const kind of ['subscription', 'local', 'credits', 'free']) {
    const l = t.turnLine(T({ usd: 0, apiEquivUsd: 0.1248, notChargedUsd: 0.1248, billing: kind, billings: { [kind]: 3 } }));
    const p = parts(l);
    assert.equal(p[0], 'Not charged', l.text);
    assert.equal(p[1], kind[0].toUpperCase() + kind.slice(1), l.text);
    assert.equal(p[2], 'API value $0.1248', l.text);
    assert.equal(l.look, look[kind], kind);
    assert.ok(!l.text.includes('$0.00'), l.text);
  }
  const free = t.turnLine(T({ usd: 0, apiEquivUsd: 0, notChargedUsd: 0, billing: 'free', billings: { free: 3 } }));
  assert.deepEqual(parts(free).slice(0, 2), ['Not charged', 'Free']); assert.ok(!free.text.includes('API value'));
  // the example of the board: one subscription call
  assert.equal(t.turnLine(T({ usd: 0, apiEquivUsd: 0.1248, notChargedUsd: 0.1248, calls: 1, billing: 'subscription', billings: { subscription: 1 }, routes: [{ provider: 'anthropic', model: 'claude-opus-4-7', calls: 1 }] })).text,
    'Not charged · Subscription · API value $0.1248 · anthropic / claude-opus-4-7 · 1 call');
});

test('turnLine: mixed billing lists each kind and says what was charged; unpriced calls say "price unknown", never $0.00', () => {
  const t = load();
  const mixed = t.turnLine(T({ usd: 0.4, billing: 'mixed', billings: { metered: 1, credits: 2 }, calls: 3, routes: [{ provider: 'a', model: 'b', calls: 1 }, { provider: 'c', model: 'd', calls: 2 }] }));
  assert.equal(mixed.text, 'Charged $0.40 · Metered + Credits · 2 routes · 3 calls');
  assert.equal(mixed.look, 'solid');
  const unknown = t.turnLine(T({ usd: 0, apiEquivUsd: 0, billing: 'metered', billings: { metered: 3 }, unpricedCalls: 3 }));
  assert.equal(parts(unknown)[0], 'Price unknown');
  assert.ok(!unknown.text.includes('$0.00') && !/not charged/i.test(unknown.text), unknown.text);
  const some = t.turnLine(T({ usd: 0.05, billing: 'metered', billings: { metered: 3 }, unpricedCalls: 1 }));
  assert.deepEqual(parts(some).slice(0, 2), ['Charged $0.0500', 'Metered + price unknown']);
});

test('turnLine: one route as "provider / model" (the model is the strong part), a route count for several, calls; no tokens, cache or timing on the line', () => {
  const t = load();
  const l = t.turnLine(T());
  assert.deepEqual(J(l.parts), ['Metered', { prov: 'google', model: 'gemini-3.8-flash' }, '3 calls']);
  assert.ok(parts(l).includes('google / gemini-3.8-flash'), l.text);
  assert.ok(!/ in \/ |cache|first token/.test(l.text), l.text);
  const two = t.turnLine(T({ calls: 1, routes: [{ provider: 'a', model: 'b', calls: 1 }, { provider: 'c', model: 'd', calls: 1 }] }));
  assert.ok(parts(two).includes('2 routes') && parts(two).includes('1 call'), two.text);
});

test('turnLine: calls that ran while the turn did show as "+ Compaction" / "+ Review"', () => {
  const t = load();
  const l = t.turnLine(T({ during: [{ purpose: 'compaction', calls: 1, usd: 0.01, apiEquivUsd: 0.01 }] }));
  assert.equal(parts(l).at(-1), '+ Compaction');
  assert.equal(parts(t.turnLine(T({ during: [{ purpose: 'compaction', calls: 1, usd: 0, apiEquivUsd: 0 }, { purpose: 'auto-review', calls: 2, usd: 0, apiEquivUsd: 0 }] }))).at(-1), '+ Compaction + Review');
  assert.ok(!t.turnLine(T()).text.includes('+ '));
  assert.match(l.label, /^Turn 3 cost: charged \$0\.0123, Metered, google \/ gemini-3\.8-flash, 3 calls, plus a compaction call while this turn ran\. Details$/);
});

test('turnDetail: tokens in with the cache split, tokens out, timing, and the calls that ran during the turn', () => {
  const t = load();
  const d = J(t.turnDetail(T({ input: 13981, cacheRead: 34229, cacheWrite: 0, cacheReadShare: 34229 / 48210, output: 1134, ttftMs: 900, durationMs: 7400, during: [{ purpose: 'compaction', calls: 1, usd: 0.0075, apiEquivUsd: 0.0075 }] })));
  assert.deepEqual([d.input, d.readPct, d.fresh, d.cacheRead, d.cacheWrite, d.output, d.ttft, d.model], [48210, 71, 13981, 34229, 0, 1134, '0.9 s', '7.4 s']);
  assert.deepEqual(d.during, [{ label: 'Compaction', calls: 1, usd: 0.0075, api: 0.0075 }]);
  const none = J(t.turnDetail(T({ cacheReadShare: null, ttftMs: null, durationMs: null })));
  assert.deepEqual([none.readPct, none.ttft, none.model, none.during.length], [null, null, null, 0]);
});

test('TurnCostView renders nothing for a missing entry, a turn that is not closed, and a turn with no entry (v1)', () => {
  const t = load();
  const data = { turns: [T()] };
  assert.equal(t.TurnCostView({ turn: { turn: 3, status: 'closed' }, data: null }), null);
  assert.equal(t.TurnCostView({ turn: { turn: 3, status: 'closed' }, data: {} }), null);
  assert.equal(t.TurnCostView({ turn: { turn: 3, status: 'open' }, data }), null);
  assert.equal(t.TurnCostView({ turn: { turn: 3, status: 'unknown' }, data }), null);
  assert.equal(t.TurnCostView({ turn: { turn: 9, status: 'closed' }, data }), null);
  assert.equal(t.TurnCostView({ turn: undefined, data }), null);
  assert.notEqual(t.TurnCostView({ turn: { turn: 3, status: 'closed' }, data }), null);
});

test('TurnCostView is text only; the line is ONE button (expanded state, controls, label) and the detail opens inline, Escape closes it', () => {
  assert.ok(!/innerHTML|dangerouslySetInnerHTML/.test(SRC));
  const evil = '<img src=x onerror=alert(1)>';
  let open = false; const set = (v) => { open = v; };
  const focused = [];
  const React = { ...fakeReact, useState: () => [open, set], useRef: () => ({ current: { focus: () => focused.push('btn') } }) };
  const t = load(React);
  const view = () => t.TurnCostView({ turn: { turn: 3, status: 'closed' }, sessionId: 'session-1', data: { turns: [T({ routes: [{ provider: 'p', model: evil, calls: 3 }], during: [{ purpose: 'compaction', calls: 1, usd: 0.0075, apiEquivUsd: 0.0075 }] })] } });
  let tree = view();
  assert.equal(tree.props.className, 'dshMh-turn');
  const btns = find(tree, (n) => n.type === 'button');
  assert.equal(btns.length, 1);
  const b = btns[0];
  assert.equal(b.props.className, 'dshMh-tl');
  assert.equal(b.props['aria-expanded'], 'false');
  assert.ok(b.props['aria-label'].startsWith('Turn 3 cost: '));
  assert.equal(b.props['aria-controls'], 'dshMh-turn-session-1-3');
  assert.ok(texts(tree).join('|').includes(evil), 'shown as text');
  assert.equal(find(tree, (n) => n.props && n.props.className === 'dshMh-td').length, 0, 'closed: no detail');
  assert.equal(find(tree, (n) => n.type === 'svg' && n.props.className === 'dshMh-tl-chev' && n.props['aria-hidden'] === 'true').length, 1, 'one decorative chevron');
  b.props.onClick();
  assert.equal(open, true);
  open = true;
  tree = view();
  assert.equal(find(tree, (n) => n.props && n.props['aria-expanded'] === 'true').length, 1);
  const detail = find(tree, (n) => n.type === TurnDetailFn(t));
  assert.equal(detail.length, 1, 'the detail card is rendered when open');
  const card = t.TurnDetail(detail[0].props);
  assert.equal(card.props.id, 'dshMh-turn-session-1-3');
  assert.equal(card.props.role, 'region');
  assert.equal(card.props['aria-label'], 'Turn 3 cost details');
  const shown = texts(card).join('|');
  for (const x of ['In', 'Out', 'Time', 'While this turn ran', 'Calls', 'Charged', 'API value', 'Compaction', '$0.0075', "Not part of this turn's charge. Matched to it by time."]) assert.ok(shown.includes(x), x);
  // keyboard: Escape closes the open detail and puts focus back on the button; other keys do nothing
  let stopped = false;
  tree.props.onKeyDown({ key: 'a', stopPropagation() { stopped = true; } });
  assert.equal(open, true);
  tree.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped = true; } });
  assert.equal(open, false); assert.deepEqual(focused, ['btn']); assert.equal(stopped, true);
});
// the TurnDetail component function as the client's tree refers to it (the same reference through the module's _test)
const TurnDetailFn = (t) => t.TurnDetail;

function fakeTimers() {
  const timers = new Map(); let n = 0;
  return { timers, setIntervalFn: (fn, ms) => { timers.set(++n, { fn, ms }); return n; }, clearIntervalFn: (id) => { timers.delete(id); } };
}
const tick = async () => { await new Promise((r) => setImmediate(r)); };

test('the turns store shares one poll per session: one fetch and one 5000 ms interval for three subscribers', async () => {
  const t = load();
  const fx = fakeTimers(); const asked = []; let vis = true;
  const store = t.createTurnsStore({ fetchJson: (p) => { asked.push(p); return Promise.resolve({ turns: [], sessionId: 'x' }); }, setIntervalFn: fx.setIntervalFn, clearIntervalFn: fx.clearIntervalFn, visible: () => vis });
  const got = [];
  const u1 = store.subscribe('s1', (s) => got.push(['a', s])); const u2 = store.subscribe('s1', () => {}); const u3 = store.subscribe('s1', () => {});
  await tick();
  assert.deepEqual(asked, ['/spend/turns?session=s1']);
  assert.equal(fx.timers.size, 1); assert.equal([...fx.timers.values()][0].ms, 5000);
  assert.equal(got.at(-1)[1].data.sessionId, 'x');
  const u4 = store.subscribe('s2', () => {});
  await tick();
  assert.deepEqual(asked, ['/spend/turns?session=s1', '/spend/turns?session=s2']);
  assert.equal(fx.timers.size, 2);
  u1(); u2();
  assert.equal(fx.timers.size, 2);
  u3();
  assert.equal(fx.timers.size, 1);
  assert.equal(store.snapshot('s1').data, null);
  u4();
  assert.equal(fx.timers.size, 0);
});

test('the turns store: a hidden tab fetches nothing, a visible tick fetches, an error keeps the last data, a bad id is never requested', async () => {
  const t = load();
  const fx = fakeTimers(); const asked = []; let vis = true; let fail = false;
  const store = t.createTurnsStore({ fetchJson: (p) => { asked.push(p); return fail ? Promise.reject(new Error('HTTP 500')) : Promise.resolve({ turns: [{ turn: 1 }] }); }, setIntervalFn: fx.setIntervalFn, clearIntervalFn: fx.clearIntervalFn, visible: () => vis });
  const un = store.subscribe('s1', () => {});
  await tick();
  assert.equal(asked.length, 1);
  const { fn } = [...fx.timers.values()][0];
  vis = false; fn(); await tick();
  assert.equal(asked.length, 1, 'hidden: no fetch');
  vis = true; fn(); await tick();
  assert.equal(asked.length, 2);
  fail = true; fn(); await tick();
  const snap = store.snapshot('s1');
  assert.equal(snap.data.turns[0].turn, 1, 'data kept');
  assert.match(snap.error, /HTTP 500/);
  un();
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(129), 'a b']) { const u = store.subscribe(bad, () => {}); u(); }
  await tick();
  assert.equal(asked.length, 3);
  assert.equal(fx.timers.size, 0);
  const hiddenStart = t.createTurnsStore({ fetchJson: (p) => { asked.push(p); return Promise.resolve({}); }, setIntervalFn: fx.setIntervalFn, clearIntervalFn: fx.clearIntervalFn, visible: () => false });
  hiddenStart.subscribe('s9', () => {}); await tick();
  assert.equal(asked.length, 3, 'a hidden tab does not fetch on subscribe either');
});

test('apply registers conversation.chat.turnTail with a fresh id and an order, besides the existing slots', () => {
  const m = loadModule(fakeReact);
  const regs = [];
  m.apply({ slots: { inject: (n, cb) => cb(), register: (o, c) => regs.push([o, c]) } });
  const turn = regs.find(([o]) => o.name === 'conversation.chat.turnTail');
  assert.ok(turn);
  assert.equal(turn[0].id, 'model-hub-turn-cost'); assert.equal(typeof turn[0].order, 'number'); assert.equal(typeof turn[1], 'function');
  const ids = regs.map(([o]) => o.id || o.key);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(regs.map(([o]) => o.name).sort(), ['conversation.chat.turnTail', 'conversation.composer.dock', 'conversation.view', 'settings.models.footer', 'settings.models.provider-card']);
});

test('no hardcoded colour in the turn CSS, and .dshMh-turn is in the alias selector so the --mh-* tokens resolve', () => {
  const rules = SRC.split('\n').filter((l) => l.includes('.dshMh-turn'));
  assert.ok(rules.length >= 3);
  for (const l of rules) assert.deepEqual(l.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [], [], l);
  const alias = SRC.split('\n').find((l) => l.includes('--mh-card:var('));
  assert.ok(/(^|["',])\.dshMh-turn(,|$)/.test(alias.split('{')[0].trim()), 'alias selector');
});

test('turnLine: a real charge below $0.0001 reads <$0.0001, never $0.0000', () => {
  const t = load();
  const l = t.turnLine(T({ usd: 0.00003, apiEquivUsd: 0.00003 }));
  assert.equal(l.head, 'Charged <$0.0001');
  assert.ok(!/\$0\.0000\b/.test(l.text), l.text);
});
