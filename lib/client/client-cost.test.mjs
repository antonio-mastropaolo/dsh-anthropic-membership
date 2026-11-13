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
const J = (x) => JSON.parse(JSON.stringify(x)); // values from the client's VM realm: compare as data
// function components expanded into plain elements, so find() sees what they render
const ex = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(ex); if (typeof n.type === 'function') return ex(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: ex(n.props.children) } } : n; };

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

test('costViewModel: the header line, the two headline numbers, the total only when part was charged, and the bar segments', () => {
  const t = load();
  const m = t.costViewModel(RC());
  assert.match(m.subtitle, /^2 turns · 4 calls · cache read 70% · \S/);
  assert.equal(m.charged, '$0.75');
  assert.equal(m.notCharged, '$1.50');
  assert.equal(m.total, '$2.25', 'part charged, part not: the total says so');
  assert.deepEqual(J(m.segments.map((x) => [x.look, x.value])), [['solid', 0.7525], ['tint', 1.5]]);
  const none = t.costViewModel(RC({ cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, readShare: null }, firstTs: null, lastTs: null }));
  assert.ok(!/cache read/.test(none.subtitle) && none.subtitle === '2 turns · 4 calls');
  assert.equal(t.costViewModel(RC({ turns: 1, calls: 1 })).subtitle.split(' · ').slice(0, 2).join(' · '), '1 turn · 1 call');
  assert.match(t.costViewModel(RC({ turns: 0, calls: 3 })).subtitle, /^3 calls · /, 'calls from before ledger v2 have no turn: no "0 turns"');
  const free = t.costViewModel(RC({ usd: 0, apiEquivUsd: 1.5, notChargedUsd: 1.5 }));
  assert.equal(free.total, null, 'nothing charged: the total would repeat the headline');
  assert.equal(t.costViewModel(RC({ usd: 2, apiEquivUsd: 2, notChargedUsd: 0 })).total, null);
  const low = t.costViewModel(RC(), true);
  assert.equal(low.charged, '≥$0.75'); assert.equal(low.notCharged, '≥$1.50'); assert.equal(low.total, '≥$2.25');
  assert.equal(t.costViewModel(RC({ calls: 0, turns: 0, usd: 0, notChargedUsd: 0, apiEquivUsd: 0, byRoute: [], subagents: { ...RC().subagents, calls: 0 } })).empty, true);
});

test('headline money: 4 decimals under 25 cents, cents from there (the boards: $0.1265, $0.29, $5.15, zero is $0.00)', () => {
  const t = load();
  assert.deepEqual(['0', 0.1265, 0.2499, 0.25, 0.287, 5.153, 0.00004].map((x) => t.heroUsd(+x)), ['$0.00', '$0.1265', '$0.2499', '$0.25', '$0.29', '$5.15', '<$0.0001']);
});

test('costSpan: one time, a time range on one day, or two stamps', () => {
  const t = load();
  const at = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();
  assert.equal(t.costSpan(at(12, 19, 26), at(12, 19, 26)), 'Nov 12, 7:26 PM');
  assert.equal(t.costSpan(at(13, 9, 2), at(13, 11, 14)), 'Nov 13, 9:02 AM – 11:14 AM');
  assert.equal(t.costSpan(at(13, 9, 2), at(14, 1, 10)), 'Nov 13, 9:02 AM – Nov 14, 1:10 AM');
  assert.equal(t.costSpan(null, null), '');
});

test('bar segments and route swatches: charged is solid, plan credits hatched, API value tinted, nothing to show an outline', () => {
  const t = load();
  const rc = RC({ usd: 0.287, byRoute: [
    { provider: 'ollama', model: 'glm', billing: 'credits', calls: 12, usd: 0, apiEquivUsd: 0.341, notChargedUsd: 0.341 },
    { provider: 'anthropic', model: 'opus', billing: 'subscription', calls: 38, usd: 0, apiEquivUsd: 4.812, notChargedUsd: 4.812 },
    { provider: 'deepseek', model: 'v4', billing: 'metered', calls: 9, usd: 0.287, apiEquivUsd: 0.287, notChargedUsd: 0 },
    { provider: 'rocco', model: 'q', billing: 'local', calls: 4, usd: 0, apiEquivUsd: 0, notChargedUsd: 0 },
  ] });
  const segs = J(t.costBarSegments(rc));
  assert.deepEqual(segs.map((x) => x.look), ['solid', 'tint', 'hatch'], 'charged first, then not-charged routes, biggest first');
  assert.deepEqual(rc.byRoute.map((r) => t.routeLook(r)), ['hatch', 'tint', 'solid', 'outline']);
  assert.deepEqual(J(t.costBarSegments(RC({ usd: 0, byRoute: [] }))), []);
});

