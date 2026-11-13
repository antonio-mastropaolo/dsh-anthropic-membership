// Smoke test: the client bundle registers under the package id with fake slots; no DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

test('client.js loads under dsh-model-hub and registers its five slots', () => {
  let mod;
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  assert.equal(mod.id, JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', 'package.json'), 'utf8')).name);
  const stub = () => ({});
  const m = mod.factory((n) => (n === 'react' ? new Proxy({}, { get: () => stub }) : n === 'react/jsx-runtime' ? { jsx: stub, jsxs: stub } : { FishLogo: stub }));
  const names = [];
  m.apply({ slots: { inject: (n, cb) => { names.push(n); cb(); }, register: () => {} } });
  assert.deepEqual(names.sort(), ['conversation.chat.turnTail', 'conversation.composer.dock', 'conversation.view', 'settings.models.footer', 'settings.models.provider-card']);
  assert.equal(JSON.stringify(m.inject), '["slots","sessions"]');
});

test('client.js sends only the model-hub header and never the legacy one', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('x-dsh-model-hub'));
  assert.ok(!src.includes('x-dsh-membership'));
  assert.ok(!src.includes('/login'));
});

function loadHelpers(extra = {}) {
  let mod;
  // URL is a browser global the client relies on; a bare vm context does not have it
  const sandbox = { URL, ...extra, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const stub = () => ({});
  const m = mod.factory((n) => (n === 'react' ? new Proxy({}, { get: () => stub }) : n === 'react/jsx-runtime' ? { jsx: stub, jsxs: stub } : { FishLogo: stub }));
  return m._test;
}

test('provider icons: all marks present, aliases resolve, unknown has no mark', () => {
  const t = loadHelpers();
  for (const k of ['anthropic', 'openai-codex', 'github-copilot', 'openrouter', 'xai', 'rocco', 'nvidia', 'mac', 'google', 'dashscope', 'ollama', 'deepseek']) {
    assert.ok(t.ICONS[k] && t.ICONS[k].vb && t.ICONS[k].p.length, k);
  }
  assert.equal(t.iconKey('openai'), 'openai-codex');
  assert.equal(t.iconKey('gemini'), 'google');
  assert.equal(t.iconKey('google/gemini-4-argon'), 'google');
  assert.equal(t.iconKey('nearai'), 'neutral');
  assert.equal(t.iconKey('abliteration'), 'neutral');
  assert.equal(t.iconKey('totally-new'), null);
  assert.ok(fs.readFileSync(file, 'utf8').includes('@lobehub/icons-static-svg@1.102.0'));
});

test('account errors are one human line, raw text stays out', () => {
  const t = loadHelpers();
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'revoked' }), 'Sign-in was revoked or replaced. Sign in again.');
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'rejected', terminal: true }), 'The provider rejected the saved sign-in. Sign in again. Automatic retries paused.');
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'unreachable' }), "Couldn't reach the provider. Retrying automatically.");
  const other = t.humanizeError({ lastError: 'refresh failed: status=400 url=https:[redacted] body={"error": "invalid_grant",' });
  assert.ok(!/body=|url=|\{/.test(other) && !other.includes('\n'), other);
  assert.equal(t.humanizeError({}), '');
});

test('account sublines', () => {
  const t = loadHelpers();
  assert.equal(t.acctSubline({ health: 'ok', signedIn: true, expiresInMs: 4.2 * 3600000 }), 'Signed in · renews in 4.2 h');
  assert.equal(t.acctSubline({ health: 'expired', signedIn: true, expiresInMs: -53 * 86400000 }), 'Expired 53 d ago');
  assert.equal(t.acctSubline({ health: 'missing', signedIn: false }), 'Not signed in');
  assert.ok(t.isAvailable({ health: 'missing' }) && !t.isAvailable({ health: 'ok' }));
});

test('rocco helpers: idle gpu, stale line, lease error', () => {
  const t = loadHelpers();
  assert.ok(t.gpuIdle({ processes: [], used_mib: 600 }));
  assert.ok(!t.gpuIdle({ processes: [{}], used_mib: 600 }));
  assert.ok(!t.gpuIdle({ processes: [], used_mib: 20000 }));
  assert.equal(t.staleLine([{ owner: 'flash-next-uncensored', gpus: [0, 1, 2, 3], stale: true }], 4), 'Stale reservation flash-next-uncensored (all GPUs): container gone. Shown only, never deleted.');
  assert.equal(t.staleLine([{ owner: 'a', gpus: [0], stale: false }], 4), '');
  assert.ok(t.isLeaseError({ status: 409, message: 'Conflict' }));
  assert.ok(t.isLeaseError(new Error('lease held for 300 s')));
  assert.ok(!t.isLeaseError(new Error('boom')));
  assert.equal(t.errStr({ detail: { error: 'nope' } }), 'nope');
});

test('spend view merges the external meter into the headline', () => {
  const t = loadHelpers();
  const v = t.spendView({ totals: { usd: 0, calls: 12 }, byProvider: { rocco: { usd: 0, calls: 12 } }, external: { source: 'meter', totals: { usd: 5.42, calls: 40 }, byProvider: { nearai: { usd: 5.42, calls: 40 } } } });
  assert.equal(v.usd, 5.42);
  assert.equal(v.calls, 52);
  assert.equal(v.sub, 'DSH $0.00 · 12 calls · Meter $5.42 · 40 calls');
  assert.equal(JSON.stringify(v.rows.map((r) => [r.k, r.meter])), JSON.stringify([['nearai', true], ['rocco', false]]));
  assert.equal(t.spendView({ totals: { usd: 1, calls: 2 }, byProvider: {}, external: null }).sub, '');
});

test('prices: format, normalize, dedupe, group, 402; no model is hidden by name', () => {
  const t = loadHelpers();
  assert.equal(t.fmtPm(0.75), '$0.75');
  assert.equal(t.fmtPm(3.75), '$3.75');
  assert.equal(t.fmtPm(0.075), '$0.075');
  assert.equal(t.fmtPm(3), '$3.00');
  assert.equal(t.normPriceId('rocco/mac-qwen38-q4', 'rocco'), 'mac/mac-qwen38-q4');
  assert.equal(t.normPriceId('openrouter/mac-foo', 'rocco'), 'openrouter/mac-foo', 'only the configured GPU server is relabelled');
  assert.equal(t.normPriceId('rocco/mac-qwen38-q4', null), 'rocco/mac-qwen38-q4');
  const r = t.groupPrices({
    'google/gemini-3.8-flash': { priced: true, billing: 'metered', inPerM: 0.75, outPerM: 3.75, cacheReadPerM: 0.075 },
    'ollama/glm-5.3-flash': { priced: false, billing: 'metered' },
    'rocco/rocco-qwen38-q4': { priced: true, billing: 'local' },
    'mac/mac-qwen38-q4': { priced: true, billing: 'local' },
    'rocco/mac-qwen38-q4': { priced: true, billing: 'local' },
    'anthropic/claude-opus-5': { priced: true, billing: 'metered', inPerM: 1, outPerM: 1 },
    'anthropic/claude-opus-5-5': { priced: true, billing: 'metered', inPerM: 5, outPerM: 25 },
  }, { google: { code: 402, message: 'no credit' } }, 'rocco');
  assert.equal(r.rows.find((x) => x.id === 'google/gemini-3.8-flash').line, '$0.75 in · $3.75 out · $0.075 cache');
  assert.ok(r.rows.find((x) => x.id === 'google/gemini-3.8-flash').noCredit);
  assert.equal(r.rows.find((x) => x.id === 'ollama/glm-5.3-flash').kind, 'unpriced');
  assert.ok(r.rows.some((x) => x.id === 'anthropic/claude-opus-5'), 'no hardcoded retired-model filter');
  assert.ok(r.rows.some((x) => x.id === 'anthropic/claude-opus-5-5'));
  assert.equal(JSON.stringify(r.groups), JSON.stringify([{ label: 'Local', items: ['rocco-qwen38-q4', 'mac-qwen38-q4'] }]));
  const r2 = t.groupPrices({ 'openrouter/x': { priced: true, billing: 'metered', inPerM: 1, outPerM: 2 } }, { openrouter: { code: 429, message: 'quota' } });
  assert.equal(r2.rows[0].info.code, 429);
  assert.ok(r2.rows[0].noCredit);
});

test('spendView splits the DSH and meter captions onto separate lines and exposes the meter total', () => {
  const t = loadHelpers();
  const v = t.spendView({ totals: { usd: 0, calls: 12 }, byProvider: {}, external: { source: 'meter', totals: { usd: 5.42, calls: 40 }, byProvider: { nearai: { usd: 5.42, calls: 40 } } } });
  assert.equal(JSON.stringify(v.subLines), JSON.stringify(['DSH $0.00 · 12 calls', 'Meter $5.42 · 40 calls']));
  assert.equal(v.extUsd, 5.42);
  assert.equal(t.spendView({ totals: { usd: 1, calls: 2 }, byProvider: {}, external: null }).subLines.length, 0);
});

