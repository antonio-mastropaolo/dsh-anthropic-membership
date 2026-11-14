// Model picker: billing chips, family logos and the second line on every row (slot conversation.input.model.label).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_LOGOS, GLYPHS } from '../icons-data.mjs';
import { convertSvg, assertSafe, BEGIN, END, clientBlock, FAMILY_FILES, GLYPH_FILES } from '../../scripts/build-icons.mjs';

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
const t = loadModule(fakeReact)._test;
const J = (v) => JSON.parse(JSON.stringify(v));
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

// ---- chip kind, label, tone ----
test('chip kind: subscription and credits are Plan; metered priced / unpriced; free; local is GPU server only for config.gpuServer.id', () => {
  assert.equal(t.chipKind({ billing: 'subscription', priced: true }, 'anthropic', ''), 'plan');
  assert.equal(t.chipKind({ billing: 'credits', priced: true }, 'ollama', ''), 'plan');
  assert.equal(t.chipKind({ billing: 'metered', priced: true }, 'google', ''), 'metered');
  assert.equal(t.chipKind({ billing: 'metered', priced: false }, 'google', ''), 'unpriced');
  assert.equal(t.chipKind({ billing: 'free', priced: true }, 'dashscope', ''), 'free');
  assert.equal(t.chipKind({ billing: 'local', priced: true }, 'rocco', 'rocco'), 'gpu');
  assert.equal(t.chipKind({ billing: 'local', priced: true }, 'mac', 'rocco'), 'mac');
  assert.equal(t.chipKind({ billing: 'local', priced: true }, 'rocco', ''), 'mac', 'no GPU server configured: it is this machine');
  for (const bad of [null, undefined, 'x', { error: 'use provider/model', priced: false }]) assert.equal(t.chipKind(bad, 'p', ''), null);
});
test('chips: label and tone per kind, and "This computer" when the host is not macOS', () => {
  assert.deepEqual(J(t.CHIP_ORDER.map((k) => [k, t.chipLabel(k, 'darwin'), t.CHIP_KINDS[k].tone])), [
    ['plan', 'Plan', 'accent'], ['metered', 'Metered', 'warn'], ['unpriced', 'Unpriced', 'bad'], ['free', 'Free', 'outline'], ['gpu', 'GPU server', 'ok'], ['mac', 'This Mac', 'ok'],
  ]);
  assert.equal(t.chipLabel('mac', 'linux'), 'This computer');
  assert.equal(t.chipLabel('mac', 'win32'), 'This computer');
  assert.equal(t.chipLabel('mac', ''), 'This Mac', 'unknown host: the default');
  assert.equal(t.chipLabel('plan', 'linux'), 'Plan');
});

// ---- money ----
test('money: whole dollars have no decimals, everything else at least two', () => {
  const cases = [[5, '$5'], [0, '$0'], [15, '$15'], [0.1, '$0.10'], [0.04, '$0.04'], [1.35, '$1.35'], [1.4, '$1.40'], [0.075, '$0.075'], [0.30000000000000004, '$0.30'], [4.4, '$4.40'], [25, '$25'], [0.95, '$0.95']];
  for (const [n, s] of cases) assert.equal(t.pickerMoney(n), s, String(n));
  assert.equal(t.pickerMoney(NaN), '?');
  assert.equal(t.pickerMoney(undefined), '?');
});

