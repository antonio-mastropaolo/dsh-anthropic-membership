import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPriceTable, priceFor, normalizeOverrides, isPriced } from './prices.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cost-prices-'));
function bigTable(extra = {}) {
  const t = { ...extra };
  for (let i = 0; i < 150; i++) t[`filler/m${i}`] = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };
  return t;
}
const LITE = bigTable({
  'gemini/gemini-3.8-flash': { input_cost_per_token: 7.5e-7, output_cost_per_token: 3.75e-6, cache_read_input_token_cost: 7.5e-8, litellm_provider: 'gemini' },
  'gemini/gemini-3.1-pro-preview': { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5, cache_read_input_token_cost: 2e-7,
    input_cost_per_token_above_200k_tokens: 4e-6, output_cost_per_token_above_200k_tokens: 1.8e-5, cache_read_input_token_cost_above_200k_tokens: 4e-7 },
  'claude-opus-4-8': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6 },
  'dashscope/deepseek-v4-flash': { input_cost_per_token: 2e-7, output_cost_per_token: 4e-7, cache_read_input_token_cost: 4e-8 },
  'openrouter/some/model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  'github_copilot/claude-opus-4-8': { input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
  'junk/noprice': { mode: 'chat' },
});
const okFetch = (body = LITE, counter = { n: 0 }) => async () => { counter.n++; return { ok: true, status: 200, json: async () => body }; };