test('sign-in flow renders select prompts (e.g. Anthropic login method) as option buttons, not a text box', () => {
  const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  // the Anthropic flow first asks "Select Anthropic login method:" with options browser / copy_code;
  // a free-text box there left the flow stuck forever (2026-11-08)
  assert.match(src, /Array\.isArray\(s\.prompt\.options\)/);
  assert.match(src, /answer\(String\(o\.id/);
});

function loadWithReact(reactStub, domStub, globals = {}) {
  let mod;
  const sandbox = { ...globals, window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? reactStub : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : n === 'react-dom' ? (domStub || {}) : { FishLogo: () => ({}) }))._test;
}
const texts = (n, out = []) => {
  if (n === null || n === undefined || typeof n === 'boolean') return out;
  if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => texts(x, out)); return out; }
  if (n.props) { texts(n.props.children, out); if (n.type && n.type.name === 'ProviderIcon') out.push('icon:' + n.props.provider); }
  return out;
};
const fakeReact = { useState: (i) => [i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useCallback: (f) => f };

test('GPU panel title and icon come from the config; hidden when not configured', () => {
  const t = loadWithReact(fakeReact);
  const out = texts(t.GpuServerPanel({ cfg: { configured: true, id: 'lab', name: 'Lab box', icon: 'nvidia' } }));
  assert.ok(out.includes('Lab box GPUs'), out.join('|'));
  assert.ok(out.includes('icon:nvidia'));
  assert.ok(!out.some((x) => /rocco/i.test(x)));
  assert.ok(texts(t.GpuServerPanel({ cfg: { configured: true, id: 'x', icon: 'google' } })).includes('GPU server GPUs'));
  assert.ok(texts(t.GpuServerPanel({ cfg: { configured: true, id: 'x', name: 'N', icon: 'google' } })).includes('icon:google'));
  assert.equal(t.GpuPanel(), null); // /gpu/config not loaded or not configured -> nothing rendered
});

test('GPU helpers: title, icon fallback, model filtering and default model (no hardcoded model)', () => {
  const t = loadHelpers();
  assert.equal(t.gpuTitle({ name: 'Box' }), 'Box GPUs');
  assert.equal(t.gpuTitle({}), 'GPU server GPUs');
  assert.equal(t.gpuIconKey('google'), 'google');
  assert.equal(t.gpuIconKey('no-such-mark'), 'nvidia');
  assert.equal(t.gpuIconKey(undefined), 'nvidia');
  const ms = [{ id: 'a', loaded: false, owner: 'box' }, { id: 'b', loaded: true, owner: 'box' }, { id: 'm', loaded: true, owner: 'mac' }, { id: 'z', loaded: false, owner: 'other' }];
  assert.deepEqual(t.gpuServerModels(ms, { id: 'box' }).map((m) => m.id), ['a', 'b']);
  assert.deepEqual(t.gpuServerModels(ms, { id: 'nomatch' }).map((m) => m.id), ['a', 'b', 'z']);
  // price rows: defaultModel + loaded models + Mac copies, never the whole roster
  const roster = [{ id: 'a', loaded: false, owner: 'box' }, { id: 'b', loaded: true, owner: 'box' }, { id: 'c', loaded: false, owner: 'box' }, { id: 'mq', loaded: true, owner: 'mac' }];
  assert.equal(JSON.stringify(t.gpuPriceIds(roster, { id: 'box', defaultModel: 'c' })), JSON.stringify(['box/c', 'box/b', 'mac/mq']));
  assert.equal(JSON.stringify(t.gpuPriceIds(roster.map((m) => ({ ...m, loaded: false })), { id: 'box' })), JSON.stringify(['box/a', 'mac/mq']));
  assert.equal(t.gpuPriceIds(roster, null).length, 0);
  // hideModels are literal substrings (a regex-looking entry matches only literally)
  assert.deepEqual(t.gpuServerModels(ms, { id: 'box', hideModels: ['a'] }).map((m) => m.id), ['b']);
  assert.deepEqual(t.gpuServerModels([{ id: 'x.y', owner: 'box' }, { id: 'xzy', owner: 'box' }], { id: 'box', hideModels: ['x.y'] }).map((m) => m.id), ['xzy']);
  assert.equal(t.defaultGpuModel(t.gpuServerModels(ms, { id: 'box' }), null), 'b');
  assert.equal(t.defaultGpuModel(t.gpuServerModels(ms, { id: 'box' }), 'a'), 'a');
  assert.equal(t.defaultGpuModel([{ id: 'q', loaded: false }, { id: 'r', loaded: false }], null), 'q');
  assert.equal(t.defaultGpuModel([{ id: 'q', loaded: false }, { id: 'r', loaded: false }], null, 'r'), 'r', 'configured defaultModel wins when nothing is loaded');
  assert.equal(t.defaultGpuModel([{ id: 'q', loaded: false }, { id: 'r', loaded: false }], 'q', 'r'), 'q', 'a loaded model still wins');
  assert.equal(t.defaultGpuModel([{ id: 'q', loaded: false }], null, 'gone'), 'q');
  assert.equal(t.defaultGpuModel([], 'x'), '');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('rocco-qwen38-q4'));
});

test('price list keeps every configured priceModel (up to 50) and fills the rest', () => {
  const t = loadHelpers();
  const pm = Array.from({ length: 30 }, (_, i) => `p/m${i}`);
  const seen = Array.from({ length: 40 }, (_, i) => `s/m${i}`);
  const out = t.priceList(['gpu/a', 'gpu/b'], pm, seen);
  assert.equal(out.length, 50);
  for (const m of pm) assert.ok(out.includes(m), m);
  assert.deepEqual(JSON.parse(JSON.stringify(out.slice(0, 3))), ['gpu/a', 'gpu/b', 'p/m0']);
  assert.equal(JSON.stringify(t.priceList([], [], [])), '[]');
});

test('instance check: 127.0.0.1 and localhost on the same port are one instance; another port is not', () => {
  const t = loadHelpers();
  assert.ok(t.sameInstance('http://127.0.0.1:3080', 'http://localhost:3080'));
  assert.ok(t.sameInstance('http://localhost:3080', 'http://localhost:3080'));
  assert.ok(!t.sameInstance('http://127.0.0.1:3080', 'http://127.0.0.1:3290'));
  assert.ok(!t.sameInstance('http://127.0.0.1:3080', 'https://127.0.0.1:3080'));
  assert.ok(t.sameInstance('not a url', 'http://127.0.0.1:3080'), 'unparseable: no false alarm');
});

test('the client keeps exactly the server\'s provider/model pattern and drops ids the host would reject', async () => {
  const t = loadHelpers();
  const { PRICE_ID_RE } = await import('../cost/prices.mjs');
  assert.equal(t.PRICE_ID_SRC, PRICE_ID_RE.source);
  const out = t.priceList([], ['ok/model', 'bad id', 'p/' + 'm'.repeat(119)], ['openrouter/vendor/x']);
  assert.equal(JSON.stringify(out), '["ok/model","openrouter/vendor/x"]');
});

test('a change is sent only after the hub positively reports this page\'s instance (checked per request)', async () => {
  let owner = null;
  const posts = [];
  const fetch = async (u, init) => {
    if (String(u).endsWith('/healthz')) return { ok: true, json: async () => ({ ok: true, webOrigin: owner }) };
    posts.push(String(u));
    return { ok: true, json: async () => ({}) };
  };
  const t = loadHelpers({ fetch, location: { origin: 'http://127.0.0.1:3290' } });
  // owner not known yet (hub still booting): refused, nothing posted
  await assert.rejects(t.postJson('/accounts/refresh', {}), /has not reported/);
  // another instance owns the hub: refused, nothing posted
  owner = 'http://127.0.0.1:3080';
  await assert.rejects(t.postJson('/accounts/refresh', {}), /changes are disabled here/);
  assert.equal(posts.length, 0);
  // this instance, under its localhost twin: sent
  owner = 'http://localhost:3290';
  await t.postJson('/accounts/refresh', {});
  assert.equal(posts.length, 1);
  // and the check runs again for every request: ownership changing back is caught
  owner = 'http://127.0.0.1:3080';
  await assert.rejects(t.postJson('/gpu/unload', {}), /changes are disabled here/);
  assert.equal(posts.length, 1);
});

test('a GPU server whose id is "mac" keeps its own models; the mac-copy exclusion is only a fallback', () => {
  const t = loadHelpers();
  const ms = [{ id: 'model-a', owner: 'mac' }, { id: 'model-b', owner: 'mac' }];
  assert.equal(JSON.stringify(t.gpuServerModels(ms, { id: 'mac' }).map((m) => m.id)), '["model-a","model-b"]');
  assert.equal(JSON.stringify(t.gpuServerModels([...ms, { id: 'z', owner: 'other' }], { id: 'nomatch' }).map((m) => m.id)), '["z"]');
});

test('spendView marks an incomplete ledger read as partial instead of a normal total', () => {
  const t = loadHelpers();
  const v = t.spendView({ totals: { usd: 2, calls: 3 }, byProvider: {}, external: null, complete: false });
  assert.equal(v.partial, true);
  assert.ok(v.subLines.some((l) => /partial/.test(l)));
  const ok = t.spendView({ totals: { usd: 2, calls: 3 }, byProvider: {}, external: null, complete: true });
  assert.equal(ok.partial, false);
  assert.deepEqual([...ok.subLines], []);
});

test('only an https sign-in page is opened or linked', () => {
  const t = loadHelpers();
  assert.equal(t.signInUrl('https://claude.ai/oauth/authorize?x=1'), 'https://claude.ai/oauth/authorize?x=1');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/', 'file:///etc/passwd', ' https://x', '', null, 5]) assert.equal(t.signInUrl(bad), null, String(bad));
});

test('the Claude plan card (design C) shows ring gauges and the DSH counts, and leaves the counts out when unknown', () => {
  const t = loadWithReact(fakeReact);
  const plan = { mode: 'plan', fiveHour: { percent: 12, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, sevenDay: { percent: 84, resetsAt: new Date(Date.now() + 86400e3).toISOString() } };
  const labels = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => labels(x, out)); return out; } if (n.props) { if (n.props['aria-label']) out.push(n.props['aria-label']); labels(n.props.children, out); } if (n.type && typeof n.type === 'function' && n.props) labels(n.type(n.props), out); return out; };
  const tree = t.planBody({ ...plan, messages: 13, modelCalls: 29 });
  const shown = texts(tree).join('|');
  assert.match(shown, /Messages from DSH\|13/);
  assert.match(shown, /Model calls from DSH\|29/);
  assert.match(shown, /5-hour window/);
  assert.match(shown, /12%\|used/);
  assert.match(labels(tree).join('|'), /Claude 5-hour window: 12% used/, 'the ring states its value for screen readers');
  const unknown = texts(t.planBody({ ...plan, messages: null, modelCalls: null })).join('|');
  assert.ok(!/from DSH/.test(unknown), 'unknown counts are left out, never 0');
  assert.match(texts(t.planBody({ mode: 'api' })).join('|'), /API key/);
});

test('ring dash: empty at 0, at least 1% when used, full when over', () => {
  const t = loadHelpers();
  const c = (2 * Math.PI * 6).toFixed(2);
  assert.equal(t.ringDash(6, 0), '0.00 ' + c);
  assert.equal(t.ringDash(6, 100), c + ' ' + c);
  assert.ok(parseFloat(t.ringDash(6, 0.2)) > 0, 'a tiny value still shows');
});

const J = (x) => JSON.parse(JSON.stringify(x)); // values from the client's VM realm: compare as data

test('dock chip: "Today" is DSH spend only (the meter stays in the tooltip); cache waits for a second step; a reached cap closes the ring', () => {
  const t = loadHelpers();
  const plan = { mode: 'plan', fiveHour: { percent: 0, resetsAt: null }, sevenDay: { percent: 8 } };
  const spend = { totals: { usd: 0, calls: 14 }, caps: { action: 'ok', reason: 'within caps', todayUsd: 0, limits: { dailyUsd: 40 } }, external: { totals: { usd: 1.7, calls: 287 } } };
  const m = t.chipModel(plan, spend, { latest: { steps: 1, lastHit: 0 } });
  assert.equal(m.today.text, '$0.00', 'not $1.70: the extra meter ledger is outside DSH');
  assert.match(m.today.title, /Outside DSH \(extra ledger, not capped\): \$1\.70/);
  assert.equal(m.cache.text, '—', 'the first step cannot hit the cache');
  assert.equal(t.chipModel(plan, spend, { latest: { steps: 3, lastHit: 0.61, avgHit: 0.5 } }).cache.text, '61%');
  const blocked = t.chipModel(plan, { ...spend, caps: { ...spend.caps, action: 'block', todayUsd: 41 } }, null);
  assert.equal(blocked.today.text, 'Cap reached');
  assert.equal(blocked.today.ring, 'over');
  const partial = t.chipModel(plan, { ...spend, complete: false }, null);
  assert.equal(partial.today.text, '≥$0.00');
  assert.equal(partial.today.tone, 'warn');
  assert.equal(t.chipModel({ mode: 'expired' }, spend, null).claude.tone, 'danger');
});

