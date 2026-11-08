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
  assert.deepEqual(priceFor(t, 'google', 'gemini-3.1-pro-preview').above200k, { inPerM: 4, outPerM: 18, cacheReadPerM: 0.4 });
});
test('subscription providers show API-equivalent price, billing subscription', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const p = priceFor(t, 'anthropic', 'claude-opus-4-8');
  assert.equal(p.billing, 'subscription'); assert.equal(p.source, 'subscription'); assert.equal(p.inPerM, 5); assert.equal(p.cacheWritePerM, 6.25);
  assert.equal(priceFor(t, 'github-copilot', 'claude-opus-4-8').inPerM, 5);
  const none = priceFor(t, 'openai-codex', 'gpt-nope');
  assert.equal(none.billing, 'subscription'); assert.equal(none.apiEquivKnown, false);
});
test('dashscope = free (with API-equivalent rates when known); rocco/mac = local zeros', async () => {
  const t = await loadPriceTable({ dataDir: path.join(mk(), 'h'), fetchImpl: okFetch(), now: 1 });
  const d = priceFor(t, 'dashscope', 'deepseek-v4-flash');
  assert.equal(d.billing, 'free'); assert.equal(d.source, 'free'); assert.equal(d.inPerM, 0.2);
  assert.equal(priceFor(t, 'dashscope', 'unknown-x').inPerM, 0);
  for (const [p, m] of [['rocco', 'rocco-qwen38-q4'], ['mac', 'mac-qwen38-q4']]) {
    const x = priceFor(t, p, m); assert.equal(x.billing, 'local'); assert.equal(x.source, 'local'); assert.equal(x.inPerM, 0);
  }
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
  assert.deepEqual(normalizeOverrides(null), {}); const w = []; assert.deepEqual(normalizeOverrides([1], w), {}); assert.equal(w.length, 1);
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
