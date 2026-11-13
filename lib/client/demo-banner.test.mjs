// The DEMO banner: every hub card, the plan card and the dock chip carry it whenever the host reports demo:true.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_TEXT } from '../demo/constants.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
const src = fs.readFileSync(file, 'utf8');

function loadWithReact(reactStub, runtime) {
  let mod;
  const sandbox = { URL, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? reactStub : n === 'react/jsx-runtime' ? (runtime || { jsx, jsxs: jsx }) : { FishLogo: () => ({}) }))._test;
}
const texts = (n, out = []) => {
  if (n === null || n === undefined || typeof n === 'boolean') return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => texts(x, out)); return out; }
  if (n.props) { texts(n.props.children, out); if (n.type && n.type.name === 'ProviderIcon') out.push('icon:' + n.props.provider); }
  return out;
};
const fakeReact = { useState: (i) => [i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f };
const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
const kids = (n) => [].concat(n.props.children);
const isBanner = (n) => Boolean(n && typeof n.type === 'function' && n.type.name === 'DemoBanner');

test('DEMO_TEXT in the client equals lib/demo/constants.mjs DEMO_TEXT', () => {
  const t = loadWithReact(fakeReact);
  assert.equal(t.DEMO_TEXT, DEMO_TEXT);
});

test('DemoBanner renders the text as a status element; the long form adds the host sentence', () => {
  const t = loadWithReact(fakeReact);
  const short = t.DemoBanner({});
  assert.equal(short.props.role, 'status');
  assert.equal(short.props.className, 'dshMh-demo');
  assert.equal(short.props['data-testid'], 'demo-banner');
  assert.deepEqual(texts(short), [DEMO_TEXT]);
  const long = texts(t.DemoBanner({ long: true })).join('');
  assert.equal(long, DEMO_TEXT + '. The host reads only the demo folder and writes nothing there.');
  // text children only: nothing in the banner is raw HTML
  assert.ok(!JSON.stringify(short).includes('dangerouslySetInnerHTML'));
});

test('DemoBanner passes its static children through jsxs: no keyless child array reaches jsx (React dev warns "unique key")', () => {
  const bad = [];
  // React's dev build validates keys of a child array only for jsx(); jsxs() declares the array static
  const jsx = (type, props) => {
    if (Array.isArray(props.children)) props.children.forEach((c) => { if (c && typeof c === 'object' && (c.key === undefined || c.key === null)) bad.push(String(c.type)); });
    return { type, props, key: props.key };
  };
  const jsxs = (type, props) => ({ type, props, key: props.key });
  const t = loadWithReact(fakeReact, { jsx, jsxs });
  t.DemoBanner({});
  t.DemoBanner({ long: true });
  assert.deepEqual(bad, []);
});

test('the cards do not repeat the banner: the hub shows it once, in a full-width row under its header', () => {
  const t = loadWithReact(fakeReact);
  const cfg = { configured: true, id: 'lab', name: 'Lab box', icon: 'nvidia' };
  const cards = {
    costs: (demo) => t.CostsPanel({ today: { data: null, error: null }, gcfg: null, demo }),
    accounts: (demo) => t.AccountsPanel({ demo }),
    gpu: (demo) => t.GpuServerPanel({ cfg, demo }),
    prices: (demo) => t.PricesPanel({ gcfg: null, demo }),
  };
  for (const [name, make] of Object.entries(cards)) {
    for (const demo of [true, false, undefined]) {
      const tree = make(demo);
      assert.ok(!kids(tree).some(isBanner), name + ': no banner inside the card');
      assert.ok(!texts(expand(tree)).some((x) => x.includes('DEMO')), name);
    }
  }
  assert.ok(!/DemoBanner/.test(/function (AccountsPanel|GpuServerPanel|PricesPanel)[\s\S]*?\n    }\n/.exec(src)[0]));
});