test('the hero: the two headline numbers, one bar with a role and a label, the total under it; an empty session has no bar and says so', () => {
  const t = load();
  const tree = ex(t.CostViewBody({ data: RC(), sessionId: 's1' }));
  const hero = find(tree, (n) => n.props && n.props['data-testid'] === 'model-hub-cost-hero')[0];
  const out = flat(hero);
  assert.ok(out.includes('Charged') && out.includes('$0.75') && out.includes('API value, not charged') && out.includes('$1.50'), out);
  assert.ok(out.includes('$2.25') && out.includes('API value in total'), out);
  const bar = find(hero, (n) => n.props && n.props.role === 'img');
  assert.equal(bar.length, 1);
  assert.match(bar[0].props['aria-label'], /^Session API value by route and billing: /);
  const empty = RC({ caps: { dailyUsd: 40, sessionUsd: 15, todayUsd: 0, action: 'block' }, calls: 0, turns: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0, byRoute: [], byPurpose: {}, byBilling: {}, firstTs: null, lastTs: null, subagents: { ...RC().subagents, calls: 0, sessions: [], byRoute: [], byPurpose: {}, sessionCount: 0 } });
  const e = flat(find(ex(t.CostViewBody({ data: empty, sessionId: 's1' })), (n) => n.props && n.props['data-testid'] === 'model-hub-cost-hero')[0]);
  assert.ok(e.includes('$0.00') && e.includes('No model calls yet') && !e.includes('API value'), e);
  assert.equal(find(t.CostViewBody({ data: empty, sessionId: 's1' }), (n) => n.type === 'table').length, 0, 'no tables');
  assert.ok(flat(t.CostViewBody({ data: empty, sessionId: 's1' })).includes('This session'), 'the caps remain');
});