test('fetch -> slim cache written 0600 in 0700 dir; second load within 24h uses cache, no fetch', async () => {
  const dir = path.join(mk(), 'hub'); const c = { n: 0 };
  const t1 = await loadPriceTable({ dataDir: dir, fetchImpl: okFetch(LITE, c), now: 1000, fallbackPath: '/nonexistent' });
  assert.equal(t1.source, 'network'); assert.equal(c.n, 1);
  assert.equal(fs.statSync(path.join(dir, 'prices.litellm.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(!('junk/noprice' in t1.entries));
  const t2 = await loadPriceTable({ dataDir: dir, fetchImpl: okFetch(LITE, c), now: 1000 + 3600e3, fallbackPath: '/nonexistent' });
  assert.equal(t2.source, 'cache'); assert.equal(c.n, 1);
  const t3 = await loadPriceTable({ dataDir: dir, fetchImpl: okFetch(LITE, c), now: 1000 + 25 * 3600e3, fallbackPath: '/nonexistent' });
  assert.equal(t3.source, 'network'); assert.equal(c.n, 2);
});
test('network failure -> stale cache -> fallback file -> none', async () => {
  const dir = path.join(mk(), 'hub'); const bad = async () => { throw new Error('offline'); };
  await loadPriceTable({ dataDir: dir, fetchImpl: okFetch(), now: 1, fallbackPath: '/nonexistent' });
  const stale = await loadPriceTable({ dataDir: dir, fetchImpl: bad, now: 1 + 30 * 3600e3, fallbackPath: '/nonexistent' });
  assert.equal(stale.source, 'stale-cache'); assert.ok(stale.warnings.some((w) => /stale/.test(w)));
  const dir2 = path.join(mk(), 'hub2'); const fb = path.join(mk(), 'fb.json'); fs.writeFileSync(fb, JSON.stringify(LITE));
  const f = await loadPriceTable({ dataDir: dir2, fetchImpl: bad, now: 1, fallbackPath: fb });
  assert.equal(f.source, 'fallback'); assert.ok(f.count > 100);
  const none = await loadPriceTable({ dataDir: path.join(mk(), 'h3'), fetchImpl: bad, now: 1, fallbackPath: '/nonexistent' });
  assert.equal(none.source, 'none'); assert.equal(priceFor(none, 'google', 'gemini-3.8-flash').source, 'unpriced');
});
test('rejects a too-small / HTTP-error body', async () => {
  const dir = path.join(mk(), 'hub');
  const t = await loadPriceTable({ dataDir: dir, fetchImpl: okFetch({ a: 1 }), now: 1, fallbackPath: '/nonexistent' });
  assert.equal(t.source, 'none');
  const t2 = await loadPriceTable({ dataDir: dir, fetchImpl: async () => ({ ok: false, status: 503 }), now: 1, fallbackPath: '/nonexistent' });
  assert.equal(t2.source, 'none');
});
test('metered google: per-M conversion exact, no float dust', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const p = priceFor(t, 'google', 'gemini-3.8-flash');
  assert.deepEqual([p.inPerM, p.outPerM, p.cacheReadPerM], [0.75, 3.75, 0.075]);
  assert.equal(p.billing, 'metered'); assert.equal(p.source, 'litellm');
  assert.deepEqual(p.derived, ['cacheWrite']); assert.equal(p.cacheWritePerM, 0.75);
  assert.deepEqual(priceFor(t, 'google/gemini-3.8-flash').inPerM, 0.75); // combined id form
  assert.equal(priceFor(t, 'google', 'google/gemini-3.8-flash').inPerM, 0.75);
});
test('above200k schedule carried', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  // no high-context cache-write rate in the fixture: never below the base cache-write (= input 2) or the 200k input (4)
  assert.deepEqual(priceFor(t, 'google', 'gemini-3.1-pro-preview').above200k, { inPerM: 4, outPerM: 18, cacheReadPerM: 0.4, cacheWritePerM: 4, derived: ['cacheWritePerM'] });
  const hi = priceFor({ entries: { 'claude-x': { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_creation_input_token_cost: 1.25e-6,
    input_cost_per_token_above_200k_tokens: 2e-6, output_cost_per_token_above_200k_tokens: 1e-5, cache_creation_input_token_cost_above_200k_tokens: 2.5e-6 } }, overrides: {} },
    'openrouter', 'claude-x');
  assert.equal(hi.above200k.cacheWritePerM, 2.5);
});
test('subscription providers show API-equivalent price, billing subscription', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const oauth = { oauthProviders: ['anthropic', 'github-copilot', 'openai-codex'] };
  const p = priceFor(t, 'anthropic', 'claude-opus-4-8', oauth);
  assert.equal(p.billing, 'subscription'); assert.equal(p.source, 'subscription'); assert.equal(p.inPerM, 5); assert.equal(p.cacheWritePerM, 6.25);
  assert.equal(priceFor(t, 'github-copilot', 'claude-opus-4-8', oauth).inPerM, 5);
  const none = priceFor(t, 'openai-codex', 'gpt-nope', oauth);
  assert.equal(none.billing, 'subscription'); assert.equal(none.apiEquivKnown, false);
});
test('no provider is hardcoded free: dashscope is metered unless prices.json marks a model free', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const d = priceFor(t, 'dashscope', 'deepseek-v4-flash');
  assert.equal(d.billing, 'metered'); assert.equal(d.inPerM, 0.2);
  // no provider names are hardcoded as local any more
  assert.equal(priceFor(t, 'rocco', 'rocco-qwen38-q4').billing, 'metered');
  assert.equal(priceFor(t, 'mac', 'mac-qwen38-q4').billing, 'metered');
});
test('localProviders (from config) are billed local at $0, in both call forms', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  for (const p of ['mybox', 'mac']) {
    const x = priceFor(t, p, 'some-model', { localProviders: ['mybox', 'mac'] });
    assert.equal(x.billing, 'local'); assert.equal(x.source, 'local'); assert.equal(x.inPerM, 0); assert.equal(x.outPerM, 0);
  }
  assert.equal(priceFor(t, 'mybox/some-model', undefined, { localProviders: ['mybox'] }).billing, 'local');
  assert.equal(priceFor(t, 'other', 'm', { localProviders: ['mybox'] }).billing, 'metered');
  assert.equal(priceFor(t, 'google', 'gemini-3.8-flash', { localProviders: [] }).billing, 'metered');
});
test('baseURL: loopback and private hosts are local; public hosts are not', async () => {
  const { isLocalBaseURL } = await import('./prices.mjs');
  for (const u of ['http://localhost:4010', 'http://127.0.0.1:8000/v1', 'http://127.5.6.7', 'http://[::1]:9000', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.255',
    'http://192.168.1.20:11434', 'http://100.64.0.1', 'http://100.127.255.254', 'http://gpu.local:80', 'http://box.localhost']) assert.equal(isLocalBaseURL(u), true, u);
  for (const u of ['https://api.openai.com/v1', 'http://172.32.0.1', 'http://172.15.0.1', 'http://192.169.0.1', 'http://100.63.0.1', 'http://100.128.0.1', 'http://8.8.8.8', 'http://11.0.0.1',
    'http://localhost.evil.com', 'http://127.0.0.1.evil.com', 'http://10.0.0.1.evil.com', 'http://notlocal', 'garbage', '', undefined, null, 'http://300.1.1.1']) assert.equal(isLocalBaseURL(u), false, String(u));
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  assert.equal(priceFor(t, 'mybox', 'some-model', { baseURL: 'http://192.168.1.5:8000/v1' }).billing, 'local');
  // a known paid provider stays paid even behind a private URL (a local gateway can front a paid API)
  assert.equal(priceFor(t, 'google', 'gemini-3.8-flash', { baseURL: 'http://192.168.1.5:8000/v1' }).billing, 'metered');
  assert.equal(priceFor(t, 'google', 'gemini-3.8-flash', { baseURL: 'https://generativelanguage.googleapis.com' }).billing, 'metered');
});
test('unknown metered model => unpriced (never guessed), still billing metered', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const p = priceFor(t, 'google', 'gemini-99-imaginary');
  assert.equal(p.source, 'unpriced'); assert.equal(p.billing, 'metered'); assert.equal(isPriced(p), false);
  assert.equal(priceFor(t, 'someothervendor', 'x').billing, 'metered');
  assert.equal(priceFor(t, 'openrouter', 'some/model').inPerM, 1);
});
test('override wins, validates, and can set billing', async () => {
  const dir = path.join(mk(), 'hub'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({
    'google/gemini-3.8-flash': { inPerM: 1, outPerM: 2 },
    'ollama-cloud/glm': { inPerM: 0.5, outPerM: 1, cacheReadPerM: 0.1, billing: 'free' },
    'bad/one': { inPerM: -1, outPerM: 2 }, 'bad/two': 'x',
  }));
  const t = await loadPriceTable({ dataDir: dir, fetchImpl: okFetch(), now: 1 });
  const p = priceFor(t, 'google', 'gemini-3.8-flash');
  assert.equal(p.source, 'override'); assert.equal(p.inPerM, 1); assert.equal(p.billing, 'metered');
  assert.equal(priceFor(t, 'ollama-cloud', 'glm').billing, 'free');
  assert.equal(priceFor(t, 'bad', 'one').source, 'unpriced');
  assert.equal(t.warnings.filter((w) => /prices\.json/.test(w)).length, 2);
});
test('normalizeOverrides tolerates garbage', () => {
  assert.equal(Object.keys(normalizeOverrides(null)).length, 0); const w = []; assert.equal(Object.keys(normalizeOverrides([1], w)).length, 0); assert.equal(w.length, 1);
  const w2 = []; normalizeOverrides(JSON.parse('{"__proto__": {"inPerM": 1, "outPerM": 1}}'), w2);
  assert.equal(({}).inPerM, undefined); assert.ok(w2.some((x) => x.includes('__proto__')));
});
test('prototype keys are not price hits', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  assert.equal(priceFor(t, 'google', '__proto__').source, 'unpriced');
  assert.equal(priceFor(t, 'google', 'constructor').source, 'unpriced');
});