test('chipModel(..., demo) flags demo; the dock chip gets a DEMO tag first and the popover and the description start with the banner', () => {
  const t = loadWithReact(fakeReact);
  const plan = { mode: 'plan', fiveHour: { percent: 62, resetsAt: null }, sevenDay: { percent: 41 } };
  const spend = { totals: { usd: 20, calls: 14 }, caps: { action: 'warn', reason: 'daily $20.00 is 80% of $25', todayUsd: 20, limits: { dailyUsd: 25 } } };
  assert.equal(t.chipModel(plan, spend, null, null, false, true).demo, true);
  assert.equal(t.chipModel(plan, spend, null).demo, false);
  const on = expand(t.DockChip({ plan, spend, cache: null, demo: true }));
  const btn = kids(on).find((k) => k && k.type === 'button');
  assert.equal(btn.props.title, undefined);
  const first = kids(btn)[0];
  assert.equal(first.props.className, 'dshMh-chip-demo');
  assert.deepEqual(texts(first), ['DEMO']);
  assert.ok(btn.props['aria-label'].startsWith(DEMO_TEXT + '. '));
  // the screen-reader description of the chip (same lines as the popover) starts with the banner
  const tip = (x) => kids(x).find((k) => k && k.props && k.props.id === 'dshMh-claude-tip');
  assert.equal(texts(tip(on))[0], DEMO_TEXT);
  const off = expand(t.DockChip({ plan, spend, cache: null }));
  assert.ok(!texts(off).includes('DEMO'));
  assert.ok(!texts(tip(off)).includes(DEMO_TEXT));
  assert.deepEqual(texts(tip(on)).slice(1), texts(tip(off)));
});

test('the plan card renders the banner first when the status says demo', () => {
  const t = loadWithReact(fakeReact);
  const plan = { mode: 'plan', fiveHour: { percent: 62, resetsAt: null }, sevenDay: { percent: 41 } };
  const on = t.planCardBody({ plan, identity: null, demo: true });
  assert.ok(isBanner(kids(on)[0]));
  const off = t.planCardBody({ plan, identity: null, demo: false });
  assert.ok(!kids(off).some(isBanner));
  assert.ok(!texts(expand(off)).some((x) => x.includes('DEMO')));
});

test('HubSection shows the long banner once and hands demo to the Costs card (Edit caps), and DockWidget passes demo to the chip', () => {
  assert.match(src, /h\(AccountsPanel, \{ key: "a" \}\)/);
  assert.match(src, /h\(CostsPanel, \{ key: "c", today, gcfg: gcfg\.data, demo: st\.demo, forecast, week, declared, plan: st\.plan \}\)/);
  assert.match(src, /h\(GpuPanel, \{ key: "r", cfg: gcfg\.data \}\)/);
  assert.match(src, /h\(PricesPanel, \{ key: "p", gcfg: gcfg\.data, week, hubCfg \}\)/);
  assert.match(src, /st\.demo \? h\(DemoBanner, \{ long: true \}\) : null/);
  assert.match(src, /h\(DockChip, \{ plan: st\.plan, spend: sp\.data, cache: ca\.data, identity: st\.identity, stop: st\.caps && st\.caps\.stopAtPlanLimit === true, demo: st\.demo, forecast: fc \}\)/);
  assert.match(src, /demo: data\?\.demo === true/);
  // the order of the cards: Costs, Accounts, GPU server, Prices
  assert.ok(src.indexOf('h(CostsPanel, { key: "c"') < src.indexOf('h(AccountsPanel, { key: "a"') && src.indexOf('h(AccountsPanel, { key: "a"') < src.indexOf('h(GpuPanel, { key: "r"') && src.indexOf('h(GpuPanel, { key: "r"') < src.indexOf('h(PricesPanel, { key: "p"'));
});

test('the banner style uses --mh-* tokens only', () => {
  const rule = /"(\.dshMh-demo\{[^"]*)"/.exec(src);
  assert.ok(rule, 'a .dshMh-demo rule exists in HUB_CSS');
  assert.doesNotMatch(rule[1], /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  for (const v of rule[1].match(/var\(--[a-z0-9-]+/g) || []) assert.match(v, /^var\(--mh-/);
});

test('in demo mode the Costs card disables Edit caps and the plan card has no stop switch (a demo hub refuses every change)', () => {
  assert.match(src, /disabled: !capsView\.data \|\| editing \|\| props\.demo === true/);
  assert.match(src, /const control = st\.demo \? null : h\(PlanStopSwitch,/);
});
