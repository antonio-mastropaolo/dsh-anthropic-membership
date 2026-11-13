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

test('turnLine: charged money reads $0.0123 and nothing says "not charged"', () => {
  const t = load();
  const l = t.turnLine(T());
  assert.ok(l.text.startsWith('$0.0123'), l.text);
  assert.ok(!l.text.includes('not charged'));
  assert.equal(t.turnLine(T({ usd: 0.4, apiEquivUsd: 0.4 })).text.split(' · ')[0], '$0.40');
});

test('turnLine: subscription, local, credits and free show the billing kind and the API value that was not charged', () => {
  const t = load();
  for (const kind of ['subscription', 'local', 'credits', 'free']) {
    const l = t.turnLine(T({ usd: 0, apiEquivUsd: 0.52, notChargedUsd: 0.52, billing: kind, billings: { [kind]: 3 } }));
    const first = l.text.split(' · ');
    assert.equal(first[0], kind, l.text);
    assert.equal(first[1], 'API value $0.52, not charged', l.text);
    assert.ok(!l.text.includes('$0.00'), l.text);
  }
  const free = t.turnLine(T({ usd: 0, apiEquivUsd: 0, notChargedUsd: 0, billing: 'free', billings: { free: 3 } }));
  assert.equal(free.text.split(' · ')[0], 'free'); assert.ok(!free.text.includes('API value'));
});

test('turnLine: mixed billing shows the money and each other kind; unpriced calls say "price unknown", never $0.00', () => {
  const t = load();
  const mixed = t.turnLine(T({ usd: 0.4, billing: 'mixed', billings: { metered: 1, credits: 2 } }));
  assert.equal(mixed.text.split(' · ')[0], '$0.40 + credits');
  const unknown = t.turnLine(T({ usd: 0, apiEquivUsd: 0, billing: 'metered', billings: { metered: 3 }, unpricedCalls: 3 }));
  assert.equal(unknown.text.split(' · ')[0], 'price unknown');
  assert.ok(!unknown.text.includes('$0.00'));
  const some = t.turnLine(T({ usd: 0.05, billing: 'metered', billings: { metered: 3 }, unpricedCalls: 1 }));
  assert.equal(some.text.split(' · ')[0], '$0.0500 + price unknown');
});

test('turnLine: tokens in/out, cache share, one route or a route count, first token, calls', () => {
  const t = load();
  const l = t.turnLine(T());
  const parts = l.text.split(' · ');
  assert.ok(parts.includes('12.4k in / 1.2k out'), l.text);
  assert.ok(parts.includes('cache 81%'), l.text);
  assert.ok(parts.includes('google/gemini-3.8-flash'), l.text);
  assert.ok(parts.includes('first token 0.8 s'), l.text);
  assert.ok(parts.includes('3 calls'), l.text);
  const two = t.turnLine(T({ calls: 1, cacheReadShare: null, ttftMs: null, routes: [{ provider: 'a', model: 'b', calls: 1 }, { provider: 'c', model: 'd', calls: 1 }] }));
  const p2 = two.text.split(' · ');
  assert.ok(p2.includes('2 routes') && p2.includes('1 call'), two.text);
  assert.ok(!two.text.includes('cache') && !two.text.includes('first token'), two.text);
  assert.ok(t.turnLine(T({ input: 100, output: 20, cacheRead: 0 })).text.includes('100 in / 20 out'));
});

test('turnLine: non-chat calls made while the turn ran are named separately', () => {
  const t = load();
  const l = t.turnLine(T({ during: [{ purpose: 'compaction', calls: 1, usd: 0.01, apiEquivUsd: 0.01 }, { purpose: 'session-title', calls: 2, usd: 0, apiEquivUsd: 0.002 }] }));
  assert.ok(l.text.includes('+ compaction x1, session-title x2 (while this turn ran)'), l.text);
  assert.ok(!t.turnLine(T()).text.includes('while this turn ran'));
});

test('turnLine tooltip lines carry the exact numbers', () => {
  const t = load();
  const l = t.turnLine(T({ usd: 0.012345, apiEquivUsd: 0.5, notChargedUsd: 0.487655, input: 2400, cacheRead: 10000, cacheWrite: 1234567, unpricedCalls: 0, during: [{ purpose: 'compaction', calls: 1, usd: 0.010001, apiEquivUsd: 0.010001 }] }));
  const all = l.lines.join('\n');
  assert.ok(all.includes('0.012345'), all);
  assert.ok(all.includes('0.487655'), all);
  assert.ok(all.includes((1234567).toLocaleString()) && all.includes((10000).toLocaleString()) && all.includes((2400).toLocaleString()) && all.includes((1200).toLocaleString()), all);
  assert.ok(all.includes('800 ms') && all.includes('9000 ms'), all);
  assert.ok(all.includes('google/gemini-3.8-flash') && all.includes('3 calls'), all);
  assert.ok(all.includes('compaction') && all.includes('0.010001'), all);
  assert.ok(all.includes('by time: these calls carry no turn number'), all);
  assert.ok(!t.turnLine(T()).lines.join('\n').includes('by time'));
  assert.ok(l.label.startsWith('Turn 3 cost: '), l.label);
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

test('TurnCostView is text only: a hostile route name stays a text child, the root is keyboard reachable with the summary as its label', () => {
  assert.ok(!/innerHTML|dangerouslySetInnerHTML/.test(SRC));
  const t = load();
  const evil = '<img src=x onerror=alert(1)>';
  const tree = t.TurnCostView({ turn: { turn: 3, status: 'closed' }, data: { turns: [T({ routes: [{ provider: 'p', model: evil, calls: 3 }] })] } });
  assert.equal(tree.props.className, 'dshMh-turn');
  const seg = find(tree, (n) => n.props && n.props.className === 'dshMh-turnseg');
  assert.equal(seg.length, 1);
  assert.equal(seg[0].props.tabIndex, 0); assert.equal(seg[0].props.role, 'group');
  assert.ok(seg[0].props['aria-label'].startsWith('Turn 3 cost: '));
  assert.ok(texts(tree).join('|').includes(evil), 'shown as text');
  assert.equal(typeof seg[0].props.onFocus, 'function'); assert.equal(typeof seg[0].props.onBlur, 'function'); assert.equal(typeof seg[0].props.onKeyDown, 'function');
  assert.equal(typeof seg[0].props.onMouseEnter, 'function');
  const tip = find(tree, (n) => n.props && n.props.id && String(n.props.id).startsWith('dshMh-turn-tip'));
  assert.equal(tip.length, 1);
  assert.equal(seg[0].props['aria-describedby'], tip[0].props.id);
});

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

test('turnLine: a real charge below $0.0001 reads <$0.0001, never $0.0000; the tooltip keeps the exact amount', () => {
  const t = load();
  const l = t.turnLine(T({ usd: 0.00003, apiEquivUsd: 0.00003 }));
  assert.ok(l.text.startsWith('<$0.0001'), l.text);
  assert.ok(!/\$0\.0000\b/.test(l.text), l.text);
});
