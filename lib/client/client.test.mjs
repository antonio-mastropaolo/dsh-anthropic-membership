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
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'revoked' }), 'The sign-in was revoked or replaced.');
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'revoked', terminal: true }), 'The sign-in was revoked or replaced. Automatic retries are paused.');
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'rejected', terminal: true }), 'The provider rejected the saved sign-in. Automatic retries are paused.');
  assert.equal(t.humanizeError({ lastError: 'x', errorKind: 'unreachable' }), "Couldn't reach the provider. Retrying automatically.");
  const other = t.humanizeError({ lastError: 'refresh failed: status=400 url=https:[redacted] body={"error": "invalid_grant",' });
  assert.ok(!/body=|url=|\{/.test(other) && !other.includes('\n'), other);
  assert.equal(t.humanizeError({}), '');
});

test('account state: the dot or pill, its word and the line under it; revoked / expired / refresh-failed each keep their own word', () => {
  const t = loadHelpers();
  const J2 = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(J2(t.acctState({ health: 'ok', signedIn: true, expiresInMs: 4.2 * 3600000 })), { tone: 'ok', word: 'Signed in', sub: 'renews in 4.2 h' });
  assert.deepEqual(J2(t.acctState({ health: 'ok', signedIn: true })), { tone: 'ok', word: 'Signed in', sub: '' });
  assert.deepEqual(J2(t.acctState({ health: 'expiring', signedIn: true, expiresInMs: 8 * 60000 })), { tone: 'warn', word: 'Expiring soon', sub: 'expires in 8 min' });
  assert.deepEqual(J2(t.acctState({ health: 'expired', signedIn: true, expiresInMs: -53 * 86400000 })), { tone: 'bad', word: 'Expired', sub: 'expired 53 d ago' });
  assert.deepEqual(J2(t.acctState({ health: 'expired', errorKind: 'revoked', expiresInMs: -3.2 * 3600000 })), { tone: 'bad', word: 'Revoked', sub: 'expired 3.2 h ago' });
  assert.deepEqual(J2(t.acctState({ health: 'refresh-failed', expiresInMs: -600000 })), { tone: 'bad', word: 'Refresh failed', sub: 'expired 10 min ago' });
  assert.deepEqual(J2(t.acctState({ health: 'missing', signedIn: false })), { tone: 'off', word: 'Not signed in', sub: '' });
  assert.ok(t.isAvailable({ health: 'missing' }) && !t.isAvailable({ health: 'ok' }));
});

test('the identity line is drawn only for an account the host reports one for', () => {
  const t = loadHelpers();
  assert.equal(t.hasIdentity({ email: 'a@x.io' }), true);
  assert.equal(t.hasIdentity({ plan: 'Team' }), true);
  for (const id of [null, undefined, {}, { email: null, plan: null, org: null }]) assert.equal(t.hasIdentity(id), false);
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

test('the Claude plan card (design C) draws one ring per reported window, the DSH counts once, and leaves the counts out when unknown', () => {
  const t = loadWithReact(fakeReact);
  const plan = { mode: 'plan', fiveHour: { percent: 12, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, sevenDay: { percent: 84, resetsAt: new Date(Date.now() + 86400e3).toISOString() }, scopedWeekly: { percent: 30, label: 'Fable', resetsAt: new Date(Date.now() + 86400e3).toISOString() }, extraKnown: true, extraEnabled: true };
  const labels = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => labels(x, out)); return out; } if (n.props) { if (n.props['aria-label']) out.push(n.props['aria-label']); labels(n.props.children, out); } if (n.type && typeof n.type === 'function' && n.props) labels(n.type(n.props), out); return out; };
  const tree = t.planCardBody({ plan: { ...plan, messages: 13, modelCalls: 29 }, identity: { email: 'a@b.c', plan: 'Team', org: 'Lab' } }, false, null, null);
  const shown = texts(expandAll(tree)).join('|');
  assert.match(shown, /Claude plan usage/);
  assert.match(shown, /12%\|used/);
  assert.match(shown, /84%\|used/);
  assert.match(shown, /30%/);
  assert.match(shown, /5-hour window\|resets /);
  assert.match(shown, /Weekly, all models\|resets /);
  assert.match(shown, /Fable, weekly\|resets /);
  assert.match(shown, /13\| messages · \|29\| model calls in this 5-hour window\./);
  assert.equal((shown.match(/Every Claude app on this account\./g) || []).length, 1, 'said once');
  assert.ok(!/Messages from DSH|Model calls from DSH|Usage % counts every|Sent from DSH/.test(shown), 'no tiles, no repeats of the rings in words');
  assert.match(labels(expandAll(tree)).join('|'), /5-hour window: 12% used, resets /, 'a ring states its value for screen readers');
  const unknown = texts(expandAll(t.planCardBody({ plan: { ...plan, messages: null, modelCalls: null }, identity: null }, false, null, null))).join('|');
  assert.ok(!/model calls in this/.test(unknown), 'unknown counts are left out, never 0');
  assert.match(texts(expandAll(t.planCardBody({ plan: { mode: 'api' } }, false, null, null))).join('|'), /API key/);
  assert.equal(t.ringRows(t.planWindows(plan)).length, 1);
  const idle = { ...plan, fiveHour: null };
  const idleWins = t.planWindows(idle);
  assert.equal(idleWins[0].key, 'fiveHour', 'no 5-hour reading on a live plan: the ring stays');
  assert.equal(idleWins[0].idle, true);
  const idleShown = texts(expandAll(t.planCardBody({ plan: idle, identity: null }, false, null, null))).join('|');
  assert.match(idleShown, /5-hour window\|not started/, 'the empty ring says the window has not started');
  assert.ok(!t.planWindows({ ...plan, mode: 'unavailable', fiveHour: null }).some((w) => w.idle), 'an unavailable plan never claims "not started"');
  assert.equal(t.ringRows(t.planWindows({ ...plan, sevenDayOpus: { percent: 5, resetsAt: null }, sevenDaySonnet: { percent: 6, resetsAt: null } })).length, 2, 'more than one small ring goes on a second row');
});

test('plan card states: signed out / expired / API key collapse to the title and one line, with no rings and no switch', () => {
  const t = loadWithReact(fakeReact);
  const SW = h0('SWITCH');
  for (const [plan, pill, line] of [[{ mode: 'signed-out' }, null, /^Not signed in\./], [{ mode: 'expired' }, 'Expired', /^The Claude sign-in expired\./], [{ mode: 'api' }, 'API key', /^Requests use an Anthropic API key/]]) {
    const tree = expandAll(t.planCardBody({ plan, identity: { email: 'x@y.z' } }, false, SW, null));
    const out = texts(tree);
    assert.ok(out.includes('Claude plan usage'), plan.mode);
    assert.equal(out.includes('Expired') || out.includes('API key'), pill !== null, plan.mode);
    if (pill) assert.ok(out.includes(pill), plan.mode);
    assert.ok(out.some((x) => line.test(x)), plan.mode + ': ' + out.join('|'));
    assert.equal(findAll(tree, (n) => n.props.className === 'dshMh-pc-rings').length, 0, plan.mode + ': no rings');
    assert.ok(!out.includes('SWITCH'), plan.mode + ': no switch row');
    assert.ok(!out.includes('x@y.z'), plan.mode + ': no identity line');
  }
});

test('plan card: unavailable keeps the last reading in grey rings and says when it was read; demo has the banner and no switch', () => {
  const t = loadFixed();
  const plan = { mode: 'unavailable', httpStatus: 429, fiveHour: { percent: 41, resetsAt: new Date(FC_AT(17, 0)).toISOString() }, sevenDay: { percent: 57, resetsAt: new Date(FC_AT(14, 0, 3)).toISOString() }, extraKnown: true };
  const fc = { estimate: true, generatedAt: FC_NOW, plan: { lastReadingAt: FC_NOW - 12 * 60e3, windows: {} } };
  const tree = expandAll(t.planCardBody({ plan, identity: null }, false, h0('SWITCH'), fc));
  const out = texts(tree);
  assert.ok(out.includes('Plan usage unavailable (429). Last reading 12 min ago.'), out.join('|'));
  assert.ok(out.includes('41%') && out.includes('57%'));
  assert.equal(findAll(tree, (n) => typeof n.props.className === 'string' && /dshMh-pr-arc is-grey/.test(n.props.className)).length, 2, 'the arcs are grey');
  assert.equal(findAll(tree, (n) => typeof n.props.className === 'string' && /dshMh-pr-arc is-(ok|warn|full)/.test(n.props.className)).length, 0);
  assert.ok(out.includes('SWITCH'), 'the plan stop still applies while the reading is unavailable');
  assert.equal(t.planUnavailableLine(plan, null), 'Plan usage unavailable (429).', 'no reading time known: say nothing about it');
  assert.equal(t.planUnavailableLine({ mode: 'unavailable', httpStatus: null }, null), 'Plan usage unavailable (?).');
  const demo = expandAll(t.planCardBody({ plan: { ...plan, mode: 'plan' }, identity: null, demo: true }, false, h0('SWITCH'), null));
  assert.equal(demo.props.children[0].props['data-testid'], 'demo-banner');
  assert.ok(!texts(demo).includes('SWITCH'), 'a demo hub refuses changes: no switch row');
});