// ---- second line, exact wording ----
const plan = { mode: 'plan', fiveHour: { percent: 12.4 }, sevenDay: { percent: 40.2 }, scopedWeekly: { label: 'Fable', percent: 7.6 } };
test('second line: Plan reads "On your plan · API value … · 5h N% · week N%", Fable shows its own week, parts with no reading are omitted', () => {
  const e = { billing: 'subscription', priced: true, inPerM: 5, outPerM: 25 };
  const ctx = { providerId: 'anthropic', modelId: 'claude-opus-4-8', modelName: 'Opus 4.8', plan, platform: 'darwin' };
  assert.equal(t.chipLine('plan', e, ctx), 'On your plan · API value $5 in / $25 out per 1M · 5h 12% · week 40%');
  assert.equal(t.chipLine('plan', e, { ...ctx, modelId: 'fable-1', modelName: 'Fable' }), 'On your plan · API value $5 in / $25 out per 1M · Fable week 8%');
  assert.equal(t.chipLine('plan', e, { ...ctx, modelId: 'fable-1', plan: { ...plan, scopedWeekly: { label: 'Other', percent: 1 } } }), 'On your plan · API value $5 in / $25 out per 1M');
  assert.equal(t.chipLine('plan', e, { ...ctx, plan: { fiveHour: { percent: 3 } } }), 'On your plan · API value $5 in / $25 out per 1M · 5h 3%');
  assert.equal(t.chipLine('plan', e, { ...ctx, plan: null }), 'On your plan · API value $5 in / $25 out per 1M');
  // no price known for the plan model: no API value part; another provider has no plan windows
  assert.equal(t.chipLine('plan', { billing: 'subscription', priced: true, inPerM: 0, outPerM: 0, apiEquivKnown: false }, ctx), 'On your plan · 5h 12% · week 40%');
  assert.equal(t.chipLine('plan', { ...e, inPerM: 1.25, outPerM: 10 }, { ...ctx, providerId: 'openai-codex' }), 'On your plan · API value $1.25 in / $10 out per 1M');
});
test('second line: Metered, Unpriced, Free, GPU server and This Mac', () => {
  const m = { billing: 'metered', priced: true, inPerM: 1.4, outPerM: 4.4 };
  assert.equal(t.chipLine('metered', m, { modelId: 'gemini-3.8-flash' }), '$1.40 in / $4.40 out per 1M · counts toward your caps');
  assert.equal(t.chipLine('metered', m, { modelId: 'glm-5.2:cloud' }), 'Ollama cloud · $1.40 in / $4.40 out per 1M · counts toward your caps');
  assert.equal(t.chipLine('metered', m, { modelId: 'glm-5.2-cloud' }), 'Ollama cloud · $1.40 in / $4.40 out per 1M · counts toward your caps');
  assert.equal(t.chipLine('unpriced', {}, {}), "Billed per token, no price set · caps can't count it");
  assert.equal(t.chipLine('free', {}, {}), 'Free · $0');
  assert.equal(t.chipLine('gpu', {}, {}), 'Your GPU server · $0 · never capped');
  assert.equal(t.chipLine('mac', {}, { platform: 'darwin' }), 'Runs on this Mac · $0 · never capped');
  assert.equal(t.chipLine('mac', {}, { platform: 'linux' }), 'Runs on this computer · $0 · never capped');
});

// ---- logos ----
test('logo mapping: families by model id and name; route aliases keep their own family; unknown models keep an empty slot', () => {
  const f = (id, name, prov) => t.logoFamily(id, name, prov);
  assert.equal(f('claude-opus-4-8', 'Opus 4.8', 'anthropic'), 'claude');
  assert.equal(f('claude-sonnet-4-6', '', ''), 'claude');
  assert.equal(f('claude-haiku-5.5', '', 'openrouter'), 'claude');
  assert.equal(f('fable-1', 'Fable', 'anthropic'), 'claude');
  assert.equal(f('qwen3.8-27b', 'Mac · qwen3.8-27b', 'm'), 'qwen');
  assert.equal(f('claude-mlx-qwen3.8-27b', 'Mac MLX · qwen3.8-27b', 'm'), 'qwen', 'an alias names its real family');
  assert.equal(f('claude-abliteration-glm53-large', 'ablit · glm53-large', 'a'), 'glm');
  assert.equal(f('glm-5.2:cloud', 'Ollama cloud · glm-5.2:cloud', 'rocco-gateway'), 'glm');
  assert.equal(f('kimi-k2.6:cloud', 'Ollama cloud · kimi-k2.6:cloud', 'rocco-gateway'), 'kimi');
  assert.equal(f('gpt-5.2', '', 'openai-codex'), 'openai');
  assert.equal(f('gpt-oss:20b', 'Mac Ollama · gpt-oss:20b', 'mac'), 'openai');
  assert.equal(f('gpt', 'Mac Ollama · gpt', 'mac'), 'openai');
  assert.equal(f('codex-mini', '', 'openai-codex'), 'openai');
  assert.equal(f('gemini-3.8-flash', '', 'google'), 'gemini');
  assert.equal(f('gemma4:e2b', 'Mac Ollama · gemma4:e2b', 'mac'), 'gemma');
  assert.equal(f('grok-4', '', 'xai'), 'grok');
  assert.equal(f('llama3.3:70b', '', 'mac'), 'llama');
  assert.equal(f('mistral-large', '', 'm'), 'mistral');
  // "Ollama" contains "llama" and "Mac Ollama" prefixes every local model: neither is a Llama model
  assert.equal(f('baronllm-tools', 'Mac Ollama · baronllm-tools', 'mac'), null);
  assert.equal(f('claude-flint', 'Mac · flint', 'mac'), null, 'a Claude Code route alias is not Claude');
  assert.equal(f('rabbit', 'Mac Ollama · rabbit', 'mac'), null);
  assert.equal(f('granite3.2-vision', 'Mac Ollama · granite3.2-vision', 'mac'), null);
  assert.equal(f('', '', ''), null);
  for (const k of Object.keys(FAMILY_FILES)) assert.ok(FAMILY_LOGOS[k], `a logo for ${k}`);
  for (const fam of ['claude', 'qwen', 'glm', 'kimi', 'openai', 'gemini', 'grok', 'llama', 'mistral']) assert.ok(FAMILY_LOGOS[fam], fam);
});

