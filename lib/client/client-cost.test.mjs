// CostView: the "Cost" tab of the conversation (conversation.view): money, billing kinds and caps for one session, and the
// "Copy as Markdown" button. No token table (DSH's Stats tab owns tokens).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
const SRC = fs.readFileSync(file, 'utf8');

function loadModule(reactStub, extra = {}) {
  let mod;
  const sandbox = { URL, ...extra, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? reactStub : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : n === 'react-dom' ? { createPortal: (c) => ({ portal: c }) } : { FishLogo: () => ({}) }));
}
const fakeReact = { useState: (i) => [i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f };
const load = (extra) => loadModule(fakeReact, extra)._test;
const texts = (n, out = []) => {
  if (n === null || n === undefined || typeof n === 'boolean') return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => texts(x, out)); return out; }
  if (typeof n.type === 'function') { texts(n.type(n.props), out); return out; } // expand function components (Meter, DemoBanner, pills)
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
const flat = (tree) => texts(tree).join(' | ');

const Z = { calls: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0 };
const RC = (o = {}) => ({
  sessionId: 's1', calls: 4, usd: 0.7525, apiEquivUsd: 2.2525, notChargedUsd: 1.5, turns: 2,
  firstTs: '2026-11-12T10:00:00.000Z', lastTs: '2026-11-12T10:12:30.000Z',
  cache: { input: 2600, output: 20, cacheRead: 6000, cacheWrite: 0, readShare: 6000 / 8600 },
  byRoute: [
    { provider: 'anthropic', model: 'claude', billing: 'subscription', calls: 1, usd: 0, apiEquivUsd: 1.5, notChargedUsd: 1.5 },
    { provider: 'google', model: 'gemini', billing: 'metered', calls: 3, usd: 0.7525, apiEquivUsd: 0.7525, notChargedUsd: 0 },
  ],
  byPurpose: { chat: { calls: 3, usd: 0.75, apiEquivUsd: 2.25, notChargedUsd: 1.5 }, compaction: { calls: 1, usd: 0.0025, apiEquivUsd: 0.0025, notChargedUsd: 0 } },
  byBilling: { metered: { calls: 3, usd: 0.7525, apiEquivUsd: 0.7525, notChargedUsd: 0 }, subscription: { calls: 1, usd: 0, apiEquivUsd: 1.5, notChargedUsd: 1.5 } },
  notAttributed: { ...Z },
  subagents: {
    levels: 1, sessionCount: 1, calls: 1, usd: 0, apiEquivUsd: 0.05, notChargedUsd: 0.05,
    byRoute: [{ provider: 'rocco', model: 'qwen', billing: 'local', calls: 1, usd: 0, apiEquivUsd: 0.05, notChargedUsd: 0.05 }],
    byPurpose: { chat: { calls: 1, usd: 0, apiEquivUsd: 0.05, notChargedUsd: 0.05 } }, byBilling: {}, notAttributed: { ...Z },
    sessions: [{ sessionId: 's1-a', calls: 1, usd: 0, apiEquivUsd: 0.05, notChargedUsd: 0.05 }], moreSessions: 0,
  },
  withSubagents: { calls: 5, usd: 0.7525, apiEquivUsd: 2.3025 },
  markdown: '# Session receipt\n\nSession: `s1`', caps: null, complete: true, unreadable: false, ...o,
});

test('costViewModel tiles: charged, API value not charged, turns and calls, cache read share, first and last call', () => {
  const t = load();
  const m = t.costViewModel(RC());
  const by = Object.fromEntries(m.tiles.map((x) => [x.key, x]));
  assert.equal(by.charged.value, '$0.7525');
  assert.equal(by.api.value, '$1.50'); assert.match(by.api.label, /API value, not charged/);
  assert.equal(by.turns.value, '2 turns · 4 calls');
  assert.equal(by.cache.value, '70%'); assert.match(by.cache.label, /Cache read/);
  assert.ok(m.span.startsWith('First call ')); assert.ok(m.span.includes('Last call '));
  const none = t.costViewModel(RC({ cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, readShare: null }, firstTs: null, lastTs: null }));
  assert.equal(Object.fromEntries(none.tiles.map((x) => [x.key, x])).cache.value, 'n/a');
  assert.equal(none.span, '');
  assert.equal(t.costViewModel(RC({ turns: 1, calls: 1 })).tiles.find((x) => x.key === 'turns').value, '1 turn · 1 call');
});