test('spend rows keep each provider\'s billing kind and list the extra meter separately', () => {
  const t = loadHelpers();
  const r = t.spendRows({ byProvider: { anthropic: { usd: 0, apiEquivUsd: 0.95, calls: 14, billing: 'subscription' }, google: { usd: 0.4, apiEquivUsd: 0.4, calls: 2, billing: 'metered' } }, external: { byProvider: { nearai: { usd: 1.7, calls: 287 } } } });
  assert.deepEqual(J(r.inDsh.map((x) => [x.k, x.billing])), [['google', 'metered'], ['anthropic', 'subscription']]);
  assert.deepEqual(J(r.outside.map((x) => [x.k, x.usd])), [['nearai', 1.7]]);
  assert.deepEqual(J(t.spendRows(null)), { inDsh: [], outside: [] });
});

test('price table: one row per model with its billing kind, unpriced last, no $ sign in the cells', () => {
  const t = loadHelpers();
  const rows = t.priceTable({
    'ollama/glm-5.3-flash': { priced: false, billing: 'metered' },
    'rocco/rocco-qwen38-q4': { priced: true, billing: 'local', inPerM: 0, outPerM: 0 },
    'google/gemini-3.8-flash': { priced: true, billing: 'metered', inPerM: 0.75, outPerM: 3.75, cacheReadPerM: 0.075 },
    'anthropic/claude-opus-5-5': { priced: true, billing: 'subscription', inPerM: 4, outPerM: 20, cacheReadPerM: 0.2 },
  }, { google: { code: 402, message: 'no credit' } }, 'rocco');
  assert.deepEqual(J(rows.map((r) => r.kind)), ['subscription', 'metered', 'local', 'unpriced']);
  const g = rows.find((r) => r.id === 'google/gemini-3.8-flash');
  assert.deepEqual(J([g.in, g.out, g.cache, g.noCredit]), ['0.75', '3.75', '0.075', true]);
  assert.deepEqual(J([rows[3].in, rows[3].model]), ['—', 'glm-5.3-flash']);
});

test('overview tiles: DSH spend vs cap, API value, then the GPU server (or the Claude window without one)', () => {
  const t = loadHelpers();
  const spend = { totals: { usd: 0, apiEquivUsd: 0.95, calls: 14 }, caps: { todayUsd: 0, limits: { dailyUsd: 40 } } };
  const gpus = { gpus: [{ index: 0, used_mib: 0, processes: [] }, { index: 1, used_mib: 36000, processes: [{ user: 'u' }] }], loaded_model: null };
  const tiles = t.overviewTiles(spend, null, { configured: true, id: 'lab', name: 'Lab box' }, gpus);
  assert.deepEqual(J(tiles.map((x) => [x.label, x.value])), [['DSH spend today', '$0.00'], ['API-list value today', '$0.95'], ['Lab box GPUs', '1 of 2 free']]);
  const noGpu = t.overviewTiles(spend, { mode: 'plan', fiveHour: { percent: 12, resetsAt: null } }, { configured: false }, null);
  assert.equal(noGpu[2].label, 'Claude 5-hour window');
  assert.equal(noGpu[2].value, '12%');
});

test('the Costs card renders caps, billing kinds and the outside-DSH meter from the spend payload', () => {
  const t = loadWithReact(fakeReact);
  const today = { data: {
    totals: { usd: 0, apiEquivUsd: 0.95, calls: 14 }, complete: true,
    byProvider: { anthropic: { usd: 0, apiEquivUsd: 0.95, calls: 14, billing: 'subscription' } },
    caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
    external: { totals: { usd: 1.7, calls: 287 }, byProvider: { nearai: { usd: 1.7, calls: 287 } } },
  }, error: null };
  // expand child components (Meter, Pill, ProviderIcon) the way React would, then collect the text
  const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
  const out = texts(expand(t.CostsPanel({ today, gcfg: null }))).join('|');
  for (const want of ['Within caps', 'Daily cap', '$0.00 of $40.00', 'Session cap', '$0.00 of $15.00', 'Subscription', 'nearai', 'Outside DSH · extra ledger, not capped', '$1.70', 'Meter']) assert.ok(out.includes(want), want + ' in ' + out);
});

test('styles use DSH tokens only: no hardcoded colours outside the icon table, no token DSH does not define', () => {
  const src = fs.readFileSync(file, 'utf8');
  const noIcons = src.replace(/const ICONS = \{[\s\S]*?\n    \};/, '');
  assert.deepEqual(noIcons.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  assert.ok(!/--dsw-alias-bg-primary\b/.test(src), 'DSH defines bg-base / bg-layer-*, not bg-primary');
});

test('plan rows: used of included, reset date, overage; chip gets a ring segment per plan', () => {
  const t = loadHelpers();
  const d = { plans: [{ provider: 'ollama', name: 'Pro', includedUsd: 60, usedUsd: 15, overageUsd: 0, resetsAt: '2026-12-09T00:00:00.000Z', complete: true },
    { provider: 'acme', name: 'Max', includedUsd: 10, usedUsd: 10, overageUsd: 2.5, resetsAt: '2026-12-09T00:00:00.000Z', complete: false }] };
  const [a, b] = t.planRows(d);
  assert.equal(a.label, 'Ollama Pro · resets Dec 9'); assert.equal(a.value, '$15.00 of $60.00'); assert.equal(a.pct, 25); assert.equal(a.tone, 'accent');
  assert.equal(b.value, '$12.50 of $10.00'); assert.equal(b.tone, 'danger'); assert.equal(b.over, 2.5); assert.equal(b.partial, true);
  assert.deepEqual(J(t.planRows(null)), []);
  const m = t.chipModel(null, { caps: { action: 'ok', reason: 'ok', todayUsd: 0, limits: { dailyUsd: 40 } }, totals: { usd: 0, calls: 0 }, plans: d.plans }, null);
  assert.deepEqual(J(m.plans.map((p) => [p.key, p.text, p.ring])), [['ollama', '25%', 'ok'], ['acme', '100%', 'over']]);
  assert.deepEqual(J(t.chipModel(null, null, null).plans), []);
});

test('the Costs card renders a credits pill, a plan row with its meter, and the declared label', () => {
  const t = loadWithReact(fakeReact);
  const today = { data: {
    totals: { usd: 0, apiEquivUsd: 1.2, calls: 3 }, complete: true,
    byProvider: { ollama: { usd: 0, apiEquivUsd: 1.2, calls: 3, billing: 'credits' }, zai: { usd: 0, apiEquivUsd: 0.5, calls: 1, billing: 'subscription' } },
    caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
    plans: [{ provider: 'ollama', name: 'Pro', includedUsd: 60, usedUsd: 1.2, overageUsd: 0, remainingUsd: 58.8, resetsAt: '2026-12-09T00:00:00.000Z', complete: true }],
  }, error: null };
  const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
  const out = texts(expand(t.CostsPanel({ today, gcfg: null }))).join('|');
  for (const want of ['Credits', 'Ollama Pro · resets Dec 9', '$1.20 of $60.00']) assert.ok(out.includes(want), want + ' in ' + out);
  // declared label comes from /hub/config subscriptions (a pure helper here, the poll is a hook)
  const pill = t.billingPill('subscription', 'zai', ['zai']);
  assert.equal(pill.props.children, 'Subscription · declared'); assert.match(pill.props.title, /Declared in config\.json/);
  assert.equal(t.billingPill('subscription', 'anthropic', ['zai']).props.children, 'Subscription');
});

test('identity line: "<email> · <plan> · <org>", name fallback, and "account not reported" when nothing is known', () => {
  const t = loadHelpers();
  assert.equal(t.identityLine({ email: 'a@x.io', plan: 'Max 20x', org: null }), 'a@x.io · Max 20x');
  assert.equal(t.identityLine({ email: 'a@x.io', plan: 'Team', org: 'Acme' }), 'a@x.io · Team · Acme');
  assert.equal(t.identityLine({ name: 'Ann' }), 'Ann');
  assert.equal(t.identityLine(null), 'account not reported');
  assert.equal(t.identityLine({}), 'account not reported');
});

test('the Costs card shows the caps.json problem', () => {
  const t = loadHelpers();
  const p = 'caps.json invalid: not valid JSON; using defaults';
  assert.equal(t.capsProblemLine({ problem: p }), p);
  assert.equal(t.capsProblemLine({ problem: null }), null);
  assert.equal(t.capsProblemLine(null), null);
  assert.equal(t.capsProblemLine(undefined), null);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('"data-testid": "caps-invalid"'), 'banner has its test id');
  assert.ok(src.includes('usePoll("/caps"'), 'banner polls /caps');
  const noIcons = src.replace(/const ICONS = \{[\s\S]*?\n    \};/, '');
  assert.deepEqual(noIcons.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
});

// ---- caps editor (Costs card) ----
import * as capsLib from '../cost/caps.mjs';
const CAPS_VIEW = { caps: { dailyUsd: 40, sessionUsd: 15, warnPct: 50, perProviderDailyUsd: { google: 5 } } };
const expandAll = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expandAll); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expandAll(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expandAll(n.props.children) } } : n; };
const findAll = (n, pred, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => findAll(x, pred, out)); return out; } if (n.props) { if (pred(n)) out.push(n); findAll(n.props.children, pred, out); } return out; };

test('capsDraft/capsChanges: only changed fields are sent; a removed provider row sends null', () => {
  const t = loadHelpers();
  const d = t.capsDraft(CAPS_VIEW);
  assert.deepEqual(J(d), { dailyUsd: '40', sessionUsd: '15', warnPct: '50', providers: [{ id: 'google', usd: '5' }] });
  assert.deepEqual(J(t.capsChanges(d, CAPS_VIEW)), { ok: true, changes: {} });
  assert.deepEqual(J(t.capsChanges({ ...d, dailyUsd: '25' }, CAPS_VIEW)), { ok: true, changes: { dailyUsd: 25 } });
  assert.deepEqual(J(t.capsChanges({ ...d, providers: [] }, CAPS_VIEW)), { ok: true, changes: { 'provider.google': null } });
  assert.deepEqual(J(t.capsChanges({ ...d, providers: [...d.providers, { id: 'xai', usd: '2.5' }] }, CAPS_VIEW)), { ok: true, changes: { 'provider.xai': 2.5 } });
  assert.deepEqual(J(t.capsChanges({ ...d, dailyUsd: '0', warnPct: '80' }, CAPS_VIEW)), { ok: true, changes: { dailyUsd: 0, warnPct: 80 } });
  assert.deepEqual(J(t.capsChanges({ ...d, providers: [...d.providers, { id: '', usd: '' }] }, CAPS_VIEW)), { ok: true, changes: {} }, 'a blank added row is ignored');
  assert.deepEqual(J(t.capsDraft(null)).providers, []);
});