test('discoverFallbackPath: env override, discovery under a fake home, null when absent', async () => {
  const { discoverFallbackPath } = await import('./prices.mjs');
  const fs2 = await import('node:fs'), os2 = await import('node:os'), p2 = await import('node:path');
  const home = fs2.mkdtempSync(p2.join(os2.tmpdir(), 'hub-home-'));
  assert.equal(discoverFallbackPath(home, {}), null);
  const f = p2.join(home, 'Library', 'Python', '3.12', 'lib', 'python', 'site-packages', 'litellm');
  fs2.mkdirSync(f, { recursive: true });
  fs2.writeFileSync(p2.join(f, 'model_prices_and_context_window_backup.json'), '{}');
  assert.equal(discoverFallbackPath(home, {}), p2.join(f, 'model_prices_and_context_window_backup.json'));
  assert.equal(discoverFallbackPath(home, { DSH_HUB_PRICE_FALLBACK: '/x.json' }), '/x.json');
});

test("a known paid provider is never priced local, even if listed in localProviders", async () => {
  const { priceFor } = await import("./prices.mjs");
  const p = priceFor({}, "google", "gemini-3.8-flash", { localProviders: ["google"] });
  assert.notEqual(p.billing, "local");
  assert.equal(priceFor({}, "mybox", "m", { localProviders: ["mybox"] }).billing, "local");
});

test('subscription billing requires an OAuth grant: the same provider with an API key is metered', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const id = Object.keys(t.entries).find((k) => /^claude-/.test(k)) || 'claude-opus-4-8';
  assert.equal(priceFor(t, 'anthropic', id, { oauthProviders: ['anthropic'] }).billing, 'subscription', 'OAuth grant -> plan');
  const api = priceFor(t, 'anthropic', id, { oauthProviders: [] });
  assert.equal(api.billing, 'metered', 'API key -> metered');
  assert.equal(priceFor(t, 'anthropic', id).billing, 'metered', 'unknown grants (no account info) -> metered, never $0');
  assert.equal(priceFor(t, 'anthropic', id, { oauthProviders: null }).billing, 'metered');
});

test('price-table warnings are redacted (a parser error can quote the response)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'sk-demo123456' }); // short: the JSON parser quotes it whole
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl, now: 1, fallbackPath: '/nonexistent' });
  assert.ok(t.warnings.some((w) => /price fetch failed/.test(w)));
  assert.ok(!t.warnings.some((w) => /sk-demo123456/.test(w)), t.warnings.join(' | '));
});

