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

function loadHelpers() {
  let mod;
  const sandbox = { window: { __ModuleLoader__: { load: (m) => { mod = m; } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const stub = () => ({});
  const m = mod.factory((n) => (n === 'react' ? new Proxy({}, { get: () => stub }) : n === 'react/jsx-runtime' ? { jsx: stub, jsxs: stub } : { FishLogo: stub }));
  return m._test;
}

test('provider icons: all marks present, aliases resolve, unknown has no mark', () => {
  const t = loadHelpers();
  for (const k of ['anthropic', 'openai-codex', 'github-copilot', 'kimi-coding', 'openrouter', 'xai', 'rocco', 'mac', 'google', 'dashscope', 'ollama', 'deepseek']) {
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

test('prices: format, normalize, dedupe, group, 402, hide retired opus-5 only', () => {
  const t = loadHelpers();
  assert.equal(t.fmtPm(0.75), '$0.75');
  assert.equal(t.fmtPm(3.75), '$3.75');
  assert.equal(t.fmtPm(0.075), '$0.075');
  assert.equal(t.fmtPm(3), '$3.00');
  assert.ok(t.isRetired('anthropic/claude-opus-5') && t.isRetired('claude-opus-5'));
  assert.ok(!t.isRetired('claude-opus-5-5') && !t.isRetired('claude-opus-5.5') && !t.isRetired('claude-opus-4-8'));
  assert.equal(t.normPriceId('rocco/mac-qwen38-q4'), 'mac/mac-qwen38-q4');
  const r = t.groupPrices({
    'google/gemini-3.8-flash': { priced: true, billing: 'metered', inPerM: 0.75, outPerM: 3.75, cacheReadPerM: 0.075 },
    'ollama/glm-5.3-flash': { priced: false, billing: 'metered' },
    'rocco/rocco-qwen38-q4': { priced: true, billing: 'local' },
    'mac/mac-qwen38-q4': { priced: true, billing: 'local' },
    'rocco/mac-qwen38-q4': { priced: true, billing: 'local' },
    'anthropic/claude-opus-5': { priced: true, billing: 'metered', inPerM: 1, outPerM: 1 },
    'anthropic/claude-opus-5-5': { priced: true, billing: 'metered', inPerM: 5, outPerM: 25 },
  }, { google: { code: 402, message: 'no credit' } });
  assert.equal(r.rows.find((x) => x.id === 'google/gemini-3.8-flash').line, '$0.75 in · $3.75 out · $0.075 cache');
  assert.ok(r.rows.find((x) => x.id === 'google/gemini-3.8-flash').noCredit);
  assert.equal(r.rows.find((x) => x.id === 'ollama/glm-5.3-flash').kind, 'unpriced');
  assert.ok(!r.rows.some((x) => x.id === 'anthropic/claude-opus-5'));
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