test('capsChanges rejects what the server rejects (parity), with errors keyed per field', () => {
  const t = loadHelpers();
  const base = t.capsDraft(CAPS_VIEW);
  const num = [['', 'dailyUsd'], ['abc', 'dailyUsd'], ['-1', 'dailyUsd'], ['1e3', 'dailyUsd'], ['1000001', 'dailyUsd'], ['NaN', 'dailyUsd'], ['Infinity', 'dailyUsd'], ['0', 'sessionUsd'], ['12.5', 'sessionUsd'],
    ['0', 'warnPct'], ['100', 'warnPct'], ['50.5', 'warnPct'], ['1', 'warnPct'], ['99', 'warnPct'], ['', 'warnPct']];
  for (const [text, field] of num) {
    const r = t.capsChanges({ ...base, [field]: text }, CAPS_VIEW);
    const asNum = text.trim() === '' ? NaN : Number(text);
    const server = capsLib.validateCapsChange({ [field]: asNum });
    assert.equal(r.ok, server.ok, `${field}=${JSON.stringify(text)}`);
    if (!r.ok) { assert.deepEqual(Object.keys(r.errors), [field]); assert.ok(r.errors[field].length > 3); }
  }
  assert.equal(t.capsChanges({ ...base, sessionUsd: '0x10' }, CAPS_VIEW).ok, false, 'hex text is refused (a number input cannot produce it)');
  const ids = [['Google', '1'], ['constructor', '1'], ['__proto__', '1'], ['a'.repeat(41), '1'], ['', '1'], ['-x', '1'], ['ok-1', '1'], ['ok', ''], ['ok', 'abc'], ['ok', '1000001'], ['ok', '-2']];
  for (const [id, usd] of ids) {
    const r = t.capsChanges({ ...base, providers: [{ id, usd }] }, { caps: { ...CAPS_VIEW.caps, perProviderDailyUsd: {} } });
    const server = capsLib.validateCapsChange({ ['provider.' + id]: usd === '' ? NaN : Number(usd) });
    assert.equal(r.ok, server.ok, `provider ${JSON.stringify(id)} ${JSON.stringify(usd)}`);
    if (!r.ok) assert.ok(Object.keys(r.errors).every((k) => /^provider\.0\.(id|usd)$/.test(k)), JSON.stringify(r.errors));
  }
  const dup = t.capsChanges({ ...base, providers: [{ id: 'xai', usd: '1' }, { id: 'xai', usd: '2' }] }, CAPS_VIEW);
  assert.equal(dup.ok, false); assert.ok(dup.errors['provider.1.id']);
  const many = t.capsChanges({ ...base, providers: Array.from({ length: 65 }, (_, i) => ({ id: 'p' + i, usd: '1' })) }, CAPS_VIEW);
  assert.equal(many.ok, false);
  const multi = t.capsChanges({ ...base, dailyUsd: 'x', warnPct: '0' }, CAPS_VIEW);
  assert.deepEqual(Object.keys(multi.errors).sort(), ['dailyUsd', 'warnPct']);
});

test('submitCapsDraft posts {set: changes} through postJson, skips the post when nothing changed, returns the refusal as text', async () => {
  const t = loadHelpers();
  const d = t.capsDraft(CAPS_VIEW);
  const calls = [];
  const post = (p, b) => { calls.push([p, b]); return Promise.resolve({ ok: true }); };
  assert.deepEqual(J(await t.submitCapsDraft({ ...d, dailyUsd: '25' }, CAPS_VIEW, post)), { ok: true });
  assert.deepEqual(J(calls), [['/caps', { set: { dailyUsd: 25 } }]]);
  assert.deepEqual(J(await t.submitCapsDraft(d, CAPS_VIEW, post)), { ok: true });
  assert.equal(calls.length, 1, 'nothing changed: no post');
  const bad = await t.submitCapsDraft({ ...d, dailyUsd: '-1' }, CAPS_VIEW, post);
  assert.equal(bad.ok, false); assert.ok(bad.errors.dailyUsd); assert.equal(calls.length, 1, 'invalid: no post');
  const refuse = await t.submitCapsDraft({ ...d, dailyUsd: '25' }, CAPS_VIEW, () => Promise.reject(new Error('This page is not the DSH instance this hub belongs to.')));
  assert.deepEqual(J(refuse), { ok: false, error: 'This page is not the DSH instance this hub belongs to.' });
  const dflt = t.submitCapsDraft;
  assert.equal(typeof dflt, 'function');
});

test('a corrupt caps.json: Save sends the whole draft so it repairs the file instead of reporting a save that wrote nothing', async () => {
  const t = loadHelpers();
  const bad = { ...CAPS_VIEW, problem: 'caps.json invalid: not valid JSON; using defaults', fatal: true, caps: { dailyUsd: 40, sessionUsd: 15, warnPct: 50, perProviderDailyUsd: {} } };
  const calls = [];
  const post = (p, b) => { calls.push([p, b]); return Promise.resolve({ ok: true }); };
  assert.deepEqual(J(await t.submitCapsDraft(t.capsDraft(bad), bad, post)), { ok: true });
  assert.deepEqual(J(calls), [['/caps', { set: { dailyUsd: 40, sessionUsd: 15, warnPct: 50 } }]], 'unedited Save on a corrupt file posts every field');
  const withRow = { ...bad, caps: { ...bad.caps, perProviderDailyUsd: { google: 5 } } };
  const d = t.capsDraft(withRow);
  assert.deepEqual(J(t.capsChanges(d, withRow)), { ok: true, changes: { dailyUsd: 40, sessionUsd: 15, warnPct: 50, 'provider.google': 5 } });
  const fine = { ...CAPS_VIEW, problem: null, fatal: false };
  assert.deepEqual(J(t.capsChanges(t.capsDraft(fine), fine)), { ok: true, changes: {} }, 'a healthy file still sends only what differs');
  const warnOnly = { ...CAPS_VIEW, problem: 'caps.json invalid: dailyUsd must be a number >= 0; using defaults', fatal: false };
  assert.equal(Object.keys(t.capsChanges(t.capsDraft(warnOnly), warnOnly).changes).length >= 3, true, 'a single bad field is repaired by Save too');
});

test('CapsForm renders labelled number inputs with units, Save/Cancel, aria-invalid + described errors, and disables everything while busy', () => {
  const t = loadWithReact(fakeReact);
  const draft = { dailyUsd: '40', sessionUsd: '', warnPct: '50', providers: [{ id: 'google', usd: '5' }] };
  const noop = () => {};
  const render = (p) => expandAll(t.CapsForm({ draft, errors: {}, busy: false, onChange: noop, onSubmit: noop, onCancel: noop, firstRef: { current: null }, ...p }));
  const tree = render({ errors: { sessionUsd: 'sessionUsd must be a number from 0 to 1000000 (0 = off)' } });
  const out = texts(tree).join('|');
  for (const want of ['Daily cap', 'Session cap', 'Alert at', 'USD per day', 'USD per session', '% of a cap', 'Per-provider daily caps', 'Add provider cap', 'Remove', 'Save', 'Cancel']) assert.ok(out.includes(want), want + ' in ' + out);
  const input = (id) => findAll(tree, (n) => n.type === 'input' && n.props.id === id)[0];
  for (const id of ['dshMh-cap-daily', 'dshMh-cap-session', 'dshMh-cap-warn']) {
    const i = input(id);
    assert.equal(i.props.type, 'number', id);
    assert.ok(findAll(tree, (n) => n.type === 'label' && n.props.htmlFor === id).length === 1, 'label for ' + id);
  }
  assert.equal(input('dshMh-cap-daily').props['aria-invalid'], undefined);
  assert.equal(input('dshMh-cap-session').props['aria-invalid'], 'true');
  const desc = input('dshMh-cap-session').props['aria-describedby'];
  assert.ok(findAll(tree, (n) => n.props.id === desc).length === 1 && texts(findAll(tree, (n) => n.props.id === desc)).join('').includes('must be a number'));
  assert.equal(input('dshMh-cap-daily').props['aria-describedby'], undefined);
  const form = findAll(tree, (n) => n.type === 'form')[0];
  assert.equal(findAll(tree, (n) => n.type === 'fieldset')[0].props.disabled, false);
  const busy = render({ busy: true });
  assert.equal(findAll(busy, (n) => n.type === 'fieldset')[0].props.disabled, true);
  assert.ok(texts(busy).includes('Saving…'));
  assert.ok(form.props.noValidate);
  // typing calls onChange with the next draft (strings), not mutating the old one
  let next; const typed = expandAll(t.CapsForm({ draft, errors: {}, busy: false, onChange: (d) => { next = d; }, onSubmit: noop, onCancel: noop, firstRef: { current: null } }));
  findAll(typed, (n) => n.type === 'input' && n.props.id === 'dshMh-cap-daily')[0].props.onChange({ target: { value: '25' } });
  assert.equal(next.dailyUsd, '25'); assert.equal(draft.dailyUsd, '40');
  findAll(typed, (n) => n.type === 'button' && texts(n).join('') === 'Remove')[0].props.onClick();
  assert.deepEqual(J(next.providers), []);
  findAll(typed, (n) => n.type === 'button' && texts(n).join('') === 'Add provider cap')[0].props.onClick();
  assert.equal(next.providers.length, 2);
});

test('Enter submits (preventDefault) and Escape cancels; other keys do nothing', () => {
  const t = loadWithReact(fakeReact);
  const calls = [];
  const tree = t.CapsForm({ draft: { dailyUsd: '1', sessionUsd: '1', warnPct: '50', providers: [] }, errors: {}, busy: false, onChange() {}, onSubmit: () => calls.push('submit'), onCancel: () => calls.push('cancel'), firstRef: { current: null } });
  const form = findAll(tree, (n) => n.type === 'form')[0];
  let prevented = false, stopped = 0;
  form.props.onSubmit({ preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.deepEqual(calls, ['submit']);
  form.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped++; } });
  assert.deepEqual(calls, ['submit', 'cancel']); assert.equal(stopped, 1);
  form.props.onKeyDown({ key: 'a', stopPropagation() { stopped++; } });
  form.props.onKeyDown({ key: 'Enter', stopPropagation() { stopped++; } });
  assert.deepEqual(calls, ['submit', 'cancel']); assert.equal(stopped, 1);
  assert.equal(form.props['aria-label'], 'Edit spend caps');
});