// ---- the row model ----
const snapOf = (entries, extra = {}) => ({ prices: new Map(Object.entries(entries)), plan, gpuId: 'rocco', platform: 'darwin', ...extra });
test('pickerRow: every placement shows logo + name + chip; only a menu row (option) has the second line', () => {
  const snap = snapOf({ 'rocco-gateway/glm-5.2:cloud': { billing: 'metered', priced: true, inPerM: 1.4, outPerM: 4.4 } });
  const base = { provider: { id: 'rocco-gateway', name: 'Rocco gateway' }, model: { id: 'glm-5.2:cloud', name: 'Ollama cloud · glm-5.2:cloud' } };
  for (const placement of ['trigger', 'menu']) {
    const r = t.pickerRow({ ...base, placement }, snap);
    assert.equal(r.family, 'glm'); assert.equal(r.name, 'Ollama cloud · glm-5.2:cloud'); assert.deepEqual(J(r.chip), { kind: 'metered', label: 'Metered', tone: 'warn' }); assert.equal(r.line, null);
  }
  const o = t.pickerRow({ ...base, placement: 'option' }, snap);
  assert.equal(o.line, 'Ollama cloud · $1.40 in / $4.40 out per 1M · counts toward your caps');
  // not loaded yet / a model id the host would reject: logo and name, no chip, no line
  const none = t.pickerRow({ ...base, model: { id: 'rocco-*', name: 'Mac Ollama · rocco-*' }, placement: 'option' }, snap);
  assert.equal(none.chip, null); assert.equal(none.line, null); assert.equal(none.priceId, null);
  assert.equal(t.pickerRow({ ...base, placement: 'option' }, snapOf({})).chip, null);
  // the GPU server's own id turns a local route into the GPU server chip
  const g = t.pickerRow({ provider: { id: 'rocco' }, model: { id: 'qwen3.8', name: 'Qwen' }, placement: 'option' }, snapOf({ 'rocco/qwen3.8': { billing: 'local', priced: true } }));
  assert.equal(g.chip.label, 'GPU server'); assert.equal(g.line, 'Your GPU server · $0 · never capped');
  const mac = t.pickerRow({ provider: { id: 'mac' }, model: { id: 'qwen3.8', name: 'Qwen' }, placement: 'option' }, snapOf({ 'mac/qwen3.8': { billing: 'local', priced: true } }, { platform: 'linux' }));
  assert.equal(mac.chip.label, 'This computer'); assert.equal(mac.line, 'Runs on this computer · $0 · never capped');
});

