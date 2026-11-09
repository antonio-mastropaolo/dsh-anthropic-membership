// Smoke test: the client bundle registers under the package id with fake slots; no DOM needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

test('client.js loads under @local/dsh-model-hub and registers the three slots', () => {
  let mod;
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  assert.equal(mod.id, JSON.parse(fs.readFileSync(path.join(path.dirname(file), '..', 'package.json'), 'utf8')).name);
  const stub = () => ({});
  const m = mod.factory((n) => (n === 'react' ? new Proxy({}, { get: () => stub }) : n === 'react/jsx-runtime' ? { jsx: stub, jsxs: stub } : { FishLogo: stub }));
  const names = [];
  m.apply({ slots: { inject: (n, cb) => { names.push(n); cb(); }, register: () => {} } });
  assert.deepEqual(names.sort(), ['conversation.composer.dock', 'settings.models.footer', 'settings.models.provider-card']);
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
  for (const k of ['anthropic', 'openai-codex', 'github-copilot', 'kimi-coding', 'openrouter', 'xai', 'rocco', 'nvidia', 'mac', 'google', 'dashscope', 'ollama', 'deepseek']) {
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

function loadWithReact(reactStub) {
  let mod;
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const jsx = (type, props) => ({ type, props });
  return mod.factory((n) => (n === 'react' ? reactStub : n === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : { FishLogo: () => ({}) }))._test;
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