test('CapsEditor focuses the first input on mount; the Costs card offers Edit caps once the caps load', () => {
  const effects = []; const focused = [];
  const react = { ...fakeReact, useRef: () => ({ current: { focus: () => focused.push(1) } }), useEffect: (f) => effects.push(f) };
  const t = loadWithReact(react);
  t.CapsEditor({ view: CAPS_VIEW, onSaved() {}, onCancel() {} });
  effects.forEach((f) => f());
  assert.equal(focused.length, 1);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('Edit caps') && src.includes('Caps saved.'));
});

test('client source renders data as text: no innerHTML / dangerouslySetInnerHTML', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/.test(src));
});

// ---- PR #1 (sneakyjoeru): the dock chip must not crush DSH's composer dock ----
function cssRule(src, selector) {
  const esc = selector.replace(/[.\[\]()*+?^$|\\-]/g, '\\$&');
  const m = new RegExp('"' + esc + '\\{([^}]*)\\}').exec(src);
  assert.ok(m, 'rule ' + selector + ' exists in HUB_CSS');
  return m[1];
}

test('dock wrap is content-sized and shrink-only (PR #1)', () => {
  const rule = cssRule(fs.readFileSync(file, 'utf8'), '.dshAmPlan-wrap');
  assert.ok(rule.includes('flex:0 1 auto'));
  assert.ok(rule.includes('min-width:0'));
  assert.ok(rule.includes('max-width:100%'));
  assert.ok(!/(^|;)width:100%/.test(rule));
  assert.ok(!rule.includes('flex:none'));
});

test('dock chip clips inside its own pill (PR #1)', () => {
  const rule = cssRule(fs.readFileSync(file, 'utf8'), '.dshMh-chip');
  assert.ok(rule.includes('min-width:0'));
  assert.ok(rule.includes('overflow:hidden'));
  assert.ok(rule.includes('flex:0 1 auto'));
  assert.ok(cssRule(fs.readFileSync(file, 'utf8'), '.dshMh-chipseg').includes('flex:none'));
});

test('phones: the plan chip takes its own dock row via DSH\'s stable attribute (PR #1)', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('@media (max-width:639px){[data-composer-dock]{flex-wrap:wrap}.dshAmPlan-wrap{flex:1 0 100%;order:1}}'));
});

test('dockVisible: only render when there is something to show (PR #1)', () => {
  const { dockVisible } = loadHelpers();
  assert.equal(typeof dockVisible, 'function');
  assert.equal(dockVisible(null, null, null), false);
  assert.equal(dockVisible(undefined, undefined, undefined), false);
  assert.equal(dockVisible({ mode: 'signed-out' }, null, null), false);
  assert.equal(dockVisible({ mode: 'signed-out' }, { total: 0 }, null), true);
  assert.equal(dockVisible({ mode: 'plan' }, null, null), true);
  assert.equal(dockVisible({ mode: 'expired' }, null, null), true);
  assert.equal(dockVisible({ mode: 'unavailable' }, null, null), true);
  assert.equal(dockVisible({ mode: 'api' }, null, null), true);
  assert.equal(dockVisible(null, null, { sessions: [] }), true);
  assert.equal(dockVisible('plan', null, null), false);
});

test('DockWidget calls dockVisible and still shows the other-instance pill (PR #1)', () => {
  const src = fs.readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('function DockWidget()'), src.indexOf('// ---------------- styles'));
  assert.ok(body.includes('dockVisible(st.plan, sp.data, ca.data)'));
  assert.ok(body.includes('otherInstance(st.webOrigin)'));
  assert.ok(/return null/.test(body));
});

// ---- Claude chip tooltip = the plan card's lines (one source) ----
const IN1H = new Date(Date.now() + 3600e3).toISOString();
const IN1D = new Date(Date.now() + 86400e3).toISOString();
const FULL_PLAN = { mode: 'plan', fiveHour: { percent: 12, resetsAt: IN1H }, sevenDay: { percent: 84, resetsAt: IN1D }, sevenDayOpus: { percent: 100, resetsAt: IN1D }, scopedWeekly: { percent: 26, resetsAt: IN1D, label: 'Sonnet only' }, messages: 13, modelCalls: 29, extraKnown: true, extraEnabled: true };
const NOT_REPORTED = "DSH does not stop Claude requests at the plan limit. Whether Anthropic bills or refuses requests beyond a full plan window depends on your account's extra-usage setting, which was not reported.";
const CAPTION = 'Usage % counts every Claude app on this account. Message counts are DSH only. Anthropic does not publish remaining messages.';

test('planLines: every line of the card, extra-usage sentence only when the endpoint reports it', () => {
  const t = loadWithReact(fakeReact);
  const lines = J(t.planLines(FULL_PLAN));
  assert.match(lines[0], /^5-hour window: 12% used · resets \S/);
  assert.match(lines[1], /^Weekly: 84% used · resets \S/);
  assert.match(lines[2], /^Weekly \(Opus\): 100% used · resets \S/);
  assert.match(lines[3], /^Sonnet only: 26% used · resets \S/);
  assert.equal(lines[4], 'Sent from DSH this window: 13 messages · 29 model calls');
  assert.equal(lines[5], CAPTION);
  assert.equal(lines[6], 'Extra usage is on for your Claude account: requests beyond a plan window are billed to your Anthropic balance.');
  assert.equal(lines.length, 7);
  const off = J(t.planLines({ ...FULL_PLAN, extraEnabled: false }));
  assert.equal(off[6], 'Extra usage is off for your Claude account: Anthropic refuses requests once a plan window is full.');
  const unknown = J(t.planLines({ ...FULL_PLAN, extraKnown: false, extraEnabled: false }));
  assert.equal(unknown.length, 7, 'an unreported setting gets the not-reported sentence, never an on/off claim');
  assert.equal(unknown[6], NOT_REPORTED);
  assert.ok(!unknown.some((l) => /Extra usage is/i.test(l)));
  const nocount = J(t.planLines({ ...FULL_PLAN, messages: null, modelCalls: null }));
  assert.ok(!nocount.some((l) => /Sent from DSH/.test(l)), 'unknown counts are left out, never 0');
  assert.equal(J(t.planLines({ ...FULL_PLAN, messages: 1, modelCalls: 1 })).filter((l) => /Sent from DSH/.test(l))[0], 'Sent from DSH this window: 1 message · 1 model call');
  const minimal = J(t.planLines({ mode: 'plan', fiveHour: { percent: 3, resetsAt: null } }));
  assert.deepEqual(minimal, ['5-hour window: 3% used', CAPTION, NOT_REPORTED]);
});

test('planLines for unavailable / signed-out / expired / api', () => {
  const t = loadWithReact(fakeReact);
  const un = J(t.planLines({ mode: 'unavailable', httpStatus: 429, fetchedAt: Date.now(), fiveHour: { percent: 12, resetsAt: IN1H }, sevenDay: { percent: 84, resetsAt: IN1D }, extraKnown: true, extraEnabled: false }));
  assert.match(un[0], /^Plan usage unavailable \(429\) · \S/);
  assert.match(un[1], /^5-hour window: 12% used/);
  assert.match(un[2], /^Weekly: 84% used/);
  assert.equal(un[un.length - 1], 'The sign-in may need renewing: see Model hub → Accounts.');
  assert.ok(!un.some((l) => /Extra usage/.test(l)), 'no extra-usage claim while the plan is unavailable');
  assert.deepEqual(J(t.planLines({ mode: 'unavailable', httpStatus: null })).slice(0, 1), ['Plan usage unavailable (?)']);
  assert.deepEqual(J(t.planLines({ mode: 'signed-out' })), ['Not signed in. Use Model hub → Accounts below to sign in.']);
  assert.deepEqual(J(t.planLines(null)), ['Not signed in. Use Model hub → Accounts below to sign in.']);
  assert.deepEqual(J(t.planLines({ mode: 'expired' })), ['Claude sign-in expired — Model hub → Accounts']);
  assert.deepEqual(J(t.planLines({ mode: 'api' })), ['Using Anthropic API key (billed per token)']);
});

test('the card and the tooltip show the same lines', () => {
  const t = loadWithReact(fakeReact);
  const ident = { email: 'a@b.c', plan: 'Max' };
  const table = [FULL_PLAN, { mode: 'plan', fiveHour: { percent: 3, resetsAt: null } }, { mode: 'unavailable', httpStatus: 429, fetchedAt: 1e12, fiveHour: { percent: 12, resetsAt: IN1H } }, { mode: 'api' }, { mode: 'signed-out' }, { mode: 'expired' }];
  for (const plan of table) {
    const lines = J(t.planLines(plan));
    const shown = texts(expandAll(t.planBody(plan)));
    for (const l of lines) assert.ok(shown.includes(l), plan.mode + ' card is missing: ' + l);
    const signedIn = plan.mode === 'plan' || plan.mode === 'unavailable';
    assert.deepEqual(J(t.chipModel(plan, null, null, ident).claude.lines), (signedIn ? [t.identityLine(ident)] : []).concat(lines), plan.mode);
    assert.deepEqual(J(t.planCardLines(plan, ident)), J(t.chipModel(plan, null, null, ident).claude.lines));
  }
  assert.match(t.chipModel(FULL_PLAN, null, null, ident).claude.summary, /^Claude plan usage: 5-hour window 12%, weekly 84%$/);
  assert.match(t.chipModel({ mode: 'api' }, null, null, null).claude.summary, /API key/);
});

const dockRender = (plan, { open = false, dom } = {}) => {
  const t = loadWithReact({ ...fakeReact, useState: (i) => [i === null ? open : i, () => {}], useId: () => 'x', useCallback: (f) => f }, dom);
  return { t, tree: expandAll(t.DockChip({ plan, spend: null, cache: null, identity: { email: 'a@b.c' } })) };
};

test('the Claude chip segment is focusable and described; the root chip has no title; other segments do', () => {
  const { t, tree } = dockRender(FULL_PLAN);
  const seg = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.includes('is-claude'))[0];
  assert.equal(seg.props.tabIndex, 0);
  assert.equal(seg.props.role, 'group');
  assert.match(seg.props['aria-label'], /Claude plan usage/);
  assert.equal(seg.props['aria-describedby'], 'dshMh-claude-tip');
  assert.equal(seg.props.title, undefined, 'no native title on the Claude segment: tooltips never stack');
  for (const k of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur', 'onKeyDown']) assert.equal(typeof seg.props[k], 'function', k);
  const tip = findAll(tree, (n) => n.props.id === 'dshMh-claude-tip')[0];
  assert.ok(tip, 'the always-rendered description exists');
  assert.match(tip.props.className, /dshMh-sr/);
  assert.deepEqual(J(findAll(tip, (n) => n.type === 'div').map((n) => n.props.children)), J(t.chipModel(FULL_PLAN, null, null, { email: 'a@b.c' }).claude.lines));
  const root = findAll(tree, (n) => n.props['data-testid'] === 'model-hub-chip')[0];
  assert.equal(root.props.title, undefined, 'the root chip has no title');
  const others = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.includes('dshMh-chipseg') && !n.props.className.includes('is-claude'));
  assert.ok(others.length >= 2);
  for (const o of others) assert.ok(o.props.title, 'every other segment keeps its own title');
});