test('ring geometry: dashed est. arc sits between the used arc and the top, never on the cap, and only when it fits two dashes', () => {
  const t = loadHelpers();
  const g = t.PLAN_RING.lg;
  const a = t.estArc(g.box, g.r, g.stroke, 84);
  assert.match(a.d, /^M24\.\d+ 24\.\d+ A53 53 0 0 1 52\.\d+ 9\.\d+$/, 'the board\'s arc: from about 315 to 349 degrees');
  assert.match(a.dash, /^3\.6 5\.\d+$/);
  assert.equal(t.estArc(g.box, g.r, g.stroke, 100), null, 'a full ring has no path to full');
  assert.equal(t.estArc(g.box, g.r, g.stroke, 99), null, 'too short for two dashes');
  assert.ok(t.estArc(g.box, g.r, g.stroke, 50), 'half way: a long arc');
  assert.equal(t.estArc(g.box, g.r, g.stroke, 'x') !== null, true, 'a non-number counts as 0');
  // states: ok under 80, warn from 80, full at 100
  assert.deepEqual(['ok', 'warn', 'warn', 'full'].map((x, i) => t.planRingState([79, 80, 99, 100][i]) === x), [true, true, true, true]);
});

test('planEstimate: the est. row from the forecast; arcs only for a window that reaches 100% before its reset', () => {
  const t = loadFixed();
  const plan = { ...PLAN_NOW };
  const both = t.planEstimate(plan, planFc());
  assert.equal(both.kind, 'est');
  assert.deepEqual(J(both.arcs), { fiveHour: true, sevenDay: false });
  const lines = both.lines.map((l) => l.map((x) => (typeof x === 'string' ? x : x.b)).join(''));
  assert.match(lines[0], /^5-hour fills around \S+ ?\S* \(range \S+–\S+ ?\S*\), before its reset\.$/);
  assert.equal(lines[1], 'Weekly stays under 100% until its reset.');
  assert.deepEqual(J(both.lines[0][1]), { b: fcLoc(FC_AT(16, 20)) }, 'the time is the emphasised part');
  const none = t.planEstimate(plan, planFc(fcWin({ status: 'no-limit', earliestAt: null, mayReach: false }), NOLIMIT7));
  assert.deepEqual(J(none.lines), [['At this pace neither window fills before its reset.']]);
  assert.deepEqual(J(none.arcs), { fiveHour: false, sevenDay: false });
  const hedged = t.planEstimate(plan, planFc(fcWin({ status: 'no-limit', earliestAt: FC_AT(16, 40), mayReach: true }), NOLIMIT7));
  assert.match(hedged.lines[0][0], /^5-hour probably stays under 100%/);
  const few = t.planEstimate(plan, planFc(fcWin({ status: 'insufficient' }), fcWin({ status: 'insufficient', resetsAt: PLAN_NOW.sevenDay.resetsAt })));
  assert.deepEqual(J(few), { kind: 'insufficient', lines: [['Not enough readings yet']], arcs: { fiveHour: false, sevenDay: false } });
  assert.equal(t.planEstimate(plan, planFc(fcWin({ status: 'stale' }), fcWin({ status: 'reset' }))), null, 'stale or reset windows say nothing');
  assert.equal(t.planEstimate(plan, null), null);
  assert.equal(t.planEstimate({ ...plan, mode: 'unavailable' }, planFc()), null, 'no estimate on an unavailable reading');
  assert.equal(t.planEstimate(plan, planFc({ ...LIMIT5, resetsAt: new Date(FC_AT(12, 0)).toISOString() }, NOLIMIT7)).lines.length, 1, 'a window fitted to another reset is ignored');
  assert.match(t.fmtClockRange(FC_AT(15, 55), FC_AT(16, 30)), /^\S+–\S+ ?(PM)?$/);
});

test('planFooter: what happens past a full window, once; a full window with the stop on says requests are refused until the reset', () => {
  const t = loadFixed();
  const base = { mode: 'plan', extraKnown: true, extraEnabled: true };
  assert.equal(t.planFooter(base, false), 'Extra usage is on for this account: past a full window, requests bill to your Anthropic balance.');
  assert.equal(t.planFooter({ ...base, extraEnabled: false }, false), 'Extra usage is off for this account: Anthropic refuses requests once a window is full.');
  assert.match(t.planFooter({ mode: 'plan', extraKnown: false }, false), /which was not reported\.$/);
  assert.equal(t.planFooter(base, true), 'DSH refuses Claude requests in a full window until it resets. Extra usage stays on for the account, but DSH will not draw on it.');
  assert.equal(t.planFooter({ ...base, extraEnabled: false }, true), 'DSH refuses Claude requests in a full window until it resets.');
  const full = { ...base, fetchedAt: FC_NOW - 1000, fiveHour: { percent: 100, resetsAt: new Date(FC_AT(17, 49)).toISOString() } };
  assert.equal(t.planFooter(full, true), 'Your 5-hour window is full. DSH refuses Claude requests until it resets (' + fcLoc(FC_AT(17, 49)) + ').');
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
  const odd = t.priceTable({ 'mistral/large-3': { priced: false, billing: 'metered' }, 'my-alias': { priced: true, billing: 'metered', inPerM: 1, outPerM: 2 } }, null, null);
  assert.deepEqual(J(odd.map((r) => [r.split, r.provider, r.model])), [[false, 'my-alias', 'my-alias'], [true, 'mistral', 'large-3']], 'a provider without an icon still reads provider / model; a bare alias stays whole');
});

test('the hub has no overview strip: the Costs card says the spend, the cap and the GPU header says the rest, once', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!/overviewTiles|dshMh-tile2|dshMh-tiles/.test(src));
  const t = loadHelpers();
  assert.deepEqual(JSON.parse(JSON.stringify(t.hubStatusLine({ reachable: true, spendGuard: true, error: null }))), { tone: 'ok', text: 'Hub connected · spend guard on' });
  assert.deepEqual(JSON.parse(JSON.stringify(t.hubStatusLine({ reachable: true, spendGuard: false, error: null }))), { tone: 'ok', text: 'Hub connected' });
  assert.deepEqual(JSON.parse(JSON.stringify(t.hubStatusLine({ reachable: false, error: 'x' }))), { tone: 'bad', text: 'Hub not reachable' });
  assert.deepEqual(JSON.parse(JSON.stringify(t.hubStatusLine({ reachable: false, error: null }))), { tone: 'off', text: 'Connecting…' });
});