test('by-route rows show provider/model, a billing pill, calls, charged and API value, and no token columns', () => {
  const t = load();
  const tree = t.CostViewBody({ data: RC(), sessionId: 's1' });
  const rows = find(tree, (n) => n.props && n.props.className && String(n.props.className).includes('dshMh-trow') && n.props['data-route']);
  assert.equal(rows.length, 2);
  const s = flat(rows[0]);
  assert.ok(s.includes('anthropic/claude') && s.includes('Subscription') && s.includes('$0.00') && s.includes('$1.50'), s);
  const all = flat(tree);
  assert.ok(!/\btokens?\b/i.test(all.replace(/Copy as Markdown/g, '')), all);
  assert.ok(!/\binput\b|\boutput\b/i.test(all), all);
});

test('by-purpose rows use the Costs card labels plus "Not attributed (before ledger v2)"', () => {
  const t = load();
  const all = flat(t.CostViewBody({ data: RC({ notAttributed: { calls: 2, usd: 3, apiEquivUsd: 3, notChargedUsd: 0 } }), sessionId: 's1' }));
  assert.ok(all.includes('Chat') && all.includes('Compaction'), all);
  assert.ok(all.includes('Not attributed (before ledger v2)'), all);
  assert.ok(!flat(t.CostViewBody({ data: RC(), sessionId: 's1' })).includes('Not attributed'));
});

test('the subagents block says "one level" and shows their own routes and purposes; absent without subagent calls', () => {
  const t = load();
  const all = flat(t.CostViewBody({ data: RC(), sessionId: 's1' }));
  assert.ok(all.includes('Subagents (one level)'), all);
  assert.ok(all.includes('rocco/qwen') && all.includes('s1-a'), all);
  assert.ok(all.includes('Subagents of subagents are not counted here.'), all);
  const none = flat(t.CostViewBody({ data: RC({ subagents: { ...RC().subagents, calls: 0, sessionCount: 0, sessions: [], byRoute: [], byPurpose: {} } }), sessionId: 's1' }));
  assert.ok(!none.includes('Subagents'), none);
  const more = flat(t.CostViewBody({ data: RC({ subagents: { ...RC().subagents, moreSessions: 3 } }), sessionId: 's1' }));
  assert.ok(more.includes('and 3 more'), more);
});

test('the caps line shows the session and daily cap from receipt.caps, or nothing when caps is null', () => {
  const t = load();
  const caps = flat(t.CostViewBody({ data: RC({ caps: { dailyUsd: 10, sessionUsd: 2, todayUsd: 4, action: 'ok' } }), sessionId: 's1' }));
  assert.ok(caps.includes('Session cap') && caps.includes('Daily cap'), caps);
  assert.ok(caps.includes('$0.75 of $2.00') && caps.includes('$4.00 of $10.00'), caps);
  const none = flat(t.CostViewBody({ data: RC(), sessionId: 's1' }));
  assert.ok(!none.includes('cap'), none);
  const zero = flat(t.CostViewBody({ data: RC({ caps: { dailyUsd: 0, sessionUsd: 0, todayUsd: 1, action: 'ok' } }), sessionId: 's1' }));
  assert.ok(!zero.includes('Session cap') && !zero.includes('Daily cap'), zero);
});

test('Copy as Markdown calls navigator.clipboard.writeText(data.markdown) only from the click handler', async () => {
  const calls = [];
  const navigator = { clipboard: { writeText: (s) => { calls.push(s); return Promise.resolve(); } } };
  const t = load({ navigator });
  const data = RC();
  const tree = t.CostViewBody({ data, sessionId: 's1' });
  assert.equal(calls.length, 0, 'never on render');
  const btn = find(tree, (n) => n.type === 'button' && flat(n).includes('Copy as Markdown'));
  assert.equal(btn.length, 1);
  assert.equal(btn[0].props.type, 'button');
  assert.equal(typeof btn[0].props.onClick, 'function');
  assert.equal(calls.length, 0);
  btn[0].props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [data.markdown]);
  const status = find(tree, (n) => n.props && n.props['aria-live'] === 'polite');
  assert.equal(status.length, 1);
});

test('copyMarkdown reports Copied or "Copy failed: ..." as text, and survives a missing clipboard', async () => {
  const t = load();
  const seen = [];
  await t.copyMarkdown('md', { clipboard: { writeText: () => Promise.resolve() } }, (s) => seen.push(s));
  assert.equal(seen.at(-1), 'Copied');
  await t.copyMarkdown('md', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }, (s) => seen.push(s));
  assert.equal(seen.at(-1), 'Copy failed: denied');
  await t.copyMarkdown('md', { clipboard: { writeText: () => { throw new Error('sync'); } } }, (s) => seen.push(s));
  assert.equal(seen.at(-1), 'Copy failed: sync');
  await t.copyMarkdown('md', null, (s) => seen.push(s));
  assert.match(seen.at(-1), /^Copy failed: /);
  await t.copyMarkdown('md', {}, (s) => seen.push(s));
  assert.match(seen.at(-1), /^Copy failed: /);
});