test('Escape on the Claude segment dismisses the popover', () => {
  let open = { left: 1, top: 1, width: 1, height: 1 }; const set = (v) => { open = v; };
  const t = loadWithReact({ ...fakeReact, useState: (i) => [i === null ? open : i, set], useId: () => 'x', useCallback: (f) => f }, { createPortal: (c) => c }, { document: { querySelector: () => ({}), body: {}, documentElement: {} } });
  const tree = expandAll(t.DockChip({ plan: FULL_PLAN, spend: null, cache: null, identity: null }));
  const seg = findAll(tree, (n) => typeof n.props.className === 'string' && n.props.className.includes('is-claude'))[0];
  let prevented = false;
  seg.props.onKeyDown({ key: 'a', preventDefault() { prevented = true; } });
  assert.notEqual(open, null);
  seg.props.onKeyDown({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(open, null);
  seg.props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 500, width: 80, height: 24 }) } });
  assert.deepEqual(J(open), { left: 10, top: 500, width: 80, height: 24 });
  seg.props.onMouseLeave();
  assert.equal(open, null);
});

test('the open popover is a body portal, aria-hidden, pointer-events none, text children only', () => {
  const dom = { createPortal: (child, target) => ({ portal: true, target, child }) };
  const hostile = '<img src=x onerror=alert(1)>';
  const plan = { ...FULL_PLAN, scopedWeekly: { percent: 26, resetsAt: IN1D, label: hostile } };
  const t = loadWithReact({ ...fakeReact, useState: (i) => [i === null ? { left: 20, top: 400, width: 80, height: 24 } : i, () => {}], useId: () => 'x', useCallback: (f) => f }, dom, { document: { querySelector: () => ({}), body: { tag: 'body' }, documentElement: { clientWidth: 1000, clientHeight: 800 } } });
  {
    const raw = t.DockChip({ plan, spend: null, cache: null, identity: null });
    const walk = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return out; } if (n.portal) { out.push(n); walk(n.child, out); return out; } if (n.props) walk(n.props.children, out); return out; };
    const expanded = expandAll(raw);
    const portals = walk(expanded);
    assert.equal(portals.length, 1, 'one portal while open');
    assert.equal(portals[0].target.tag, 'body');
    const pop = portals[0].child;
    assert.equal(pop.props.role, 'tooltip');
    assert.equal(pop.props['aria-hidden'], 'true');
    assert.match(pop.props.className, /dshMh-pop/);
    assert.equal(pop.props.title, undefined);
    assert.equal(pop.props.style.position, 'fixed');
    const shown = texts(pop);
    assert.ok(shown.some((x) => x.startsWith(hostile + ': 26% used')), 'the hostile label is a plain text child');
    assert.ok(findAll(pop, (n) => n.type !== 'div').length === 0, 'only div elements, no img or other markup');
    for (const d of pop.props.children) { assert.equal(d.type, 'div'); assert.equal(typeof d.props.children, 'string'); }
  }
});

test('tooltip text is text, never HTML: the source has no innerHTML', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!/innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML/.test(src.replace(/\/\/.*$/gm, '')));
  assert.match(src, /require\("react-dom"\)/);
  assert.match(src, /\.dshMh-pop\{[^}]*pointer-events:none/);
  assert.match(src, /\.dshMh-sr\{/);
  assert.match(src, /\.dshMh-chipseg\.is-claude:focus-visible\{[^}]*var\(--mh-accent\)/);
  const pop = src.match(/"\.dshMh-pop\{[^"]*"/)[0];
  assert.deepEqual(pop.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'no hardcoded hex colours in the popover');
  assert.ok(!/rgb\(|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(?!0?\.\d+\))/.test(pop.replace(/box-shadow:[^;"]*/, '')), 'only the shadow may use rgba');
});

// ---- opt-in plan stop: sentence, switch, tooltip ----
const FRESH = () => Date.now() - 1000;
const HOT = () => ({ mode: 'plan', fetchedAt: FRESH(), fiveHour: { percent: 100, resetsAt: IN1H }, sevenDay: { percent: 20, resetsAt: IN1D }, extraKnown: true, extraEnabled: true });
const COOL = () => ({ mode: 'plan', fetchedAt: FRESH(), fiveHour: { percent: 40, resetsAt: IN1H }, sevenDay: { percent: 20, resetsAt: IN1D }, extraKnown: true, extraEnabled: true });
const WILL_STOP = 'DSH will stop Claude requests when a plan window (5-hour, weekly or per-model weekly) reaches 100%, so nothing is billed beyond your plan.';

test('extraUsageSentence follows the state (exact sentences)', () => {
  const t = loadWithReact(fakeReact);
  const hot = J(t.extraUsageSentence(HOT(), true));
  assert.match(hot, /^Stopped by DSH: your Claude 5-hour window is at 100% \(resets \S.*\)\. Claude requests are refused until then\.$/);
  assert.equal(J(t.extraUsageSentence(COOL(), true)), WILL_STOP);
  assert.equal(J(t.extraUsageSentence({ ...HOT(), fetchedAt: Date.now() - 11 * 60 * 1000 }, true)), WILL_STOP, 'a stale gauge is not claimed as a stop');
  assert.equal(J(t.extraUsageSentence({ ...HOT(), fiveHour: { percent: 100, resetsAt: new Date(Date.now() - 60000).toISOString() } }, true)), WILL_STOP, 'a window past its reset is not a stop');
  assert.equal(J(t.extraUsageSentence({ ...COOL(), fiveHour: { percent: 99, resetsAt: IN1H } }, true)), WILL_STOP);
  const weekly = J(t.extraUsageSentence({ ...COOL(), sevenDay: { percent: 100, resetsAt: IN1D } }, true));
  assert.match(weekly, /^Stopped by DSH: your Claude weekly window is at 100%/);
  const opus = J(t.extraUsageSentence({ ...COOL(), sevenDayOpus: { percent: 100, resetsAt: IN1D } }, true));
  assert.match(opus, /^Stopped by DSH: your Claude weekly Opus window is at 100% .*Opus requests are refused until then\.$/);
  assert.equal(J(t.extraUsageSentence({ ...COOL(), scopedWeekly: { label: 'Research', percent: 100, resetsAt: IN1D } }, true)), WILL_STOP, 'a labelled window without a model family never counts');
  assert.equal(J(t.extraUsageSentence(HOT(), false)), 'Extra usage is on for your Claude account: requests beyond a plan window are billed to your Anthropic balance.');
  assert.equal(J(t.extraUsageSentence({ ...HOT(), extraEnabled: false }, false)), 'Extra usage is off for your Claude account: Anthropic refuses requests once a plan window is full.');
  assert.equal(J(t.extraUsageSentence({ ...HOT(), extraKnown: false }, false)), NOT_REPORTED);
  assert.equal(J(t.extraUsageSentence(HOT())), 'Extra usage is on for your Claude account: requests beyond a plan window are billed to your Anthropic balance.', 'stop defaults to off');
});

test('the tooltip lines follow the toggle state', () => {
  const t = loadWithReact(fakeReact);
  const on = J(t.chipModel(COOL(), null, null, null, true).claude.lines);
  assert.ok(on.includes(WILL_STOP));
  assert.ok(!on.some((l) => /^Extra usage is/.test(l)));
  const off = J(t.chipModel(COOL(), null, null, null, false).claude.lines);
  assert.ok(!off.includes(WILL_STOP));
  assert.ok(off.some((l) => /^Extra usage is on/.test(l)));
  assert.deepEqual(J(t.chipModel(COOL(), null, null, null).claude.lines), off);
  const hot = J(t.planLines(HOT(), true));
  assert.match(hot[hot.length - 1], /^Stopped by DSH: your Claude 5-hour window/);
  assert.deepEqual(J(t.planCardLines(COOL(), null, true)), J(t.chipModel(COOL(), null, null, null, true).claude.lines));
  const un = J(t.planLines({ mode: 'unavailable', httpStatus: 429, fiveHour: { percent: 100, resetsAt: IN1H }, extraKnown: true }, true));
  assert.ok(!un.some((l) => /Stopped by DSH|DSH will stop/.test(l)), 'no stop claim while the gauge is unavailable');
});

test('the plan card shows the switch bound to caps.stopAtPlanLimit; the card and tooltip still show the same lines', () => {
  const t = loadWithReact(fakeReact);
  const posts = [];
  const sw = (props) => t.PlanStopSwitch({ stop: false, busy: false, error: '', onToggle: (n) => posts.push(n), ...props });
  const input = (tree) => findAll(tree, (n) => n.type === 'input')[0];
  const off = sw({});
  assert.equal(input(off).props.type, 'checkbox'); assert.equal(input(off).props.role, 'switch');
  assert.equal(input(off).props.checked, false); assert.equal(input(off).props.disabled, false);
  assert.ok(texts(off).includes('Stop Claude requests at 100% of a plan window'));
  input(off).props.onChange({ target: { checked: true } });
  assert.deepEqual(posts, [true]);
  const on = sw({ stop: true });
  assert.equal(input(on).props.checked, true);
  input(on).props.onChange({ target: { checked: false } });
  assert.deepEqual(posts, [true, false]);
  assert.equal(input(sw({ busy: true })).props.disabled, true, 'disabled while saving');
  assert.equal(input(sw({ unavailable: true })).props.disabled, true, 'disabled until the caps load');
  const bad = sw({ error: 'this page is not the DSH instance that owns the model hub' });
  const alert = findAll(bad, (n) => n.props.role === 'alert')[0];
  assert.deepEqual(texts(alert), ['this page is not the DSH instance that owns the model hub']);
  assert.equal(findAll(off, (n) => n.props.role === 'alert').length, 0);
  // the card: switch sits just before the sentence; all planLines still shown
  const plan = COOL();
  const body = texts(expandAll(t.planBody(plan, true, h0('SWITCH'))));
  for (const l of J(t.planLines(plan, true))) assert.ok(body.includes(l), l);
  assert.ok(body.indexOf('SWITCH') === body.indexOf(WILL_STOP) - 1, 'switch right above the sentence');
  assert.ok(!texts(expandAll(t.planBody({ mode: 'signed-out' }, false, h0('SWITCH')))).includes('SWITCH'), 'no switch without a plan');
  assert.ok(!texts(expandAll(t.planBody({ mode: 'unavailable', httpStatus: 429 }, false, h0('SWITCH')))).includes('SWITCH'), 'no switch while unavailable');
});
const h0 = (text) => ({ type: 'span', props: { children: text } });

test('saving the switch posts {set:{stopAtPlanLimit}} through /caps, shows the refusal, and reloads', async () => {
  const t = loadWithReact(fakeReact);
  const log = [];
  const ui = { busy: (b) => log.push('busy:' + b), error: (e) => log.push('error:' + e), reload: () => log.push('reload') };
  const calls = [];
  await t.savePlanStop(true, async (p, b) => { calls.push([p, J(b)]); return {}; }, ui);
  assert.deepEqual(calls, [['/caps', { set: { stopAtPlanLimit: true } }]]);
  assert.deepEqual(log, ['busy:true', 'error:', 'reload', 'busy:false']);
  log.length = 0;
  await t.savePlanStop(false, async () => { throw new Error('this page is not the DSH instance that owns the model hub; open http://127.0.0.1:3080 to change caps'); }, ui);
  assert.deepEqual(log, ['busy:true', 'error:', 'error:this page is not the DSH instance that owns the model hub; open http://127.0.0.1:3080 to change caps', 'busy:false']);
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(src.includes('savePlanStop(next, postJson'), 'the real card posts through postJson (the ownership check)');
  assert.ok(src.includes('.dshMh-switchrow input:focus-visible'), 'visible keyboard focus');
  assert.ok(src.includes('stop: st.caps && st.caps.stopAtPlanLimit === true') || src.includes('st.caps.stopAtPlanLimit === true'));
});

// ---- spend forecast line (Costs card) ----
const FC_NOW = new Date(2026, 10, 12, 14, 0).getTime(); // local clock, so the expected HH:MM do not depend on the time zone
const FC_AT = (h, m, dayShift = 0) => new Date(2026, 10, 12 + dayShift, h, m).getTime();
const fcCharged = (extra = {}) => ({ status: 'ok', reason: null, calls15: 15, calls60: 40, ratePerHour: { m15: 1.2, m60: 1.35 }, todayUsd: 4.1, midnightAt: FC_AT(24, 0), projectedTodayUsd: { mid: 14.2, low: 13.8, high: 15.1 }, ...extra });
const fcCap = (o) => ({ which: 'daily', capUsd: 40, spentUsd: 4.1, calls15: 15, reason: null, reachedAt: null, range: null, resetsAt: FC_AT(24, 0), ...o });
const fcSpend = (o = {}) => ({ estimate: true, generatedAt: FC_NOW, complete: true, reason: null, minCalls: 3, windowsMin: [15, 60], charged: fcCharged(), caps: [], apiValue: null, plans: [], ...o });

test('usdRate: two decimals from 10 cents up, three below', () => {
  const t = loadHelpers();
  assert.equal(t.usdRate(1.2), '$1.20');
  assert.equal(t.usdRate(0.1), '$0.10');
  assert.equal(t.usdRate(0.05), '$0.050');
  assert.equal(t.usdRate(12), '$12.00');
});

test('forecastSpendLine: exact wording for ok / cap not reached / provider cap first / reached / suppressed (null)', () => {
  const t = loadHelpers();
  const line = (s) => { const l = t.forecastSpendLine(s); return l && l.text; };
  const head = '$1.20/h now (15 min) · today ~$14.20';
  assert.equal(line(fcSpend()), head, 'no caps: no cap part');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] })), head + ' · daily cap ~16:40');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' })] })), head + ' · daily cap: not at this pace');
  // a provider cap that is reached before the daily one is named first
  assert.equal(line(fcSpend({ caps: [
    fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40) }),
    fcCap({ which: 'provider-daily', provider: 'openai', capUsd: 5, state: 'at-pace', reachedAt: FC_AT(15, 10) }),
    fcCap({ which: 'session', sessionId: 's1', state: 'at-pace', reachedAt: FC_AT(17, 0) }),
  ] })), head + ' · openai cap ~15:10');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' }), fcCap({ which: 'session', sessionId: 's1', state: 'at-pace', reachedAt: FC_AT(15, 5) })] })), head + ' · session cap ~15:05');
  // a time on another day carries the weekday
  assert.equal(line(fcSpend({ caps: [fcCap({ which: 'session', sessionId: 's1', state: 'at-pace', reachedAt: FC_AT(9, 30, 1) })] })), head + ' · session cap ~Fri 09:30');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'reached', spentUsd: 41 })] })), head + ' · daily cap reached');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'suppressed', reason: 'x' })] })), head, 'a suppressed cap adds nothing');
  // suppressed pace, partial ledger, no data: nothing at all
  assert.equal(t.forecastSpendLine(fcSpend({ charged: fcCharged({ status: 'suppressed', ratePerHour: null, projectedTodayUsd: null, reason: 'fewer than 3' }) })), null);
  assert.equal(t.forecastSpendLine(fcSpend({ complete: false, charged: null })), null);
  assert.equal(t.forecastSpendLine(null), null);
  assert.equal(t.forecastSpendLine(undefined), null);
  assert.equal(t.forecastSpendLine({}), null);
});