test('the Costs card renders the headline, the cap rows, billing as words and the outside-DSH table from the spend payload', () => {
  const t = loadWithReact(fakeReact);
  const today = { data: {
    totals: { usd: 0, apiEquivUsd: 0.95, calls: 14 }, complete: true,
    byProvider: { anthropic: { usd: 0, apiEquivUsd: 0.95, calls: 14, billing: 'subscription' } },
    caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
    external: { totals: { usd: 1.7, calls: 287 }, byProvider: { nearai: { usd: 1.7, calls: 287 } } },
  }, error: null };
  // expand child components (CostHero, CapRowsBlock, ProviderIcon) the way React would, then collect the text
  const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
  const out = texts(expand(t.CostsPanel({ today, gcfg: null }))).join('|');
  for (const want of ['Charged today, in DSH', '$0.00', 'API value, not charged', '$0.95', '14 calls', 'Caps and plan credits', 'Edit caps', 'Today', '$0.00| of $40.00', 'Latest session', '$0.00| of $15.00', 'By provider', 'Subscription', 'anthropic', 'Outside DSH', 'nearai', '$1.70', 'never capped']) assert.ok(out.includes(want), want + ' in ' + out);
  assert.ok(!out.includes('Within caps'), 'a pill only for an exception');
  assert.ok(!out.includes('Meter|'), 'the outside rows are a table, not a Meter pill');
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
  assert.equal(a.label, 'Ollama Pro credits'); assert.equal(a.reset, 'Dec 9'); assert.equal(a.value, '$15.00 of $60.00'); assert.equal(a.pct, 25); assert.equal(a.frac, 0.25); assert.equal(a.tone, 'accent');
  assert.equal(b.value, '$12.50 of $10.00'); assert.equal(b.tone, 'danger'); assert.equal(b.over, 2.5); assert.equal(b.partial, true);
  assert.deepEqual(J(t.planRows(null)), []);
  const m = t.chipModel(null, { caps: { action: 'ok', reason: 'ok', todayUsd: 0, limits: { dailyUsd: 40 } }, totals: { usd: 0, calls: 0 }, plans: d.plans }, null);
  assert.deepEqual(J(m.plans.map((p) => [p.key, p.text, p.ring])), [['ollama', '25%', 'ok'], ['acme', '100%', 'over']]);
  assert.deepEqual(J(t.chipModel(null, null, null).plans), []);
});

test('the Costs card renders the credits word, a plan row with its runway, and the declared label', () => {
  const t = loadWithReact(fakeReact);
  const today = { data: {
    totals: { usd: 0, apiEquivUsd: 1.2, calls: 3 }, complete: true,
    byProvider: { ollama: { usd: 0, apiEquivUsd: 1.2, calls: 3, billing: 'credits' }, zai: { usd: 0, apiEquivUsd: 0.5, calls: 1, billing: 'subscription' } },
    caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
    plans: [{ provider: 'ollama', name: 'Pro', includedUsd: 60, usedUsd: 1.2, overageUsd: 0, remainingUsd: 58.8, resetsAt: '2026-12-09T00:00:00.000Z', complete: true }],
  }, error: null };
  const expand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(expand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return expand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: expand(n.props.children) } } : n; };
  const out = texts(expand(t.CostsPanel({ today, gcfg: null, declared: ['zai'] }))).join('|');
  for (const want of ['Credits', 'Ollama Pro credits', 'resets Dec 9', '$1.20| of $60.00', 'Subscription · declared']) assert.ok(out.includes(want), want + ' in ' + out);
  // declared label comes from /hub/config subscriptions (a pure helper here, the poll is a hook)
  const decl = t.billingText('subscription', 'zai', ['zai']);
  assert.equal(decl.text, 'Subscription · declared'); assert.match(decl.title, /Declared in config\.json/);
  assert.equal(t.billingText('subscription', 'anthropic', ['zai']).text, 'Subscription');
  assert.match(t.billingText('credits', 'ollama', []).title, /prepaid credits/);
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
  assert.ok(src.includes('testid: "caps-invalid"') && src.includes('"data-testid": w.testid'), 'banner has its test id');
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
  assert.deepEqual(J(d), { dailyUsd: '40.00', sessionUsd: '15.00', warnPct: '50', providers: [{ id: 'google', usd: '5.00' }], stopAtPlanLimit: false });
  assert.equal(t.capsDraft({ ...CAPS_VIEW, stopAtPlanLimit: true }).stopAtPlanLimit, true);
  assert.deepEqual(J(t.capsChanges(d, CAPS_VIEW)), { ok: true, changes: {} });
  assert.deepEqual(J(t.capsChanges({ ...d, dailyUsd: '25' }, CAPS_VIEW)), { ok: true, changes: { dailyUsd: 25 } });
  assert.deepEqual(J(t.capsChanges({ ...d, providers: [] }, CAPS_VIEW)), { ok: true, changes: { 'provider.google': null } });
  assert.deepEqual(J(t.capsChanges({ ...d, providers: [...d.providers, { id: 'xai', usd: '2.5' }] }, CAPS_VIEW)), { ok: true, changes: { 'provider.xai': 2.5 } });
  assert.deepEqual(J(t.capsChanges({ ...d, dailyUsd: '0', warnPct: '80' }, CAPS_VIEW)), { ok: true, changes: { dailyUsd: 0, warnPct: 80 } });
  assert.deepEqual(J(t.capsChanges({ ...d, providers: [...d.providers, { id: '', usd: '' }] }, CAPS_VIEW)), { ok: true, changes: {} }, 'a blank added row is ignored');
  assert.deepEqual(J(t.capsDraft(null)).providers, []);
});

test('the plan-stop switch is saved with Save: only when it differs, and a repair sends it too when the host reports it', () => {
  const t = loadHelpers();
  const v = { ...CAPS_VIEW, stopAtPlanLimit: false };
  const d = t.capsDraft(v);
  assert.deepEqual(J(t.capsChanges(d, v)), { ok: true, changes: {} });
  assert.deepEqual(J(t.capsChanges({ ...d, stopAtPlanLimit: true }, v)), { ok: true, changes: { stopAtPlanLimit: true } });
  assert.deepEqual(J(t.capsChanges({ ...d, stopAtPlanLimit: false, dailyUsd: '25' }, { ...v, stopAtPlanLimit: true })), { ok: true, changes: { dailyUsd: 25, stopAtPlanLimit: false } });
  // a view that does not report it (an older host) leaves it alone; so does a draft without it
  assert.deepEqual(J(t.capsChanges({ ...d, stopAtPlanLimit: undefined }, v)), { ok: true, changes: {} });
  const bad = { ...v, problem: 'caps.json invalid: x; using defaults' };
  assert.equal(t.capsChanges(t.capsDraft(bad), bad).changes.stopAtPlanLimit, false, 'Save on a corrupt file rewrites everything, the switch included');
  assert.equal(t.stopDescription({ mode: 'plan', extraKnown: true, extraEnabled: true }, false), 'Extra usage is on for this account: past a full window, requests bill to your Anthropic balance.');
  assert.equal(t.stopDescription({ mode: 'signed-out' }, true), 'DSH refuses Claude requests in a full plan window until it resets.');
});