// ---- rendering: text nodes only, one size ----
test('ModelLabel renders names as text nodes; hostile names and ids never become markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const m = loadModule({ ...fakeReact, useId: () => ':r1:' })._test;
  const out = m.ModelLabel({ provider: { id: 'p' }, model: { id: 'm', name: evil }, placement: 'option' });
  assert.ok(texts(out).includes(evil), 'shown as text');
  assert.ok(find(out, (n) => n.props && (n.props.dangerouslySetInnerHTML !== undefined || n.type === 'img')).length === 0);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(SRC.slice(SRC.indexOf('// ---------------- model picker'), SRC.indexOf('// ---------------- styles'))), 'no HTML strings in the picker code');
  assert.match(out.props.className, /dshMh-ml is-option/);
});
test('the chip is one fixed size for every kind: 100 x 20, 1 px currentColor border, 11px/600, 12 px glyph', () => {
  const rule = SRC.split('\n').find((l) => l.includes('.dshMh-bchip{'));
  for (const want of ['width:100px', 'height:20px', 'border:1px solid currentColor', 'font-size:11px', 'font-weight:600', 'border-radius:999px', 'justify-content:center', 'color-mix(in srgb,currentColor 12%,transparent)']) assert.ok(rule.includes(want), want);
  assert.ok(SRC.includes('.dshMh-bchip-g{flex:none;display:block;width:12px;height:12px}'));
  assert.ok(SRC.includes('.dshMh-ml-logo{flex:none;display:block;width:18px;height:18px}'));
  assert.ok(SRC.includes('font-size:11.5px'), 'second line 11.5 px');
  assert.ok(SRC.includes('var(--dsw-alias-label-tertiary'), 'tertiary text');
  const alias = SRC.split('\n').find((l) => l.includes('--mh-card:var('));
  assert.ok(/(^|["',])\.dshMh-ml(,|$)/.test(alias.split('{')[0].trim()), 'the --mh-* tokens resolve on the picker label');
  const dark = SRC.split('\n').find((l) => l.includes('--mh-accent-text:var(--mh-accent)'));
  assert.ok(dark.includes('body[data-ds-dark-theme] .dshMh-ml'), 'dark theme tokens too');
  for (const k of t.CHIP_ORDER) {
    const c = t.BillingChip({ kind: k, label: t.chipLabel(k, 'darwin'), uid: 'u' });
    assert.match(c.props.className, /^dshMh-bchip is-(accent|warn|bad|outline|ok)$/);
    assert.equal(c.props.children[0].props.width, 12);
  }
});
test('the legend card shows every chip with its one line', () => {
  const lg = t.BillingLegend();
  const rows = find(lg, (n) => n.props && n.props['data-legend']);
  assert.deepEqual(J(rows.map((r) => r.props['data-legend'])), ['plan', 'metered', 'unpriced', 'free', 'gpu', 'mac']);
  const expand = (n) => (!n || typeof n !== 'object' ? n : Array.isArray(n) ? n.map(expand) : typeof n.type === 'function' ? expand(n.type(n.props)) : { ...n, props: { ...n.props, children: expand(n.props.children) } });
  const all = texts(expand(lg)).join('|');
  for (const want of ['Plan', 'Metered', 'Unpriced', 'Free', 'GPU server', 'This Mac', 'Covered by a Pro/Max, ChatGPT or Copilot plan. $0 per call; uses your plan windows.',
    'Pay per token. Counted in the ledger and stopped by your caps.', "Pay per token, but the hub has no price. Spend can't be counted, and a provider cap blocks it.", 'A $0 cloud route.', 'Your own GPU server. $0, never capped.', 'Runs on this machine. $0, never capped.']) assert.ok(all.includes(want), want);
  assert.ok(SRC.includes('h(BillingLegend, { key: "l" })'), 'on the Model hub settings page');
});

// ---- the store: batches of 50, one fetch per new id, refresh on the poll cadence ----
function fakeTimers() {
  const intervals = new Map(); let n = 0;
  return { intervals, setTimeout: () => ++n, clearTimeout: () => {}, setInterval: (f, ms) => { intervals.set(++n, { f, ms }); return n; }, clearInterval: (id) => intervals.delete(id) };
}
test('chip store: 120 models go out as 50 + 50 + 20, are cached, and a refresh re-asks for all of them', async () => {
  const calls = [];
  const fetchJson = async (p) => {
    calls.push(p);
    if (p.startsWith('/prices')) { const ids = decodeURIComponent(p.split('=')[1]).split(','); return { hostPlatform: 'linux', models: Object.fromEntries(ids.map((i) => [i, { billing: 'metered', priced: true, inPerM: 1, outPerM: 2 }])) }; }
    if (p === '/status') return { plan: { fiveHour: { percent: 5 } } };
    return { configured: true, id: 'rocco' };
  };
  const timers = fakeTimers();
  const s = t.createChipStore(fetchJson, timers);
  const ids = Array.from({ length: 120 }, (_, i) => `rocco-gateway/model-${i}:cloud`);
  ids.forEach((id) => s.want(id)); ids.forEach((id) => s.want(id));
  await s.flush();
  const prices = calls.filter((c) => c.startsWith('/prices'));
  assert.equal(prices.length, 3);
  assert.deepEqual(prices.map((c) => decodeURIComponent(c.split('=')[1]).split(',').length), [50, 50, 20]);
  assert.equal(s.snapshot().prices.size, 120);
  assert.equal(s.snapshot().platform, 'linux'); assert.equal(s.snapshot().gpuId, 'rocco'); assert.equal(s.snapshot().plan.fiveHour.percent, 5);
  // cached: asking again fetches nothing
  ids.forEach((id) => s.want(id)); await s.flush();
  assert.equal(calls.filter((c) => c.startsWith('/prices')).length, 3);
  // subscribing starts one 60 s refresh; the last unsubscribe stops it
  const off1 = s.subscribe(() => {}), off2 = s.subscribe(() => {});
  assert.equal(timers.intervals.size, 1); assert.equal([...timers.intervals.values()][0].ms, 60000);
  await s.refresh();
  assert.equal(calls.filter((c) => c.startsWith('/prices')).length, 6);
  off1(); assert.equal(timers.intervals.size, 1); off2(); assert.equal(timers.intervals.size, 0);
  // an id the host would reject is never requested
  s.want('not a price id'); s.want('x/' + 'a'.repeat(200)); await s.flush();
  assert.equal(s.wantedCount(), 120);
});
test('chip store: a failed request keeps the last answer and is retried by the next refresh', async () => {
  let fail = false; let n = 0;
  const fetchJson = async (p) => {
    if (p.startsWith('/prices')) { n++; if (fail) throw new Error('down'); return { models: { 'a/b': { billing: 'free', priced: true } } }; }
    return {};
  };
  const s = t.createChipStore(fetchJson, fakeTimers());
  s.want('a/b'); await s.flush();
  assert.equal(s.snapshot().prices.get('a/b').billing, 'free');
  fail = true; await s.refresh();
  assert.equal(s.snapshot().prices.get('a/b').billing, 'free', 'kept');
  fail = false; await s.refresh();
  assert.equal(n, 3);
});

// ---- the generated data ----
test('icons: client.js carries exactly the data of lib/icons-data.mjs between its markers', () => {
  const a = SRC.indexOf(BEGIN), b = SRC.indexOf(END);
  assert.ok(a > 0 && b > a);
  const lineStart = SRC.lastIndexOf('\n', a) + 1;
  assert.equal(SRC.slice(lineStart, b + END.length), clientBlock({ FAMILY_LOGOS, GLYPHS }));
  assert.deepEqual(Object.keys(GLYPHS), Object.keys(GLYPH_FILES));
  assert.ok(SRC.includes('@lobehub/icons-static-svg@1.102.0') && SRC.includes('@phosphor-icons/core@2.1.1'));
});
test('icons: data is plain paths and linear gradients; nothing that can run or load', () => {
  const blob = JSON.stringify({ FAMILY_LOGOS, GLYPHS });
  assert.doesNotMatch(blob, /<|script|javascript:|href|onerror|onload|url\(http|data:/i);
  for (const ic of [...Object.values(FAMILY_LOGOS), ...Object.values(GLYPHS)]) {
    assert.match(ic.viewBox, /^[\d.\s-]+$/);
    const ids = new Set((ic.defs || []).map((g) => g.id));
    for (const p of ic.paths) {
      assert.match(p.d, /^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/);
      const ref = /^url\(#(g\d+)\)$/.exec(p.fill);
      assert.ok(ref ? ids.has(ref[1]) : /^(#[0-9a-fA-F]{3,8}|currentColor|[a-z]+)$/.test(p.fill), p.fill);
    }
  }
  // Phosphor glyphs are monochrome (they follow the chip's colour)
  for (const g of Object.values(GLYPHS)) for (const p of g.paths) assert.equal(p.fill, 'currentColor');
});
test('icon builder rejects <script, on…= attributes, javascript:, links and unknown elements', () => {
  const svg = (inner, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${attrs}>${inner}</svg>`;
  const p = '<path d="M0 0L1 1z"/>';
  assert.equal(convertSvg('ok', svg(p)).paths.length, 1);
  for (const bad of [svg(p + '<script>alert(1)</script>'), svg(p, ' onload="x()"'), svg('<path onclick="x" d="M0 0z"/>'), svg('<a href="javascript:alert(1)">' + p + '</a>'), svg(p + '<style>*{}</style>'),
    svg('<image href="https://x/y.png"/>'), svg('<foreignObject/>'), svg('<use href="#a"/>'), svg('<circle r="1"/>'), svg('<path d="M0 0z" fill="url(#nope)"/>'), svg('<path d="alert(1)"/>')]) {
    assert.throws(() => convertSvg('bad', bad), undefined, bad);
  }
  assert.throws(() => assertSafe('x', 'javascript:foo'));
  const grad = convertSvg('g', svg('<defs><linearGradient id="A" x1="0%" x2="100%" y1="0%" y2="50%"><stop stop-color="#fff"/><stop offset=".5" stop-color="#000" stop-opacity="0"/></linearGradient></defs><path d="M0 0L1 1z" fill="url(#A)"/>'));
  assert.deepEqual(J(grad.defs), [{ id: 'g0', x1: '0%', y1: '0%', x2: '100%', y2: '50%', stops: [{ o: '0', c: '#fff' }, { o: '.5', c: '#000', a: '0' }] }]);
  assert.equal(grad.paths[0].fill, 'url(#g0)');
});
test('the picker adds no network call besides the host and no hardcoded colour outside the icon data', () => {
  const block = SRC.slice(SRC.indexOf('// ---------------- model picker'), SRC.indexOf('// ---------------- styles'));
  assert.ok(!/https?:\/\//.test(block));
  assert.deepEqual(block.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.ok(!/\bfetch\(/.test(block), 'only the injected getJson (the host, with its header) is used');
});

test('second line is one line: nowrap, overflow hidden, ellipsis', () => {
  const rule = SRC.split('\n').find((l) => l.includes('.dshMh-ml-line{'));
  for (const want of ['white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis']) assert.ok(rule.includes(want), want);
});
test('chip store: two overlapping loads keep every id either one cached', async () => {
  const gates = {};
  const fetchJson = (p) => {
    if (!p.startsWith('/prices')) return Promise.resolve({});
    const ids = decodeURIComponent(p.split('=')[1]).split(',');
    return new Promise((res) => { gates[ids[0]] = () => res({ models: Object.fromEntries(ids.map((i) => [i, { billing: 'free', priced: true }])) }); });
  };
  const s = t.createChipStore(fetchJson, fakeTimers());
  s.want('a/one'); const l1 = s.flush();
  s.want('b/two'); const l2 = s.flush();
  await new Promise((r) => setImmediate(r));
  gates['b/two'](); await l2;      // the later load finishes first...
  gates['a/one'](); await l1;      // ...then the earlier one must not drop it
  assert.deepEqual([...s.snapshot().prices.keys()].sort(), ['a/one', 'b/two']);
});

// ---- contract with rocco-agents: the four prices.json row shapes for a gateway on a loopback base URL ----
test('prices.json contract: metered with rates, local, metered without rates, and no row for a :cloud id', async () => {
  const { normalizeOverrides, priceFor } = await import('../cost/prices.mjs');
  const overrides = normalizeOverrides({
    'rocco-gateway/paid-model': { inPerM: 0.3, outPerM: 1.2, billing: 'metered' },
    'rocco-gateway/local-model': { inPerM: 0, outPerM: 0, billing: 'local' },
    'rocco-gateway/mystery-model': { billing: 'metered' },
  });
  const table = { entries: {}, overrides };
  const opts = { baseURL: 'http://127.0.0.1:4110/v1', at: Date.UTC(2026, 10, 14, 15) };
  const kind = (id) => { const e = priceFor(table, 'rocco-gateway', id, opts); return t.chipKind({ ...e, priced: e.source !== 'unpriced' }, 'rocco-gateway', ''); };
  assert.equal(kind('paid-model'), 'metered');
  assert.equal(kind('local-model'), 'mac');
  assert.equal(kind('mystery-model'), 'unpriced');
  assert.equal(kind('glm-5.2:cloud'), 'metered');
  const m = priceFor(table, 'rocco-gateway', 'mystery-model', opts);
  assert.deepEqual([m.billing, m.source], ['metered', 'unpriced']);
  // only the exact form is accepted: other billings, or partial rates, are not "price unknown"
  const w = [];
  assert.deepEqual(Object.keys(normalizeOverrides({ 'a/b': { billing: 'free' }, 'a/c': { billing: 'metered', inPerM: 1 }, 'a/d': { billing: 'metered', outPerM: 'x' } }, w)), []);
  assert.equal(w.length, 3);
});