test('forecast text carries the estimate marks: the title says estimate, not a limit, and names the inputs', () => {
  const t = loadHelpers();
  const l = t.forecastSpendLine(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] }));
  assert.ok(l.title.startsWith('Estimate, not a limit.'), l.title);
  assert.ok(l.title.includes('15 metered calls'), l.title);
  assert.ok(l.title.includes('$1.20/h (15 min)') && l.title.includes('$1.35/h (60 min)'), l.title);
  assert.ok(l.title.includes('daily cap range 15:10-22:05'), 'the range is in the title: ' + l.title);
  assert.match(l.title, /blocks nothing|Nothing is blocked/i);
  // an open range end is said, not guessed
  const open = t.forecastSpendLine(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: null } })] }));
  assert.ok(open.title.includes('daily cap range 15:10-later'), open.title);
});

const fcExpand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(fcExpand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return fcExpand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: fcExpand(n.props.children) } } : n; };
const fcFind = (n, id, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => fcFind(x, id, out)); return out; } if (n.props) { if (n.props['data-testid'] === id) out.push(n); fcFind(n.props.children, id, out); } return out; };
const COSTS_TODAY = { data: {
  totals: { usd: 0, apiEquivUsd: 0, calls: 0 }, complete: true, byProvider: {},
  caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
}, error: null };

test('the Costs card renders one forecast line under the meters when /forecast has data, and nothing when it is suppressed or missing', () => {
  const t = loadWithReact(fakeReact, undefined, { Date: FixedDate });
  const spend = fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] });
  const tree = fcExpand(t.CostsPanel({ today: COSTS_TODAY, gcfg: null, forecast: { data: { estimate: true, generatedAt: FC_NOW, spend }, error: null } }));
  const hits = fcFind(tree, 'model-hub-forecast');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].props.title.startsWith('Estimate, not a limit.'));
  const out = texts(tree);
  const line = '$1.20/h now (15 min) · today ~$14.20 · daily cap ~16:40';
  assert.ok(out.includes(line), out.join('|'));
  assert.ok(out.includes(' (estimate)'), 'hidden estimate marker for screen readers');
  const span = hits[0].props.children.find((c) => c && c.props && c.props.className === 'dshMh-sr');
  assert.ok(span, 'the (estimate) span is visually hidden (dshMh-sr)');
  // it sits after the cap meters
  assert.ok(out.indexOf('$0.00 of $15.00') >= 0 && out.indexOf(line) > out.indexOf('$0.00 of $15.00'), 'under the meters');
  // suppressed, partial, missing, not yet loaded: no line, no test id
  const none = (forecast) => fcFind(fcExpand(t.CostsPanel({ today: COSTS_TODAY, gcfg: null, forecast })), 'model-hub-forecast').length;
  assert.equal(none({ data: { generatedAt: FC_NOW, spend: fcSpend({ charged: fcCharged({ status: 'suppressed', ratePerHour: null, projectedTodayUsd: null }) }) }, error: null }), 0);
  assert.equal(none({ data: { generatedAt: FC_NOW, spend: fcSpend({ complete: false, charged: null }) }, error: null }), 0);
  assert.equal(none({ data: null, error: 'HTTP 503' }), 0);
  assert.equal(none({ data: null, error: null }), 0);
  assert.equal(none(undefined), 0);
});

test('the forecast is polled by the hub section and handed to the Costs card; it is rendered as text only', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /usePoll\("\/forecast", 15000\)/);
  assert.match(src, /h\(CostsPanel, \{ key: "c", today, gcfg: gcfg\.data, demo: st\.demo, forecast \}\)/);
  assert.ok(!/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/.test(src));
  // the line's data goes through React children and title, never through markup strings
  const fn = /function forecastSpendLine[\s\S]*?\n    }\n/.exec(src);
  assert.ok(fn, 'forecastSpendLine exists');
  assert.ok(!/<[a-z]+[ >]/i.test(fn[0].replace(/=>|<=/g, '')), 'no markup strings in forecastSpendLine');
});

// ---- Claude plan forecast lines (plan card = tooltip = popover) and forecast freshness ----
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(FC_NOW); }
  static now() { return FC_NOW; }
}
const loadFixed = (react = fakeReact, dom) => loadWithReact(react, dom, { Date: FixedDate });
// the clock as the client formats it (fmtReset): time only on FC_NOW's day, short weekday + time otherwise
const fcLoc = (ms) => {
  const d = new Date(ms);
  const o = { hour: 'numeric', minute: '2-digit' };
  return d.toDateString() === new Date(FC_NOW).toDateString() ? d.toLocaleTimeString(undefined, o) : d.toLocaleString(undefined, { ...o, weekday: 'short' });
};
const PLAN_NOW = { mode: 'plan', fiveHour: { percent: 40, resetsAt: new Date(FC_AT(17, 0)).toISOString() }, sevenDay: { percent: 30, resetsAt: new Date(FC_AT(14, 0, 3)).toISOString() }, messages: 3, modelCalls: 5, extraKnown: true, extraEnabled: false };
const fcWin = (o) => ({ resetsAt: new Date(FC_AT(17, 0)).toISOString(), lastReadingAt: FC_NOW - 60e3, ageMs: 60e3, readings: 6, windowReadings: 9, percent: 40, ratePerHour: 20, ...o });
const LIMIT5 = fcWin({ status: 'limit', limitAt: FC_AT(16, 20), earliestAt: FC_AT(16, 5), latestAt: FC_AT(16, 50) });
const NOLIMIT7 = fcWin({ status: 'no-limit', resetsAt: PLAN_NOW.sevenDay.resetsAt, earliestAt: null, mayReach: false });
const planFc = (five = LIMIT5, seven = NOLIMIT7, extra = {}) => ({ estimate: true, generatedAt: FC_NOW, spend: fcSpend(), plan: { estimate: true, lastReadingAt: FC_NOW - 60e3, ageMs: 60e3, windows: { fiveHour: five, sevenDay: seven } }, ...extra });