test('capsChanges(draft, view, opened): only the keys the user changed since the editor opened are sent, whatever the live view says now', () => {
  const t = loadHelpers();
  const opened = t.capsDraft(CAPS_VIEW);
  // meanwhile: the plan-stop switch was turned on from the plan card, the daily cap was changed from the CLI and a provider cap added
  const live = { caps: { dailyUsd: 50, sessionUsd: 15, warnPct: 50, perProviderDailyUsd: { google: 5, xai: 2 } }, stopAtPlanLimit: true };
  assert.deepEqual(J(t.capsChanges({ ...opened, sessionUsd: '20' }, live, opened)), { ok: true, changes: { sessionUsd: 20 } });
  // untouched, the editor sends nothing at all
  assert.deepEqual(J(t.capsChanges(opened, live, opened)), { ok: true, changes: {} });
  // what the user did change is still sent, even when it now equals nothing the view knows
  assert.deepEqual(J(t.capsChanges({ ...opened, dailyUsd: '25', stopAtPlanLimit: true, providers: [] }, live, opened)), { ok: true, changes: { dailyUsd: 25, 'provider.google': null } });
  assert.deepEqual(J(t.capsChanges({ ...opened, stopAtPlanLimit: true }, { ...live, stopAtPlanLimit: false }, opened)), { ok: true, changes: { stopAtPlanLimit: true } });
  assert.deepEqual(J(t.capsChanges({ ...opened, providers: [{ id: 'google', usd: '7' }] }, live, opened)), { ok: true, changes: { 'provider.google': 7 } });
  // a corrupt caps.json is still repaired in full
  const bad = { ...live, problem: 'caps.json invalid' };
  assert.ok(Object.keys(t.capsChanges(opened, bad, opened).changes).length >= 4);
  // submit passes the opened draft through
  const calls = [];
  return t.submitCapsDraft({ ...opened, sessionUsd: '20' }, live, (p, b) => { calls.push([p, b]); return Promise.resolve({}); }, opened).then(() => assert.deepEqual(J(calls), [['/caps', { set: { sessionUsd: 20 } }]]));
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

test('CapsForm renders labelled money fields with units, Save/Cancel, aria-invalid + described errors, the plan-stop switch, and disables everything while busy', () => {
  const t = loadWithReact(fakeReact);
  const draft = { dailyUsd: '40.00', sessionUsd: '', warnPct: '50', providers: [{ id: 'google', usd: '5.00' }], stopAtPlanLimit: false };
  const noop = () => {};
  const render = (p) => expandAll(t.CapsForm({ draft, errors: {}, busy: false, onChange: noop, onSubmit: noop, onCancel: noop, firstRef: { current: null }, stopDescription: 'Extra usage is on.', ...p }));
  const tree = render({ errors: { sessionUsd: 'Number from 0 to 1,000,000.' } });
  const out = texts(tree).join('|');
  for (const want of ['Daily cap', 'Session cap', 'Alert at', 'per day', 'per session', '% of a cap', 'Provider caps, per day', 'Add provider cap', 'Remove', 'Save', 'Cancel', 'Stop Claude requests at 100% of a plan window', 'Extra usage is on.']) assert.ok(out.includes(want), want + ' in ' + out);
  const input = (id) => findAll(tree, (n) => n.type === 'input' && n.props.id === id)[0];
  for (const id of ['dshMh-cap-daily', 'dshMh-cap-session', 'dshMh-cap-warn']) {
    const i = input(id);
    assert.equal(i.props.type, 'text', id + ' is validated as text, never a number spinner');
    assert.equal(i.props.inputMode, 'decimal', id);
    assert.ok(findAll(tree, (n) => n.type === 'label' && n.props.htmlFor === id).length === 1, 'label for ' + id);
  }
  assert.equal(input('dshMh-cap-daily').props['aria-invalid'], undefined);
  assert.equal(input('dshMh-cap-session').props['aria-invalid'], 'true');
  const desc = input('dshMh-cap-session').props['aria-describedby'];
  assert.ok(findAll(tree, (n) => n.props.id === desc).length === 1 && texts(findAll(tree, (n) => n.props.id === desc)).join('').includes('Number from 0'));
  assert.equal(findAll(tree, (n) => n.props.id === desc)[0].props.role, 'alert');
  assert.equal(input('dshMh-cap-daily').props['aria-describedby'], undefined);
  assert.equal(input('dshMh-cap-p0-id').props['aria-label'], 'Provider id, row 1');
  assert.equal(input('dshMh-cap-p0-usd').props['aria-label'], 'Dollars per day for google');
  const form = findAll(tree, (n) => n.type === 'form')[0];
  assert.equal(findAll(tree, (n) => n.type === 'fieldset')[0].props.disabled, false);
  const busy = render({ busy: true });
  assert.equal(findAll(busy, (n) => n.type === 'fieldset')[0].props.disabled, true);
  assert.ok(texts(busy).includes('Saving…'));
  assert.ok(form.props.noValidate);
  // typing calls onChange with the next draft (strings), not mutating the old one
  let next; const typed = expandAll(t.CapsForm({ draft, errors: {}, busy: false, onChange: (d) => { next = d; }, onSubmit: noop, onCancel: noop, firstRef: { current: null } }));
  findAll(typed, (n) => n.type === 'input' && n.props.id === 'dshMh-cap-daily')[0].props.onChange({ target: { value: '25' } });
  assert.equal(next.dailyUsd, '25'); assert.equal(draft.dailyUsd, '40.00');
  findAll(typed, (n) => n.type === 'button' && texts(n).join('') === 'Remove')[0].props.onClick();
  assert.deepEqual(J(next.providers), []);
  findAll(typed, (n) => n.type === 'button' && texts(n).join('') === 'Add provider cap')[0].props.onClick();
  assert.equal(next.providers.length, 2);
  // the plan-stop row is the plan card's own switch; it changes the draft, and Save sends it
  const sw = findAll(typed, (n) => n.props && n.props.role === 'switch')[0];
  assert.equal(sw.props['aria-checked'], 'false');
  sw.props.onClick();
  assert.equal(next.stopAtPlanLimit, true); assert.equal(draft.stopAtPlanLimit, false);
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

test('the tooltip lines are one source (planLines) for the chip and the popover; the card says each fact once in its own words', () => {
  const t = loadWithReact(fakeReact);
  const ident = { email: 'a@b.c', plan: 'Max' };
  const table = [FULL_PLAN, { mode: 'plan', fiveHour: { percent: 3, resetsAt: null } }, { mode: 'unavailable', httpStatus: 429, fetchedAt: 1e12, fiveHour: { percent: 12, resetsAt: IN1H } }, { mode: 'api' }, { mode: 'signed-out' }, { mode: 'expired' }];
  for (const plan of table) {
    const lines = J(t.planLines(plan));
    const signedIn = plan.mode === 'plan' || plan.mode === 'unavailable';
    assert.deepEqual(J(t.chipModel(plan, null, null, ident).claude.lines), (signedIn ? [t.identityLine(ident)] : []).concat(lines), plan.mode);
    assert.deepEqual(J(t.planCardLines(plan, ident)), J(t.chipModel(plan, null, null, ident).claude.lines));
    const card = texts(expandAll(t.planCardBody({ plan, identity: ident }, false, null, null)));
    assert.ok(!card.includes(CAPTION), plan.mode + ': the long caption is the tooltip\'s, not the card\'s');
  }
  assert.match(t.chipModel(FULL_PLAN, null, null, ident).claude.summary, /^Claude plan usage: 5-hour window 12%, weekly 84%$/);
  assert.match(t.chipModel({ mode: 'api' }, null, null, null).claude.summary, /API key/);
});

const dockRender = (plan, { open = false, dom } = {}) => {
  const t = loadWithReact({ ...fakeReact, useState: (i) => [i === null ? open : i, () => {}], useId: () => 'x', useCallback: (f) => f }, dom);
  return { t, tree: expandAll(t.DockChip({ plan, spend: null, cache: null, identity: { email: 'a@b.c' } })) };
};

test('the dock chip is ONE button: labelled with the three segments, described by the plan lines, three hairline-separated segments', () => {
  const { t, tree } = dockRender(FULL_PLAN);
  const btns = findAll(tree, (n) => n.type === 'button');
  assert.equal(btns.length, 1, 'one button');
  const btn = btns[0];
  assert.equal(btn.props.type, 'button');
  assert.equal(btn.props['data-testid'], 'model-hub-chip');
  assert.equal(btn.props['aria-expanded'], 'false');
  assert.equal(btn.props['aria-label'], t.chipModel(FULL_PLAN, null, null, { email: 'a@b.c' }).label);
  assert.match(btn.props['aria-label'], /^Claude 5-hour window 12% used\./);
  assert.equal(btn.props['aria-describedby'], 'dshMh-claude-tip');
  assert.equal(btn.props.title, undefined, 'no native title: tooltips never stack');
  for (const k of ['onMouseEnter', 'onMouseLeave', 'onFocus', 'onBlur', 'onKeyDown']) assert.equal(typeof btn.props[k], 'function', k);
  const tip = findAll(tree, (n) => n.props.id === 'dshMh-claude-tip')[0];
  assert.ok(tip && /dshMh-sr/.test(tip.props.className), 'the always-rendered description exists');
  assert.deepEqual(J(findAll(tip, (n) => n.type === 'div').map((n) => n.props.children)), J(t.chipModel(FULL_PLAN, null, null, { email: 'a@b.c' }).claude.lines));
  const segs = findAll(btn, (n) => typeof n.props.className === 'string' && /^dshMh-chipseg /.test(n.props.className));
  assert.equal(segs.length, 3, 'Claude, Today, Cache');
  assert.deepEqual(segs.map((x) => texts(x).filter((y) => /^(5h|Today|Cache)$/.test(y))[0]), ['5h', 'Today', 'Cache']);
  assert.equal(findAll(btn, (n) => n.props.className === 'dshMh-chip-div').length, 2, 'a hairline before Today and before Cache');
});

test('chipModel: every state of the T3 board (words, tone, ring, accessible label)', () => {
  const t = loadWithReact(fakeReact);
  const spend = (today, action, dailyUsd = 40) => ({ totals: { usd: today, calls: 3 }, caps: { action, which: action === 'ok' ? null : 'daily', reason: 'x', todayUsd: today, limits: { dailyUsd } } });
  const cache = (hit) => ({ latest: { steps: 3, lastHit: hit, avgHit: 0.5 } });
  const win = (p) => ({ mode: 'plan', fiveHour: { percent: p, resetsAt: IN1H }, sevenDay: { percent: 30, resetsAt: IN1D } });
  const ok = t.chipModel(win(2), spend(9.31, 'ok'), cache(0.71));
  assert.equal(ok.label, 'Claude 5-hour window 2% used. Charged today $9.31 of the $40.00 daily cap. Prompt cache 71% on the last step.');
  assert.deepEqual([ok.claude.text, ok.claude.tone, ok.today.text, ok.today.ring, ok.cache.text, ok.cache.tone], ['2%', 'ok', '$9.31', 'ok', '71%', 'ok']);
  const warn = t.chipModel(win(84), spend(31.2, 'warn'), cache(0.71));
  assert.equal(warn.label, 'Claude 5-hour window 84% used, warning. Charged today $31.20 of the $40.00 daily cap, warning. Prompt cache 71% on the last step.');
  assert.deepEqual([warn.claude.tone, warn.today.tone, warn.today.ring], ['warn', 'warn', 'warn']);
  const over = t.chipModel(win(100), spend(41, 'block'), cache(0.71));
  assert.equal(over.label, 'Claude 5-hour window full. Daily cap reached. Prompt cache 71% on the last step.');
  assert.deepEqual([over.claude.text, over.claude.tone, over.today.text, over.today.tone, over.today.ring], ['100%', 'danger', 'Cap reached', 'danger', 'over']);
  const out = t.chipModel({ mode: 'signed-out' }, spend(9.31, 'ok'), cache(0.71));
  assert.equal(out.label, 'Claude: not signed in. Charged today $9.31 of the $40.00 daily cap. Prompt cache 71% on the last step.');
  assert.deepEqual([out.claude.kind, out.claude.text, out.claude.tone], ['signedout', 'Signed out', 'quiet']);
  const exp = t.chipModel({ mode: 'expired' }, spend(9.31, 'ok'), cache(0.71));
  assert.equal(exp.label.split('. ')[0], 'Claude sign-in expired');
  assert.deepEqual([exp.claude.kind, exp.claude.text, exp.claude.tone], ['expired', 'Sign-in expired', 'danger']);
  const api = t.chipModel({ mode: 'api' }, spend(9.31, 'ok'), cache(0.71));
  assert.equal(api.label.split('. ')[0], 'Claude on an API key, billed per token');
  assert.deepEqual([api.claude.kind, api.claude.text], ['api', 'API key']);
  const un = t.chipModel({ ...win(2), mode: 'unavailable', httpStatus: 429 }, spend(9.31, 'ok'), cache(0.71));
  assert.equal(un.label.split('. ')[0], 'Claude plan usage unavailable, last reading 2%');
  assert.deepEqual([un.claude.grey, un.claude.tone, un.claude.text], [true, 'quiet', '2%']);
  const drop = t.chipModel(win(2), spend(9.31, 'ok'), cache(0.02));
  assert.equal(drop.label.split('. ').at(-1), 'Prompt cache dropped to 2% on the last step.');
  assert.deepEqual([drop.cache.tone, drop.cache.text], ['warn', '2%']);
  const nocap = t.chipModel(win(2), spend(9.31, 'ok', 0), { latest: null });
  assert.equal(nocap.label, 'Claude 5-hour window 2% used. Charged today $9.31, no daily cap. Prompt cache: no reading yet.');
  assert.deepEqual([nocap.today.ring, nocap.cache.text, nocap.cache.tone], [null, '—', 'quiet'], 'no ring without a cap; no cache reading shows a dash');
  const demo = t.chipModel(win(2), spend(9.31, 'ok'), cache(0.71), null, false, true);
  assert.equal(demo.label, 'Demo data: synthetic, nothing is recorded or capped. Claude 5-hour window 2% used. Charged today $9.31 of the $40.00 daily cap. Prompt cache 71%.'.replace('Demo data: synthetic', 'DEMO DATA: synthetic'));
});

test('chipModel: a session or provider cap in trouble reads "Cap reached" / "Near a cap", never "Daily cap reached"; the daily ring keeps its own fraction and tone', () => {
  const t = loadWithReact(fakeReact);
  const spend = (which, action, today = 8, dailyUsd = 40) => ({ totals: { usd: today, calls: 3 }, caps: { action, which, reason: 'a cap', todayUsd: today, limits: { dailyUsd, warnPct: 80 } } });
  const win = { mode: 'plan', fiveHour: { percent: 2, resetsAt: IN1H }, sevenDay: { percent: 30, resetsAt: IN1D } };
  const cache = { latest: { steps: 3, lastHit: 0.71, avgHit: 0.5 } };
  for (const which of ['session', 'provider-daily']) {
    const b = t.chipModel(win, spend(which, 'block'), cache);
    assert.deepEqual([b.today.text, b.today.tone, b.today.ring, b.today.pct], ['Cap reached', 'danger', 'ok', 20], which);
    assert.equal(b.today.ringLabel, 'DSH spend today: $8.00 of the $40.00 daily cap', which);
    assert.equal(b.today.sentence, 'Cap reached. Charged today $8.00 of the $40.00 daily cap.', which);
    assert.ok(!/daily cap reached/i.test(b.label), b.label);
    const w = t.chipModel(win, spend(which, 'warn'), cache);
    assert.deepEqual([w.today.text, w.today.tone, w.today.ring], ['Near a cap', 'warn', 'ok'], which);
    assert.equal(w.today.sentence, 'Near a cap. Charged today $8.00 of the $40.00 daily cap.', which);
  }
  // no daily cap at all: no ring, still the cap's own words
  const off = t.chipModel(win, spend('session', 'block', 8, 0), cache);
  assert.deepEqual([off.today.text, off.today.ring, off.today.sentence], ['Cap reached', null, 'Cap reached. Charged today $8.00, no daily cap.']);
  // the daily ring follows its own numbers: past the warning level it warns, at the cap it is full
  assert.equal(t.chipModel(win, spend('session', 'block', 36), cache).today.ring, 'warn');
  assert.equal(t.chipModel(win, spend('session', 'block', 40), cache).today.ring, 'over');
  // the daily cap itself is unchanged
  const d = t.chipModel(win, spend('daily', 'block', 41), cache);
  assert.deepEqual([d.today.text, d.today.ring, d.today.ringLabel, d.today.sentence], ['Cap reached', 'over', 'DSH spend today: daily cap reached', 'Daily cap reached.']);
  const dw = t.chipModel(win, spend('daily', 'warn', 33), cache);
  assert.deepEqual([dw.today.text, dw.today.ring, dw.today.sentence], ['$33.00', 'warn', 'Charged today $33.00 of the $40.00 daily cap, warning.']);
  // a model without a price warns about the price, not about a cap
  assert.equal(t.chipModel(win, spend('unpriced', 'warn'), cache).today.text, '$8.00');
});

test('popoverModel: only the daily cap\'s own block or warning forces the runway; a session or provider cap leaves the daily fraction and tone', () => {
  const t = loadFixed();
  const base = { plan: PLAN_NOW, fc: null, identity: null, stop: false };
  const sp = (which, action, today = 8) => ({ totals: { usd: today, calls: 3 }, caps: { action, which, todayUsd: today, limits: { dailyUsd: 40, warnPct: 80 } } });
  for (const which of ['session', 'provider-daily']) for (const action of ['block', 'warn']) {
    const m = t.popoverModel({ ...base, spend: sp(which, action) });
    assert.deepEqual([m.today.runFrac, m.today.tone], [0.2, 'accent'], which + ' ' + action);
  }
  const db = t.popoverModel({ ...base, spend: sp('daily', 'block', 8) });
  assert.deepEqual([db.today.runFrac, db.today.tone], [1, 'danger']);
  const dw = t.popoverModel({ ...base, spend: sp('daily', 'warn', 33) });
  assert.deepEqual([dw.today.runFrac, dw.today.tone], [33 / 40, 'warn']);
  assert.deepEqual([t.popoverModel({ ...base, spend: sp(null, 'ok') }).today.tone, t.popoverModel({ ...base, spend: sp(null, 'ok') }).today.runFrac], ['accent', 0.2]);
  // the rendered runway agrees with its label (20%), it is not forced to full
  const tree = expandAll(t.PlanPopover({ ...base, anchor: { left: 100, top: 600 }, spend: sp('session', 'block') }));
  const rail = findAll(tree, (n) => n.type === 'svg' && n.props.className === 'dshMh-runway')[0];
  assert.match(rail.props['aria-label'] || '', /20%\./);
  assert.ok(!/is-bad|rw-bad/.test(JSON.stringify(rail)), 'not red');
});

test('a ring never says 100% unless it is 100 or more: 99.6 reads 99% on the plan card, the popover and the chip', () => {
  const t = loadFixed();
  const plan = { mode: 'plan', fiveHour: { percent: 99.6, resetsAt: IN1H }, sevenDay: { percent: 99.5, resetsAt: IN1D }, sevenDayOpus: { percent: 99.9, resetsAt: IN1D }, extraKnown: true, extraEnabled: false };
  const card = texts(expandAll(t.planCardBody({ plan, identity: null }, false, null, null)));
  assert.ok(card.includes('99%'), card.join('|'));
  assert.ok(!card.includes('100%'), 'the ring centre: ' + card.join('|'));
  const pop = texts(expandAll(t.PlanPopover({ plan, fc: null, identity: null, stop: false, anchor: { left: 100, top: 600 }, spend: null })));
  assert.ok(pop.includes('99%'), pop.join('|'));
  assert.ok(!pop.includes('100%'), 'the popover model row: ' + pop.join('|'));
  const rings = findAll(expandAll(t.PlanPopover({ plan, fc: null, identity: null, stop: false, anchor: { left: 100, top: 600 }, spend: null })), (n) => n.type === 'svg' && typeof n.props['aria-label'] === 'string' && /% used/.test(n.props['aria-label']));
  assert.ok(rings.length >= 2 && rings.every((r) => /99% used/.test(r.props['aria-label'])), rings.map((r) => r.props['aria-label']).join('|'));
  const chip = t.chipModel(plan, { totals: { usd: 0, calls: 0 }, caps: { action: 'ok', todayUsd: 0, limits: { dailyUsd: 40 } }, plans: [{ provider: 'xai', name: 'Credits', includedUsd: 100, usedUsd: 99.6, resetsAt: null }] }, null);
  assert.equal(chip.claude.text, '99%');
  assert.match(chip.claude.summary, /^Claude plan usage: 5-hour window 99%, weekly 99%$/);
  assert.equal(chip.claude.sentence, 'Claude 5-hour window 99% used, warning.');
  assert.deepEqual([chip.plans[0].text, chip.plans[0].ring], ['99%', 'warn']);
  // a window that really is full still says so
  assert.equal(t.chipModel({ ...plan, fiveHour: { percent: 100, resetsAt: IN1H } }, null, null).claude.text, '100%');
  assert.deepEqual([99.4, 99.5, 99.6, 99.99, 100, 100.2, 0, 12.4, 12.5].map((x) => t.shownPct(x)), [99, 99, 99, 99, 100, 100, 0, 12, 13]);
});

test('Escape on the chip dismisses the popover; hover and keyboard focus open it', () => {
  let open = { left: 1, top: 1, width: 1, height: 1 }; const set = (v) => { open = v; };
  const t = loadWithReact({ ...fakeReact, useState: (i) => [i === null ? open : i, set], useId: () => 'x', useCallback: (f) => f }, { createPortal: (c) => c }, { document: { querySelector: () => ({}), body: {}, documentElement: {} } });
  const tree = expandAll(t.DockChip({ plan: FULL_PLAN, spend: null, cache: null, identity: null }));
  const btn = findAll(tree, (n) => n.type === 'button')[0];
  btn.props.onKeyDown({ key: 'a' });
  assert.notEqual(open, null);
  btn.props.onKeyDown({ key: 'Escape' });
  assert.equal(open, null);
  btn.props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 500, width: 80, height: 24 }) } });
  assert.deepEqual(J(open), { left: 10, top: 500, width: 80, height: 24 });
  btn.props.onMouseLeave();
  assert.equal(open, null);
  btn.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 3, top: 4, width: 5, height: 6 }) } });
  assert.deepEqual(J(open), { left: 3, top: 4, width: 5, height: 6 });
  btn.props.onBlur();
  assert.equal(open, null);
});