test('a provider with built-in pricing is never local, even listed in localProviders (dashscope included)', async () => {
  const { PAID_PROVIDERS } = await import('./prices.mjs');
  const t = { entries: { 'dashscope/paid-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }, overrides: {} };
  const p = priceFor(t, 'dashscope', 'paid-model', { localProviders: ['dashscope'] });
  assert.equal(p.billing, 'metered');
  assert.equal(p.inPerM, 1);
  for (const prov of PAID_PROVIDERS) assert.notEqual(priceFor(t, prov, 'x', { localProviders: [prov], oauthProviders: [] }).billing, 'local', prov);
  assert.equal(priceFor(t, 'mybox', 'x', { localProviders: ['mybox'] }).billing, 'local', 'any other provider can be local');
});

test('README lists exactly the providers the code never treats as local', async () => {
  const { PAID_PROVIDERS } = await import('./prices.mjs');
  const { readFileSync } = await import('node:fs');
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| `localProviders` |'));
  assert.ok(row, 'localProviders row present');
  const listed = [...row.split('never treated as local')[0].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]).filter((x) => x !== 'localProviders' && x !== 'id');
  assert.deepEqual([...listed].sort(), [...PAID_PROVIDERS].sort());
});

test("DSH's DeepSeek routes are priced from LiteLLM's deepseek/ keys and are never local", () => {
  const t = { entries: { 'deepseek/deepseek-r1': { input_cost_per_token: 0.55e-6, output_cost_per_token: 2.19e-6 } }, overrides: {} };
  for (const prov of ['deepseek-official', 'deepseek-account']) {
    const p = priceFor(t, prov, 'deepseek-r1', { localProviders: [prov] });
    assert.equal(p.billing, 'metered', prov);
    assert.equal(p.inPerM, 0.55, prov);
  }
});

// ---- an Ollama Cloud model id on a provider outside PAID_PROVIDERS (the rocco gateway forwards it to Ollama Cloud) ----
test('Ollama-cloud rule: a :cloud id on a non-paid provider is metered at Ollama rates, even on a loopback base URL', () => {
  const t = { entries: {}, overrides: {} };
  const loop = { baseURL: 'http://127.0.0.1:4000/v1', at: Date.UTC(2026, 10, 14, 15) };
  const p = priceFor(t, 'rocco-gateway', 'glm-5.2:cloud', loop);
  assert.equal(p.billing, 'metered');
  assert.equal(p.source, 'ollama-snapshot');
  assert.deepEqual([p.inPerM, p.outPerM], [1.4, 4.4]);
  assert.ok(isPriced(p));
  // listing the provider in localProviders does not make a cloud model local
  assert.equal(priceFor(t, 'rocco-gateway', 'kimi-k2.6:cloud', { ...loop, localProviders: ['rocco-gateway'] }).billing, 'metered');
  // the "-cloud" spelling counts too
  assert.equal(priceFor(t, 'rocco-gateway', 'glm-5.2-cloud', loop).billing, 'metered');
  // a cloud id Ollama has no rate for is metered and unpriced (billed, but nothing to count with), never local
  const unk = priceFor(t, 'rocco-gateway', 'not-on-the-table:cloud', loop);
  assert.deepEqual([unk.billing, unk.source], ['metered', 'unpriced']);
  // the same provider's non-cloud model stays local on a loopback URL
  const local = priceFor(t, 'rocco-gateway', 'qwen3:8b', loop);
  assert.deepEqual([local.billing, local.source], ['local', 'local']);
});
test('Ollama-cloud rule: a prices.json row still wins, and paid providers are untouched', () => {
  const ov = normalizeOverrides({ 'rocco-gateway/glm-5.2:cloud': { inPerM: 0.1, outPerM: 0.2 }, 'rocco-gateway/free-one:cloud': { inPerM: 0, outPerM: 0, billing: 'local' } });
  const t = { entries: {}, overrides: ov };
  const loop = { baseURL: 'http://127.0.0.1:4000/v1' };
  const hit = priceFor(t, 'rocco-gateway', 'glm-5.2:cloud', loop);
  assert.deepEqual([hit.source, hit.inPerM, hit.outPerM, hit.billing], ['override', 0.1, 0.2, 'metered']);
  assert.equal(priceFor(t, 'rocco-gateway', 'free-one:cloud', loop).billing, 'local');
  // ollama itself: unchanged (cloud id => cloud, plain id on loopback => local)
  assert.equal(priceFor({ entries: {}, overrides: {} }, 'ollama', 'glm-5.2:cloud', { baseURL: 'http://127.0.0.1:11434' }).billing, 'metered');
  assert.equal(priceFor({ entries: {}, overrides: {} }, 'ollama', 'llama3:8b', { baseURL: 'http://127.0.0.1:11434' }).billing, 'local');
});