test('by-route rows are table rows: provider / model, billing, calls, charged and not charged, and no token columns', () => {
  const t = load();
  const tree = t.CostViewBody({ data: RC(), sessionId: 's1' });
  const rows = find(tree, (n) => n.type === 'tr' && n.props['data-route']);
  assert.equal(rows.length, 2);
  const s = flat(rows[0]);
  assert.ok(s.includes('anthropic / ') && s.includes('claude') && s.includes('Subscription') && s.includes('$0.00') && s.includes('$1.50'), s);
  const heads = find(tree, (n) => n.type === 'th').map((n) => flat(n));
  assert.deepEqual(heads.slice(0, 5), ['By route', 'Billing', 'Calls', 'Charged', 'Not charged']);
  assert.ok(find(tree, (n) => n.type === 'th').every((n) => n.props.scope === 'col'));
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

test('the subagents block says "one level", counts sessions and calls, and shows what was charged and what was not; absent without subagent calls', () => {
  const t = load();
  const all = flat(find(ex(t.CostViewBody({ data: RC(), sessionId: 's1' })), (n) => n.props && n.props['data-testid'] === 'model-hub-cost-subagents')[0]).replace(/\s+\|/g, ' |');
  assert.equal(all, 'Subagents | (one level) | 1 session · 1 call | Charged | $0.00 | Not charged | $0.0500 | s1-a | 1 call | $0.00 | Subagents of subagents are not counted here.');
  const none = flat(t.CostViewBody({ data: RC({ subagents: { ...RC().subagents, calls: 0, sessionCount: 0, sessions: [], byRoute: [], byPurpose: {} } }), sessionId: 's1' }));
  assert.ok(!none.includes('Subagents'), none);
});

test('the subagents block lists one row per subagent session (id, calls, charged), "and N more subagent sessions" past the payload, and the one-level caveat', () => {
  const t = load();
  const sess = (id, calls, usd) => ({ sessionId: id, calls, usd, apiEquivUsd: usd, notChargedUsd: 0 });
  const data = RC({ subagents: { ...RC().subagents, sessionCount: 53, calls: 8, usd: 0.3, sessions: [sess('sub-alpha', 3, 0.1), sess('sub-beta', 1, 0.2), sess('sub-gamma-with-a-very-long-id-that-must-be-cut-off-with-an-ellipsis', 4, 0)], moreSessions: 50 } });
  const block = find(ex(t.CostViewBody({ data, sessionId: 's1' })), (n) => n.props && n.props['data-testid'] === 'model-hub-cost-subagents')[0];
  const rows = find(block, (n) => n.props && n.props['data-subagent-session'] === '1');
  assert.deepEqual(rows.map((r) => J(texts(r))), [['sub-alpha', '3 calls', '$0.1000'], ['sub-beta', '1 call', '$0.2000'], ['sub-gamma-with-a-very-long-id-that-must-be-cut-off-with-an-ellipsis', '4 calls', '$0.00']]);
  for (const r of rows) {
    assert.match(r.props.className, /\bdshMh-sub-row\b/, 'the same row as Charged / Not charged');
    const id = r.props.children[0];
    assert.match(id.props.className, /\bdshMh-mono\b.*\bdshMh-ellipsis\b/, 'ids in the mono style, ellipsized');
    assert.equal(id.props.title, id.props.children, 'the full id stays in the title');
  }
  const all = flat(block);
  assert.ok(all.includes('and 50 more subagent sessions'), all);
  assert.ok(all.includes('Charged') && all.includes('Not charged'), 'the Charged / Not charged rows stay');
  assert.ok(all.endsWith('Subagents of subagents are not counted here.'), all);
  // no more sessions: no "and N more" line; the caveat stays
  const few = flat(find(ex(t.CostViewBody({ data: RC(), sessionId: 's1' })), (n) => n.props && n.props['data-testid'] === 'model-hub-cost-subagents')[0]);
  assert.ok(!/more subagent session/.test(few), few);
  assert.ok(few.endsWith('Subagents of subagents are not counted here.'), few);
});

test('the caps: "This session" and "Today" from receipt.caps, a runway each; nothing when caps is null or off', () => {
  const t = load();
  const caps = flat(t.CostViewBody({ data: RC({ caps: { dailyUsd: 10, sessionUsd: 2, todayUsd: 4, action: 'ok' } }), sessionId: 's1' }));
  assert.ok(caps.includes('Spend caps') && caps.includes('This session') && caps.includes('Today'), caps);
  assert.ok(caps.includes('$0.75') && caps.includes(' of $2.00') && caps.includes('$4.00') && caps.includes(' of $10.00'), caps);
  const rails = find(ex(t.CostViewBody({ data: RC({ caps: { dailyUsd: 10, sessionUsd: 2, todayUsd: 4, action: 'ok' } }), sessionId: 's1' })), (n) => n.type === 'svg' && n.props.className === 'dshMh-runway');
  assert.equal(rails.length, 2);
  const none = flat(t.CostViewBody({ data: RC(), sessionId: 's1' }));
  assert.ok(!none.includes('Spend caps'), none);
  const zero = flat(t.CostViewBody({ data: RC({ caps: { dailyUsd: 0, sessionUsd: 0, todayUsd: 1, action: 'ok' } }), sessionId: 's1' }));
  assert.ok(!zero.includes('Spend caps'), zero);
});

test('capRunway: the dot sits at spent/cap on a 6.5..254.5 track, a hollow dot at zero, ticks the dot covers are left out, and a full cap is danger', () => {
  const t = load();
  const z = J(t.capRunway(0));
  assert.equal(z.hollow, true); assert.equal(z.x, 6.5); assert.equal(z.line, null); assert.deepEqual(z.ticks, [68, 130, 192]);
  const s = J(t.capRunway(0.29 / 15));
  assert.equal(s.hollow, false); assert.equal(s.x, 11.29, 'the board: $0.29 of $15.00 (11.3)'); assert.equal(s.line, null, 'too short to show a fill');
  const d = J(t.capRunway(9.31 / 40));
  assert.equal(d.x, 64.22, 'the board: $9.31 of $40.00 (64.2)'); assert.deepEqual(d.line, { x1: 6.5, x2: 64.22 }); assert.deepEqual(d.ticks, [130, 192], 'the 25% tick is under the dot');
  assert.equal(J(t.capRunway(2)).x, 254.5, 'over the cap stays on the track'); assert.equal(t.capRunway(1).tone, 'danger'); assert.equal(t.capRunway(0.85).tone, 'warn'); assert.equal(t.capRunway(0.2).tone, 'accent');
  assert.equal(J(t.capRunway(NaN)).x, 6.5);
});

test('niceFloor / axisUsd: the largest 1, 2 or 5 times a power of ten that fits, written without padding zeros', () => {
  const t = load();
  assert.deepEqual([0.716, 0.19, 3.4, 12, 0.0042, 0, -1].map((x) => t.niceFloor(x)), [0.5, 0.1, 2, 10, 0.002, 0, 0]);
  assert.deepEqual([0.5, 0.1, 2, 10, 0.002, 0.25].map((x) => t.axisUsd(x)), ['$0.50', '$0.10', '$2', '$10', '$0.002', '$0.25']);
});

test('turnBars: one bar per turn on a 264 x 98 box, the tallest 56.6 high, the gridline at the round value, the charged part inside; null when there is nothing to draw', () => {
  const t = load();
  const mk = (api, usd, i) => ({ turn: i + 1, apiEquivUsd: api, usd });
  const m = J(t.turnBars([0.2165, 0.716, 0.1].map((v, i) => mk(v, i === 1 ? 0.05 : 0, i))));
  assert.equal(m.bars.length, 3);
  assert.equal(m.bars[1].h, 56.6); assert.equal(m.bars[1].y, 21.4); assert.equal(m.biggest, 2);
  assert.equal(m.bars[0].x, 3.4); assert.equal(m.bars[0].w, 12); assert.ok(Math.abs(m.bars[1].x - 22.26) < 0.01);
  assert.equal(m.grid.label, '$0.50'); assert.equal(m.grid.y, 38.5);
  assert.ok(m.bars[1].ch > 0 && m.bars[0].ch === 0 && m.bars[1].ch < m.bars[1].h);
  assert.equal(m.first, 1); assert.equal(m.last, 3);
  assert.equal(t.turnBars([mk(1, 0, 0)]), null, 'one turn: no strip');
  assert.equal(t.turnBars([mk(0, 0, 0), mk(0, 0, 1)]), null, 'no value: no strip');
  assert.equal(t.turnBars(null), null);
  const many = J(t.turnBars(Array.from({ length: 200 }, (_, i) => mk(0.1 + (i % 5) / 10, 0, i))));
  assert.equal(many.bars.length, 60, 'the latest 60 turns'); assert.equal(many.first, 141);
  assert.ok(many.bars[59].x + many.bars[59].w <= 264);
});

test('the per-turn strip appears with two or more turns, labelled, and not for one turn; it reads /spend/turns through the shared turns store', () => {
  const t = load();
  const turns = { turns: [{ turn: 1, apiEquivUsd: 0.2, usd: 0 }, { turn: 2, apiEquivUsd: 0.4, usd: 0.1 }] };
  const tree = ex(t.CostViewBody({ data: RC(), sessionId: 's1', turns }));
  const sec = find(tree, (n) => n.props && n.props['data-testid'] === 'model-hub-cost-turns');
  assert.equal(sec.length, 1);
  const svg = find(sec[0], (n) => n.type === 'svg');
  assert.match(svg[0].props['aria-label'], /^API value of each of the 2 turns, the charged part solid\. The largest turn is turn 2\.$/);
  assert.ok(flat(sec[0]).includes('API value per turn') && flat(sec[0]).includes('turn 1') && flat(sec[0]).includes('turn 2'));
  assert.equal(find(ex(t.CostViewBody({ data: RC(), sessionId: 's1', turns: { turns: [turns.turns[0]] } })), (n) => n.props && n.props['data-testid'] === 'model-hub-cost-turns').length, 0);
  assert.equal(find(ex(t.CostViewBody({ data: RC(), sessionId: 's1' })), (n) => n.props && n.props['data-testid'] === 'model-hub-cost-turns').length, 0, 'no turns data yet');
  assert.ok(/const turns = useTurns\(props\.sessionId\)/.test(SRC) && /turns \}\)/.test(SRC));
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
  assert.equal(btn[0].props.title, 'Copies this receipt. It never contains prompt text, paths or emails.');
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
  assert.ok(empty.includes('No model calls yet'), empty);
  const emptyData = { calls: 0, turns: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0, byRoute: [], byPurpose: {}, byBilling: {}, subagents: { ...RC().subagents, calls: 0, sessions: [], byRoute: [], byPurpose: {} }, markdown: '' };
  for (const bad of [{ complete: false }, { unreadable: true, complete: false }]) {
    const unknown = flat(t.CostViewBody({ data: RC({ ...emptyData, ...bad }), sessionId: 's1' }));
    assert.ok(unknown.includes('could not be read in full'), unknown);
    assert.ok(!unknown.includes('No model calls yet'), 'an unreadable ledger must not claim there were no calls: ' + unknown);
  }
  const partial = flat(t.CostViewBody({ data: RC({ complete: false }), sessionId: 's1' }));
  assert.ok(partial.includes('could not be read in full'), partial);
  assert.ok(partial.includes('≥$0.75') && partial.includes('≥$1.50') && partial.includes('≥$2.25'), 'the headline numbers say "at least": ' + partial);
  assert.ok(!flat(t.CostViewBody({ data: RC(), sessionId: 's1' })).includes('≥'));
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