test('the open popover is a body portal, aria-hidden, pointer-events none, text children only', () => {
  const dom = { createPortal: (child, target) => ({ portal: true, target, child }) };
  const hostile = '<img src=x onerror=alert(1)>';
  const plan = { ...FULL_PLAN, scopedWeekly: { percent: 26, resetsAt: IN1D, label: hostile } };
  const t = loadWithReact({ ...fakeReact, useState: (i) => [i === null ? { left: 20, top: 400, width: 80, height: 24 } : i, () => {}], useId: () => 'x', useCallback: (f) => f }, dom, { document: { querySelector: () => ({}), body: { tag: 'body' }, documentElement: { clientWidth: 1000, clientHeight: 800 } } });
  const raw = t.DockChip({ plan, spend: null, cache: null, identity: null });
  const walk = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => walk(x, out)); return out; } if (n.portal) { out.push(n); walk(n.child, out); return out; } if (n.props) walk(n.props.children, out); return out; };
  const portals = walk(expandAll(raw));
  assert.equal(portals.length, 1, 'one portal while open');
  assert.equal(portals[0].target.tag, 'body');
  const pop = portals[0].child;
  assert.equal(pop.props.role, 'tooltip');
  assert.equal(pop.props['aria-hidden'], 'true');
  assert.match(pop.props.className, /dshMh-pop/);
  assert.equal(pop.props.title, undefined);
  assert.equal(pop.props.style.position, 'fixed');
  const shown = texts(pop);
  assert.ok(shown.includes(hostile + ', weekly'), 'the hostile label is a plain text child');
  assert.ok(shown.includes('Claude plan usage') && shown.includes('Subscription'));
  assert.ok(findAll(pop, (n) => n.type === 'img' || n.type === 'script').length === 0, 'no img or script elements');
});