test('it renders everything as text: no innerHTML, a hostile route name is a text child', () => {
  assert.ok(!/innerHTML|dangerouslySetInnerHTML/.test(SRC));
  const t = load();
  const evil = '<img src=x onerror=alert(1)>';
  const tree = t.CostViewBody({ data: RC({ byRoute: [{ provider: 'p', model: evil, billing: 'metered', calls: 1, usd: 1, apiEquivUsd: 1, notChargedUsd: 0 }] }), sessionId: 's1' });
  assert.ok(texts(tree).join('|').includes(evil));
  assert.equal(find(tree, (n) => n.type === 'img').length, 0);
});

test('in demo mode the DemoBanner is the first child of the root', () => {
  const t = load();
  const tree = t.CostViewBody({ data: RC({ demo: true }), sessionId: 's1' });
  assert.equal(tree.props.className, 'dshMh-hub dshMh-costview');
  const kids = [].concat(tree.props.children).filter(Boolean);
  assert.equal(kids[0].type, t.DemoBanner);
  assert.ok(!flat(t.CostViewBody({ data: RC(), sessionId: 's1' })).includes('DEMO DATA'));
});

test('loading, error and zero-call states are quiet messages', () => {
  const t = load();
  assert.ok(flat(t.CostViewBody({ data: null, error: null, sessionId: 's1' })).includes('Loading'));
  assert.ok(flat(t.CostViewBody({ data: null, error: 'HTTP 500', sessionId: 's1' })).includes('Cost is unavailable: HTTP 500'));
  assert.ok(flat(t.CostViewBody({ data: null, error: null, sessionId: '' })).includes('No session selected'));
  const empty = flat(t.CostViewBody({ data: RC({ calls: 0, turns: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0, byRoute: [], byPurpose: {}, byBilling: {}, subagents: { ...RC().subagents, calls: 0, sessions: [], byRoute: [], byPurpose: {} }, markdown: '' }), sessionId: 's1' }));
  assert.ok(empty.includes('No model calls recorded for this session yet.'), empty);
  const emptyData = { calls: 0, turns: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0, byRoute: [], byPurpose: {}, byBilling: {}, subagents: { ...RC().subagents, calls: 0, sessions: [], byRoute: [], byPurpose: {} }, markdown: '' };
  for (const bad of [{ complete: false }, { unreadable: true, complete: false }]) {
    const unknown = flat(t.CostViewBody({ data: RC({ ...emptyData, ...bad }), sessionId: 's1' }));
    assert.ok(unknown.includes('could not be read in full'), unknown);
    assert.ok(!unknown.includes('No model calls recorded'), 'an unreadable ledger must not claim there were no calls: ' + unknown);
  }
  const partial = flat(t.CostViewBody({ data: RC({ complete: false }), sessionId: 's1' }));
  assert.ok(partial.includes('could not be read in full'), partial);
});

test('CostView polls /spend/session?id=<encoded id> every 10 s', () => {
  const polled = [];
  const react = { ...fakeReact, useCallback: (f) => f, useEffect: (f) => { polled.push(f); } };
  const t = loadModule(react)._test;
  t.CostView({ sessionId: 'a b' });
  assert.equal(polled.length >= 1, true);
  assert.ok(/usePoll\(props\.sessionId \? "\/spend\/session\?id=" \+ encodeURIComponent\(props\.sessionId\) : null, 10000\)/.test(SRC));
});

test('apply registers conversation.view {id cost, order 20, label Cost}', () => {
  const m = loadModule(fakeReact);
  const regs = [];
  m.apply({ slots: { inject: (n, cb) => cb(), register: (o, c) => regs.push([o, c]) } });
  const v = regs.find(([o]) => o.name === 'conversation.view');
  assert.ok(v);
  assert.equal(v[0].id, 'cost'); assert.equal(v[0].order, 20); assert.equal(v[0].label, 'Cost'); assert.equal(typeof v[1], 'function');
  const ids = regs.map(([o]) => o.id || o.key);
  assert.equal(new Set(ids).size, ids.length);
});

test('no hardcoded colour in the cost CSS, and .dshMh-costview is covered by the .dshMh-hub alias selector', () => {
  const rules = SRC.split('\n').filter((l) => l.includes('.dshMh-costview'));
  for (const l of rules) assert.deepEqual(l.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [], [], l);
  const root = SRC.split('\n').find((l) => l.includes('--mh-card:var('));
  assert.ok(root.split('{')[0].includes('.dshMh-hub'));
});