test('forecastPlanLine: exact wording for limit / open range / no-limit / hedged no-limit; nothing for the other states', () => {
  const t = loadFixed();
  const win5 = PLAN_NOW.fiveHour;
  assert.equal(t.forecastPlanLine(LIMIT5, win5), `At this pace: limit ~${fcLoc(FC_AT(16, 20))} (range ${fcLoc(FC_AT(16, 5))}–${fcLoc(FC_AT(16, 50))}), 6 readings, before the reset`);
  assert.equal(t.forecastPlanLine(fcWin({ status: 'limit', limitAt: FC_AT(16, 20), earliestAt: FC_AT(16, 5), latestAt: null, readings: 1 }), win5), `At this pace: limit ~${fcLoc(FC_AT(16, 20))} (range from ${fcLoc(FC_AT(16, 5))}), 1 reading, before the reset`);
  assert.equal(t.forecastPlanLine(NOLIMIT7, PLAN_NOW.sevenDay), `At this pace: won't reach 100% before the reset at ${fcLoc(FC_AT(14, 0, 3))}`);
  assert.equal(t.forecastPlanLine(fcWin({ status: 'no-limit', resetsAt: PLAN_NOW.sevenDay.resetsAt, earliestAt: FC_AT(22, 10, 2), mayReach: true }), PLAN_NOW.sevenDay), `At this pace: probably not before the reset at ${fcLoc(FC_AT(14, 0, 3))} (could be ~${fcLoc(FC_AT(22, 10, 2))} at the fastest pace)`);
  for (const status of ['insufficient', 'stale', 'reset', 'at-limit', 'none']) assert.equal(t.forecastPlanLine(fcWin({ status }), win5), null, status);
  assert.equal(t.forecastPlanLine(null, win5), null);
  assert.equal(t.forecastPlanLine(LIMIT5, null), null);
  assert.equal(t.forecastPlanLine({ ...LIMIT5, limitAt: undefined }, win5), null, 'a limit without its time says nothing');
  // a forecast fitted to another window (different reset) is ignored
  assert.equal(t.forecastPlanLine({ ...LIMIT5, resetsAt: new Date(FC_AT(12, 0)).toISOString() }, win5), null);
  assert.ok(t.forecastPlanLine({ ...LIMIT5, resetsAt: new Date(FC_AT(17, 0) + 30e3).toISOString() }, win5), 'sub-minute jitter is the same window');
});

test('planLines puts each window\'s forecast line directly after that window\'s line, only for a live plan, and is unchanged without a forecast', () => {
  const t = loadFixed();
  const base = J(t.planLines(PLAN_NOW, false));
  assert.deepEqual(J(t.planLines(PLAN_NOW, false, undefined)), base);
  assert.deepEqual(J(t.planLines(PLAN_NOW, false, null)), base);
  const withFc = J(t.planLines(PLAN_NOW, false, planFc()));
  assert.equal(withFc.length, base.length + 2);
  assert.match(withFc[0], /^5-hour window: 40% used/);
  assert.match(withFc[1], /^At this pace: limit ~/);
  assert.match(withFc[2], /^Weekly: 30% used/);
  assert.match(withFc[3], /^At this pace: won't reach 100%/);
  assert.deepEqual(withFc.filter((l) => !l.startsWith('At this pace:')), base, 'nothing else moves');
  // suppressed windows add nothing
  assert.deepEqual(J(t.planLines(PLAN_NOW, false, planFc(fcWin({ status: 'insufficient' }), fcWin({ status: 'stale' })))), base);
  assert.deepEqual(J(t.planLines(PLAN_NOW, false, { estimate: true, spend: fcSpend() })), base, 'a report without a plan part');
  // not for unavailable, signed-out, expired, api
  for (const plan of [{ ...PLAN_NOW, mode: 'unavailable', httpStatus: 429 }, { mode: 'signed-out' }, { mode: 'expired' }, { mode: 'api' }]) {
    assert.ok(!J(t.planLines(plan, false, planFc())).some((l) => l.startsWith('At this pace:')), plan.mode);
  }
});

test('the card, the tooltip and the popover show the same plan lines with a forecast, each marked as an estimate', () => {
  const t = loadFixed();
  const ident = { email: 'a@b.c', plan: 'Max' };
  const fc = planFc();
  const lines = J(t.planLines(PLAN_NOW, false, fc));
  const shown = texts(expandAll(t.planBody(PLAN_NOW, false, null, fc)));
  for (const l of lines) assert.ok(shown.includes(l), 'card is missing: ' + l);
  assert.deepEqual(J(t.chipModel(PLAN_NOW, null, null, ident, false, null, fc).claude.lines), [t.identityLine(ident)].concat(lines));
  assert.deepEqual(J(t.planCardLines(PLAN_NOW, ident, false, fc)), J(t.chipModel(PLAN_NOW, null, null, ident, false, null, fc).claude.lines));
  // the popover renders exactly the model's lines
  const pop = expandAll(t.PlanPopover({ lines: t.chipModel(PLAN_NOW, null, null, ident, false, null, fc).claude.lines, anchor: { left: 10, top: 500, width: 40, height: 20 } }));
  assert.deepEqual(texts(pop), J(t.chipModel(PLAN_NOW, null, null, ident, false, null, fc).claude.lines));
  // the card rows of the forecast carry the estimate title and the visually hidden marker; other rows do not
  const rows = findAll(expandAll(t.planBody(PLAN_NOW, false, null, fc)), (n) => typeof n.props.title === 'string' && n.props.title.startsWith('Estimate, not a limit.'));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(/whole percents/.test(r.props.title) && /Claude app/.test(r.props.title) && /1 min/.test(r.props.title), r.props.title);
    assert.ok(findAll(r, (n) => n.props.className === 'dshMh-sr').length === 1, 'hidden (estimate) marker');
  }
  assert.ok(texts(rows[0]).includes(' (estimate)'));
  // the caption stating the % counts every Claude app stays
  assert.ok(lines.includes(CAPTION));
});

test('the dock tooltip description marks the forecast lines as estimates for screen readers', () => {
  const t = loadFixed({ ...fakeReact, useState: (i) => [i === null ? false : i, () => {}], useId: () => 'x', useCallback: (f) => f });
  const tree = expandAll(t.DockChip({ plan: PLAN_NOW, spend: null, cache: null, identity: { email: 'a@b.c' }, forecast: planFc() }));
  const tip = findAll(tree, (n) => n.props.id === 'dshMh-claude-tip')[0];
  const out = texts(tip);
  const idx = out.findIndex((l) => l.startsWith('At this pace:'));
  assert.ok(idx >= 0 && /\(estimate\)$/.test(out[idx]), out.join('|'));
});

test('forecast freshness: an error, an old report or no report shows nothing', () => {
  const t = loadFixed();
  const good = planFc();
  assert.equal(t.freshForecast({ data: good, error: null }), good);
  assert.equal(t.freshForecast({ data: good, error: 'HTTP 503' }), null, 'a failed poll keeps old data in usePoll; it must not be shown');
  assert.equal(t.freshForecast({ data: { ...good, generatedAt: FC_NOW - 61e3 }, error: null }), null);
  assert.ok(t.freshForecast({ data: { ...good, generatedAt: FC_NOW - 59e3 }, error: null }));
  assert.equal(t.freshForecast({ data: { ...good, generatedAt: FC_NOW + 5 * 60e3 }, error: null }), null, 'a clock far ahead is not fresh either');
  assert.equal(t.freshForecast({ data: { spend: fcSpend() }, error: null }), null, 'no generatedAt');
  assert.equal(t.freshForecast(null), null);
  assert.equal(t.freshForecast(undefined), null);
});

test('the Costs forecast line disappears when the last poll failed or the report is old', () => {
  const t = loadFixed();
  const spend = fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] });
  const count = (forecast) => fcFind(fcExpand(t.CostsPanel({ today: COSTS_TODAY, gcfg: null, forecast })), 'model-hub-forecast').length;
  assert.equal(count({ data: { estimate: true, generatedAt: FC_NOW, spend }, error: null }), 1);
  assert.equal(count({ data: { estimate: true, generatedAt: FC_NOW, spend }, error: 'Failed to fetch' }), 0, 'stale data after a failed poll');
  assert.equal(count({ data: { estimate: true, generatedAt: FC_NOW - 5 * 60e3, spend }, error: null }), 0, 'a report five minutes old');
});

test('a reached session or provider cap is named, ahead of the "daily cap: not at this pace" fallback', () => {
  const t = loadFixed();
  const line = (s) => t.forecastSpendLine(s).text;
  const head = '$1.20/h now (15 min) · today ~$14.20';
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' }), fcCap({ which: 'session', sessionId: 's1', capUsd: 15, spentUsd: 15.2, state: 'reached' })] })), head + ' · session cap reached · daily cap: not at this pace');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' }), fcCap({ which: 'provider-daily', provider: 'openai', capUsd: 5, state: 'reached' })] })), head + ' · openai cap reached · daily cap: not at this pace');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'reached' }), fcCap({ which: 'session', sessionId: 's1', state: 'reached' })] })), head + ' · daily cap reached · session cap reached');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'reached' }), fcCap({ which: 'provider-daily', provider: 'openai', state: 'at-pace', reachedAt: FC_AT(15, 10) })] })), head + ' · daily cap reached · openai cap ~15:10');
});

test('the plan card and the dock widget each poll /forecast and show only a fresh report; the Today tooltip carries the spend forecast line', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.match(/function PlanCard\(\) \{[\s\S]*?\n    \}\n/.exec(src)[0], /freshForecast\(usePoll\("\/forecast", 15000\)\)/);
  assert.match(/function DockWidget\(\) \{[\s\S]*?\n    \}\n/.exec(src)[0], /freshForecast\(usePoll\("\/forecast", 15000\)\)/);
  const t = loadFixed();
  const spend = { totals: { usd: 4.1, calls: 14 }, caps: { action: 'ok', reason: 'within caps', todayUsd: 4.1, limits: { dailyUsd: 40 } } };
  const plain = t.chipModel(PLAN_NOW, spend, null, null, false).today.title;
  assert.equal(t.chipModel(PLAN_NOW, spend, null, null, false, null).today.title, plain);
  assert.equal(t.chipModel(PLAN_NOW, spend, null, null, false, null, planFc(LIMIT5, NOLIMIT7, { spend: fcSpend({ charged: fcCharged({ status: 'suppressed', ratePerHour: null, projectedTodayUsd: null }) }) })).today.title, plain, 'a suppressed pace adds nothing');
  const withFc = t.chipModel(PLAN_NOW, spend, null, null, false, null, planFc()).today.title;
  assert.equal(withFc, plain + ' Estimate, not a limit: $1.20/h now (15 min) · today ~$14.20.');
});