test('tooltip text is text, never HTML: the source has no innerHTML', () => {
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!/innerHTML|dangerouslySetInnerHTML|outerHTML|insertAdjacentHTML/.test(src.replace(/\/\/.*$/gm, '')));
  assert.match(src, /require\("react-dom"\)/);
  assert.match(src, /\.dshMh-pop\{[^}]*pointer-events:none/);
  assert.match(src, /\.dshMh-sr\{/);
  assert.match(src, /\.dshMh-chip:focus-visible\{[^}]*var\(--mh-accent\)/);
  const pop = src.match(/"\.dshMh-pop\{[^"]*"/)[0];
  assert.deepEqual(pop.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'no hardcoded hex colours in the popover');
  assert.ok(!/rgb\(|rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(?!0?\.\d+\))/.test(pop.replace(/box-shadow:[^;"]*/, '')), 'only the shadow may use rgba');
});

test('popoverModel: rings, model windows, est. only for a window that fills, stop or extra row, the day on the cap runway', () => {
  const t = loadFixed();
  const fc = planFc();
  const base = { plan: PLAN_NOW, fc, identity: null, stop: false, spend: { totals: { usd: 31.2, calls: 3 }, caps: { action: 'warn', todayUsd: 31.2, limits: { dailyUsd: 40 } } } };
  const m = t.popoverModel(base);
  assert.deepEqual(J(m.big.map((x) => x.key)), ['fiveHour', 'sevenDay']);
  assert.equal(m.small.length, 0);
  // 5-hour fills before its reset (LIMIT5): two lines, the range on its own; the weekly line (stays under) is not an est. row
  const flat = m.fills.map((l) => l.map((x) => (typeof x === 'string' ? x : x.b)).join(''));
  assert.equal(flat.length, 2, flat.join('|'));
  assert.match(flat[0], /^5-hour fills around .+, before its reset$/);
  assert.match(flat[1], /^\(range .+\)\.$/);
  assert.deepEqual([m.stopRow.tag, /^Extra usage is off/.test(m.stopRow.text)], ['Extra', true]);
  assert.equal(t.popoverModel({ ...base, stop: true }).stopRow.tag, 'Stop');
  assert.equal(t.popoverModel({ ...base, stop: true }).stopRow.text, 'On: DSH refuses Claude requests in a full window.');
  // not enough readings: no est. row
  const none = t.popoverModel({ ...base, fc: planFc({ status: 'insufficient', readings: 1 }, { status: 'insufficient', readings: 1 }) });
  assert.equal(none.fills.length, 0);
  assert.equal(t.popoverModel({ ...base, fc: null }).fills.length, 0);
  // the day
  assert.equal(m.today.usd, 31.2); assert.equal(m.today.cap, 40); assert.ok(Math.abs(m.today.frac - 0.78) < 1e-9);
  assert.ok(m.today.est && /^\$\d+\.\d+$/.test(m.today.est.rate), JSON.stringify(m.today.est));
  // states without a plan window: one sentence, the day kept
  for (const mode of ['signed-out', 'expired', 'api']) {
    const x = t.popoverModel({ ...base, plan: { mode } });
    assert.deepEqual([x.live, x.big.length, x.stopRow, typeof x.oneLine], [false, 0, null, 'string'], mode);
    assert.ok(x.today && x.today.usd === 31.2, mode);
  }
  // unavailable: the last rings, a one-line notice with the age of the last reading
  const un = t.popoverModel({ ...base, plan: { ...PLAN_NOW, mode: 'unavailable', httpStatus: 429 } });
  assert.equal(un.grey, true); assert.equal(un.big.length, 2);
  assert.match(un.unavailable, /^Unavailable \(429\) · last reading \d+\u00a0min\u00a0ago$/, 'the row tag says Usage; "min ago" never wraps apart');
  // extra model windows are rows, not rings
  const many = t.popoverModel({ ...base, plan: { ...PLAN_NOW, sevenDayOpus: { percent: 62, resetsAt: IN1D }, sevenDaySonnet: { percent: 18, resetsAt: IN1D }, scopedWeekly: { percent: 30, resetsAt: IN1D, label: 'Fable' } } });
  assert.deepEqual(J(many.small.map((x) => x.title)), ['Opus, weekly', 'Sonnet, weekly', 'Fable, weekly']);
  // a stale reading dims the model rows' percent like the rings (never a bright "fresh" number)
  const staleTree = expandAll(t.PlanPopover({ ...base, anchor: { left: 100, top: 600 }, plan: { ...PLAN_NOW, mode: 'unavailable', httpStatus: 429, scopedWeekly: { percent: 30, resetsAt: IN1D, label: 'Fable' } } }));
  const stale = (n, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => stale(x, out)); return out; } if (n.props && typeof n.props.className === 'string' && /\bis-stale\b/.test(n.props.className)) out.push(n.props.children); if (n.props) stale(n.props.children, out); return out; };
  assert.deepEqual(J(stale(staleTree)), ['30%']);
  const freshTree = expandAll(t.PlanPopover({ ...base, anchor: { left: 100, top: 600 }, plan: { ...PLAN_NOW, scopedWeekly: { percent: 30, resetsAt: IN1D, label: 'Fable' } } }));
  assert.deepEqual(J(stale(freshTree)), [], 'a live reading is not dimmed');
  // no daily cap: no runway, only the figure
  assert.equal(t.popoverModel({ ...base, spend: { totals: { usd: 5 }, caps: { action: 'ok', todayUsd: 5, limits: { dailyUsd: 0 } } } }).today.cap, 0);
  assert.equal(t.popoverModel({ ...base, spend: null }).today, null);
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

test('the plan-stop row is a real switch button bound to caps.stopAtPlanLimit; the tooltip lines are unchanged by it', () => {
  const t = loadWithReact(fakeReact);
  const posts = [];
  const sw = (props) => expandAll(t.PlanStopSwitch({ stop: false, busy: false, error: '', onToggle: (n) => posts.push(n), ...props }));
  const btn = (tree) => findAll(tree, (n) => n.type === 'button')[0];
  const off = sw({});
  assert.equal(btn(off).props.type, 'button'); assert.equal(btn(off).props.role, 'switch');
  assert.equal(btn(off).props['aria-checked'], 'false'); assert.equal(btn(off).props.disabled, false);
  assert.equal(findAll(off, (n) => n.type === 'input').length, 0, 'never a default checkbox');
  assert.ok(texts(off).includes('Stop Claude requests at 100% of a plan window'));
  const label = findAll(off, (n) => n.props.id && n.props.id === btn(off).props['aria-labelledby'])[0];
  assert.ok(label && texts(label).includes('Stop Claude requests at 100% of a plan window'), 'named by its visible label');
  btn(off).props.onClick();
  assert.deepEqual(posts, [true]);
  const on = sw({ stop: true });
  assert.equal(btn(on).props['aria-checked'], 'true');
  assert.match(btn(on).props.className, /is-on/);
  btn(on).props.onClick();
  assert.deepEqual(posts, [true, false]);
  const busy = btn(sw({ busy: true }));
  assert.equal(busy.props['aria-busy'], 'true', 'busy while saving: still focusable, so the keyboard keeps its place');
  assert.equal(busy.props.disabled, false);
  busy.props.onClick();
  assert.deepEqual(posts, [true, false], 'a click while saving does nothing');
  assert.equal(btn(sw({ unavailable: true })).props.disabled, true, 'disabled until the caps load');
  assert.ok(texts(sw({ description: 'one line' })).includes('one line'));
  const bad = sw({ error: 'this page is not the DSH instance that owns the model hub' });
  const alert = findAll(bad, (n) => n.props.role === 'alert')[0];
  assert.deepEqual(texts(alert), ['this page is not the DSH instance that owns the model hub']);
  assert.equal(findAll(off, (n) => n.props.role === 'alert').length, 0);
  // the card: the control is the last row of a signed-in card; the footer sentence is the row's description
  const plan = COOL();
  const body = texts(expandAll(t.planCardBody({ plan, identity: null }, true, h0('SWITCH'), null)));
  assert.equal(body[body.length - 1], 'SWITCH');
  assert.ok(!texts(expandAll(t.planCardBody({ plan: { mode: 'signed-out' }, identity: null }, false, h0('SWITCH'), null))).includes('SWITCH'), 'no switch without a plan');
  for (const l of J(t.planLines(plan, true))) assert.ok(typeof l === 'string' && l.length > 0);
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
  assert.ok(src.includes('.dshMh-switch:focus-visible{outline:2px solid var(--mh-accent)'), 'visible keyboard focus');
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

// the clock as the client says it: 12 h with AM/PM in en-US, whatever the locale says elsewhere; a weekday when the day differs
const FC_T = (ms, dayShift = 0) => (dayShift ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ms).getDay()] + ' ' : '') + new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

test('forecastSpendLine: exact wording for ok / cap not reached / provider cap first / reached / suppressed (null)', () => {
  const t = loadHelpers();
  const line = (s) => { const l = t.forecastSpendLine(s); return l && l.text; };
  const head = '$1.20 an hour now';
  assert.equal(line(fcSpend()), head + ', about $14.20 by midnight.', 'no caps: no cap part');
  const reach = line(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] }));
  assert.ok(reach.startsWith(head + ': daily cap reached around ' + FC_T(FC_AT(16, 40)) + ' (range '), reach);
  assert.ok(reach.endsWith('–' + FC_T(FC_AT(22, 5)) + ').'), reach);
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' })] })), head + ', about $14.20 by midnight, under the daily cap.');
  // a provider cap that is reached before the daily one is named first
  assert.equal(line(fcSpend({ caps: [
    fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40) }),
    fcCap({ which: 'provider-daily', provider: 'openai', capUsd: 5, state: 'at-pace', reachedAt: FC_AT(15, 10) }),
    fcCap({ which: 'session', sessionId: 's1', state: 'at-pace', reachedAt: FC_AT(17, 0) }),
  ] })), head + ': openai cap reached around ' + FC_T(FC_AT(15, 10)) + '.');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' }), fcCap({ which: 'session', sessionId: 's1', state: 'at-pace', reachedAt: FC_AT(15, 5) })] })), head + ': session cap reached around ' + FC_T(FC_AT(15, 5)) + '.');
  // a time on another day carries the weekday
  assert.equal(line(fcSpend({ caps: [fcCap({ which: 'session', sessionId: 's1', state: 'at-pace', reachedAt: FC_AT(9, 30, 1) })] })), head + ': session cap reached around ' + FC_T(FC_AT(9, 30, 1), 1) + '.');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'reached', spentUsd: 41 })] })), head + ': daily cap reached.');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'suppressed', reason: 'x' })] })), head + ', about $14.20 by midnight.', 'a suppressed cap adds nothing');
  // the numbers are the bold parts of the line
  const segs = t.forecastSpendLine(fcSpend()).segs;
  assert.deepEqual(J(segs), [{ b: '$1.20' }, ' an hour now', ', about ', { b: '$14.20' }, ' by midnight', '.']);
  // what the Today runway needs: the projection, and whether the daily cap is reached or on course to be
  assert.equal(t.forecastSpendLine(fcSpend()).projectedUsd, 14.2);
  assert.equal(t.forecastSpendLine(fcSpend()).dailyReached, false);
  assert.equal(t.forecastSpendLine(fcSpend({ caps: [fcCap({ state: 'reached' })] })).dailyReached, true);
  assert.equal(t.forecastSpendLine(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40) })] })).dailyReached, true);
  // suppressed pace, partial ledger, no data: nothing at all
  assert.equal(t.forecastSpendLine(fcSpend({ charged: fcCharged({ status: 'suppressed', ratePerHour: null, projectedTodayUsd: null, reason: 'fewer than 3' }) })), null);
  assert.equal(t.forecastSpendLine(fcSpend({ complete: false, charged: null })), null);
  assert.equal(t.forecastSpendLine(null), null);
  assert.equal(t.forecastSpendLine(undefined), null);
  assert.equal(t.forecastSpendLine({}), null);
});

test('fcRange: the first time drops its AM/PM when the second says the same, and an open end is "later"', () => {
  const t = loadHelpers();
  const r = t.fcRange({ earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) }, FC_NOW);
  assert.ok(r.endsWith('–' + FC_T(FC_AT(22, 5))), r);
  if (/[AP]M$/i.test(FC_T(FC_AT(22, 5)))) assert.ok(!/[AP]M\s*–/i.test(r), 'one AM/PM for the pair: ' + r);
  const mixed = t.fcRange({ earliestAt: FC_AT(9, 10), latestAt: FC_AT(22, 5) }, FC_NOW);
  assert.ok(mixed.startsWith(FC_T(FC_AT(9, 10)) + '–'), 'AM and PM differ: both are said: ' + mixed);
  assert.equal(t.fcRange({ earliestAt: FC_AT(15, 10), latestAt: null }, FC_NOW), FC_T(FC_AT(15, 10)) + '–later');
  assert.equal(t.fcRange({ earliestAt: null, latestAt: FC_AT(15, 10) }, FC_NOW), 'later–' + FC_T(FC_AT(15, 10)));
});

test('forecast text carries the estimate marks: the title says estimate, not a limit, and names the inputs', () => {
  const t = loadHelpers();
  const l = t.forecastSpendLine(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] }));
  assert.ok(l.title.startsWith('Estimate, not a limit.'), l.title);
  assert.ok(l.title.includes('15 metered calls'), l.title);
  assert.ok(l.title.includes('$1.20/h (15 min)') && l.title.includes('$1.35/h (60 min)'), l.title);
  assert.ok(l.title.includes('daily cap range ') && l.title.includes('–' + FC_T(FC_AT(22, 5))), 'the range is in the title: ' + l.title);
  assert.match(l.title, /blocks nothing|Nothing is blocked/i);
  // an open range end is said, not guessed
  const open = t.forecastSpendLine(fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: null } })] }));
  assert.ok(open.title.includes('daily cap range ' + FC_T(FC_AT(15, 10)) + '–later'), open.title);
});

const fcExpand = (n) => { if (!n || typeof n !== 'object') return n; if (Array.isArray(n)) return n.map(fcExpand); if (typeof n.type === 'function' && n.type.name !== 'ProviderIcon') return fcExpand(n.type(n.props)); return n.props ? { ...n, props: { ...n.props, children: fcExpand(n.props.children) } } : n; };
const fcFind = (n, id, out = []) => { if (!n || typeof n !== 'object') return out; if (Array.isArray(n)) { n.forEach((x) => fcFind(x, id, out)); return out; } if (n.props) { if (n.props['data-testid'] === id) out.push(n); fcFind(n.props.children, id, out); } return out; };
const COSTS_TODAY = { data: {
  totals: { usd: 0, apiEquivUsd: 0, calls: 0 }, complete: true, byProvider: {},
  caps: { action: 'ok', reason: 'within caps', todayUsd: 0, sessionSpentUsd: 0, limits: { dailyUsd: 40, sessionUsd: 15 } },
}, error: null };

test('the Costs card renders one est. row under the cap rows when /forecast has data, and nothing when it is suppressed or missing', () => {
  const t = loadWithReact(fakeReact, undefined, { Date: FixedDate });
  const spend = fcSpend({ caps: [fcCap({ state: 'at-pace', reachedAt: FC_AT(16, 40), range: { earliestAt: FC_AT(15, 10), latestAt: FC_AT(22, 5) } })] });
  const tree = fcExpand(t.CostsPanel({ today: COSTS_TODAY, gcfg: null, forecast: { data: { estimate: true, generatedAt: FC_NOW, spend }, error: null } }));
  const hits = fcFind(tree, 'model-hub-forecast');
  assert.equal(hits.length, 1);
  assert.ok(hits[0].props.title.startsWith('Estimate, not a limit.'));
  const out = texts(tree);
  const joined = out.join('');
  assert.ok(joined.includes('$1.20 an hour now: daily cap reached around ' + FC_T(FC_AT(16, 40))), joined);
  assert.equal(texts(hits[0])[0], 'est.', 'the dashed est. tag leads the row');
  assert.ok(out.includes(' (estimate)'), 'hidden estimate marker for screen readers');
  assert.ok(findAll(hits[0], (n) => n.props.className === 'dshMh-sr').length === 1, 'the (estimate) span is visually hidden (dshMh-sr)');
  assert.ok(findAll(hits[0], (n) => n.props.className === 'dshMh-fact-b').length >= 2, 'the numbers are the bold parts');
  // it sits after the cap rows
  const flat = texts(tree).join('|');
  assert.ok(flat.indexOf('$0.00| of $15.00') >= 0 && flat.indexOf('est.') > flat.indexOf('$0.00| of $15.00'), 'under the cap rows');
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
  assert.match(src, /h\(CostsPanel, \{ key: "c", today, gcfg: gcfg\.data, demo: st\.demo, forecast, week, declared, plan: st\.plan \}\)/);
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

test('with a forecast the screen-reader description carries the plan lines, each marked as an estimate; the card shows its estimate once, with the est. tag', () => {
  const t = loadFixed();
  const ident = { email: 'a@b.c', plan: 'Max' };
  const fc = planFc();
  const lines = J(t.planLines(PLAN_NOW, false, fc));
  assert.deepEqual(J(t.chipModel(PLAN_NOW, null, null, ident, false, null, fc).claude.lines), [t.identityLine(ident)].concat(lines));
  assert.deepEqual(J(t.planCardLines(PLAN_NOW, ident, false, fc)), J(t.chipModel(PLAN_NOW, null, null, ident, false, null, fc).claude.lines));
  assert.ok(lines.includes(CAPTION));
  // the card: one est. row (tag + lines) and one dashed arc on the 5-hour ring only
  const card = expandAll(t.planCardBody({ plan: PLAN_NOW, identity: ident }, false, null, fc));
  const tags = findAll(card, (n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes('is-est'));
  assert.equal(tags.length, 2, 'the row tag and the ring tag: ' + tags.length);
  assert.equal(findAll(card, (n) => n.props.className === 'dshMh-pr-est').length, 1, 'only the window that reaches 100% before its reset draws the dashed arc');
  assert.ok(texts(card).some((x) => /^Weekly stays under 100% until its reset\.$/.test(x)));
  const noFc = expandAll(t.planCardBody({ plan: PLAN_NOW, identity: ident }, false, null, null));
  assert.equal(findAll(noFc, (n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes('is-est')).length, 0, 'no forecast, no est. row, no arc');
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
  const head = '$1.20 an hour now';
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' }), fcCap({ which: 'session', sessionId: 's1', capUsd: 15, spentUsd: 15.2, state: 'reached' })] })), head + ': session cap reached.', 'a reached cap is a fact: it replaces the "under the daily cap" fallback');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'not-at-this-pace' }), fcCap({ which: 'provider-daily', provider: 'openai', capUsd: 5, state: 'reached' })] })), head + ': openai cap reached.');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'reached' }), fcCap({ which: 'session', sessionId: 's1', state: 'reached' })] })), head + ': daily cap reached; session cap reached.');
  assert.equal(line(fcSpend({ caps: [fcCap({ state: 'reached' }), fcCap({ which: 'provider-daily', provider: 'openai', state: 'at-pace', reachedAt: FC_AT(15, 10) })] })), head + ': daily cap reached; openai cap reached around ' + FC_T(FC_AT(15, 10)) + '.');
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
  assert.equal(withFc, plain + ' Estimate, not a limit: $1.20 an hour now, about $14.20 by midnight.');
});
