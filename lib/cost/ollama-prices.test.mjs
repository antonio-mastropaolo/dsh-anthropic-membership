import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOllamaTable, parseOllamaPricing, isOffPeak, ollamaModelKey, OLLAMA_SNAPSHOT, snapshotTable } from './ollama-prices.mjs';
import { priceFor, isZaiCodingEndpoint } from './prices.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-prices-'));
const fmt = (v) => (v === null ? '-' : `$${v}`);
// a page built from the snapshot table the way ollama.com renders it
function fixture(models = OLLAMA_SNAPSHOT.models) {
  const row = (n, t) => `<tr><td class="x"><a href="/library/${n}">${n}</a></td><td class="r">${fmt(t.inPerM)}</td><td>${fmt(t.cachedPerM)}</td><td>${fmt(t.outPerM)}</td></tr>`;
  const rows = Object.entries(models).map(([n, t]) => row(n, t) + (t.offPeak ? row(`${n} (Off-Peak)`, t.offPeak) : '')).join('\n');
  return `<html><body><table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}
const okFetch = (html, counter = { n: 0 }) => async () => { counter.n++; return { ok: true, status: 200, url: 'https://ollama.com/pricing', text: async () => html }; };
const T = { entries: {}, overrides: {} };
const at = (y, m, d, h) => Date.UTC(y, m - 1, d, h);

test('parser: the fixture built from the table parses back to exactly the snapshot (22 models, off-peak rows attached, "-" = null)', () => {
  const m = parseOllamaPricing(fixture());
  assert.equal(Object.keys(m).length, 22);
  assert.deepEqual(JSON.parse(JSON.stringify(m)), JSON.parse(JSON.stringify(OLLAMA_SNAPSHOT.models)));
  assert.deepEqual(m.clef, { inPerM: 0.24, cachedPerM: null, outPerM: null });
  assert.deepEqual(m['deepseek-v4.1-flash'].offPeak, { inPerM: 0.15, cachedPerM: 0.003, outPerM: 0.6 });
});
test('parser: garbage, scripts, wrong table, negative or huge numbers are rejected', () => {
  assert.equal(parseOllamaPricing('<html>nothing</html>'), null);
  assert.equal(parseOllamaPricing(''), null);
  assert.equal(parseOllamaPricing(null), null);
  assert.equal(parseOllamaPricing('<table><tr><th>Model</th><th>Price</th></tr><tr><td>a</td><td>$1</td></tr></table>'), null);
  assert.equal(parseOllamaPricing('x'.repeat(3 * 1024 * 1024)), null);
  const bad = fixture({ ...Object.fromEntries(Object.entries(OLLAMA_SNAPSHOT.models).slice(0, 10)), evil: { inPerM: 1, cachedPerM: 1, outPerM: 1 } })
    .replace('$1</td><td>$1</td><td>$1', '$-5</td><td>$1e9</td><td>$NaN');
  const m = parseOllamaPricing(bad);
  assert.ok(m === null || !('evil' in m));
  const proto = fixture({ ...Object.fromEntries(Object.entries(OLLAMA_SNAPSHOT.models).slice(0, 12)) }).replace('</tbody>', '<tr><td>__proto__</td><td>$1</td><td>$1</td><td>$1</td></tr></tbody>');
  const pm = parseOllamaPricing(proto);
  assert.equal(Object.getPrototypeOf(pm), null); assert.ok(!Object.prototype.hasOwnProperty.call(pm, '__proto__'));
});
test('refresh: valid page -> network table + cache 0600; within 24 h no fetch; stale after 24 h refetches', async () => {
  const dir = path.join(mk(), 'h'); const c = { n: 0 };
  const t = await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch(fixture(), c), now: at(2026, 11, 9, 1) });
  assert.equal(t.source, 'network'); assert.equal(t.count, 22); assert.equal(t.date, '2026-11-09');
  assert.equal(fs.statSync(path.join(dir, 'ollama-prices.json')).mode & 0o777, 0o600);
  assert.equal((await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch(fixture(), c), now: at(2026, 11, 9, 20) })).source, 'cache');
  assert.equal(c.n, 1);
  assert.equal((await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch(fixture(), c), now: at(2026, 11, 10, 2) })).source, 'network');
  assert.equal(c.n, 2);
});
test('refresh: a garbage page is rejected, the snapshot is kept and a warning recorded; the previous cache survives a later bad page', async () => {
  const dir = path.join(mk(), 'h');
  const t = await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch('<html>captcha</html>'), now: at(2026, 11, 9, 1) });
  assert.equal(t.source, 'snapshot'); assert.equal(t.count, 22); assert.ok(t.warnings.some((w) => /did not parse/.test(w)));
  const c2 = { n: 0 };
  const held = await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch(fixture(), c2), now: at(2026, 11, 9, 1) + 1800e3 }); // inside the failure back-off: no refetch
  assert.equal(held.source, 'snapshot'); assert.equal(c2.n, 0);
  const good = await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch(fixture()), now: at(2026, 11, 9, 3) });
  assert.equal(good.source, 'network');
  const bad = await loadOllamaTable({ dataDir: dir, fetchImpl: okFetch('junk'), now: at(2026, 11, 11, 5) });
  assert.equal(bad.source, 'stale-cache'); assert.equal(bad.count, 22); assert.ok(bad.warnings.length);
  const down = await loadOllamaTable({ dataDir: path.join(mk(), 'h2'), fetchImpl: async () => { throw new Error('offline'); }, now: 5 });
  assert.equal(down.source, 'snapshot');
  const redirected = await loadOllamaTable({ dataDir: path.join(mk(), 'h3'), fetchImpl: async () => ({ ok: true, url: 'https://evil.example/pricing', text: async () => fixture() }), now: 5 });
  assert.equal(redirected.source, 'snapshot');
});
test('price lookup: exact, :cloud / -cloud strip, base-name fallback, unknown -> unpriced', () => {
  const t = { ...T, ollama: snapshotTable() };
  const p = (m, o = {}) => priceFor(t, 'ollama', m, { baseURL: 'https://ollama.com/v1', at: at(2026, 11, 14, 10), ...o });
  assert.deepEqual([p('glm-5.3-flash').inPerM, p('glm-5.3-flash').outPerM, p('glm-5.3-flash').cacheReadPerM], [0.15, 0.5, 0.03]);
  assert.equal(p('glm-5.3-flash').source, 'ollama-snapshot'); assert.equal(p('glm-5.3-flash').billing, 'metered');
  assert.equal(p('glm-5.3:cloud').inPerM, 1.4);
  assert.equal(p('kimi-k3-cloud').inPerM, 3);
  assert.equal(p('gemma4:31b-cloud').inPerM, 0.14);   // strip -cloud, then gemma4:31b -> gemma4
  assert.equal(p('gpt-oss:20b').inPerM, 0.07);        // exact id keeps its tag
  assert.equal(p('gpt-oss:120b').inPerM, 0.15);
  const u = p('no-such-model'); assert.equal(u.source, 'unpriced'); assert.equal(u.billing, 'metered');
  assert.equal(priceFor(t, 'ollama-cloud', 'glm-5.3-flash', { baseURL: 'https://ollama.com/v1' }).inPerM, 0.15);
  assert.equal(p('clef').source, 'unpriced'); // output rate not offered: never guessed
  assert.equal(priceFor(t, 'ollama/glm-5.3-flash', undefined, { at: 0 }).inPerM, 0.15); // combined id, unknown baseURL = cloud
});
test('off-peak: Sat 10:00 UTC and Tue 19:00 UTC use the off-peak rate, Tue 13:00 UTC does not; models without one never change', () => {
  const t = { ...T, ollama: snapshotTable() };
  const r = (h, d, m = 'deepseek-v4.1-flash') => priceFor(t, 'ollama', m, { baseURL: 'https://ollama.com/v1', at: at(2026, 11, d, h) });
  assert.equal(r(10, 14).inPerM, 0.15);   // Sat
  assert.equal(r(10, 14).offPeak, true);
  assert.equal(r(13, 17).inPerM, 0.30);   // Tue 13:00
  assert.equal(r(12, 17).inPerM, 0.30); assert.equal(r(18, 17).inPerM, 0.15); assert.equal(r(11, 17).inPerM, 0.15);
  assert.equal(r(19, 17).inPerM, 0.15);   // Tue 19:00
  assert.equal(r(19, 17).outPerM, 0.6);
  assert.equal(r(13, 17, 'glm-5.3').inPerM, 1.4); assert.equal(r(10, 14, 'glm-5.3').inPerM, 1.4);
  assert.equal(r(10, 15, 'deepseek-v4-pro').inPerM, 0.66); // Sun
  assert.equal(isOffPeak(NaN), false);
});
test('route rules: loopback non-cloud is local; :cloud over loopback is billed; exact host only; PAID guard stays for other providers', () => {
  const t = { ...T, ollama: snapshotTable() };
  assert.equal(priceFor(t, 'ollama', 'gemma4:26b', { baseURL: 'http://127.0.0.1:11434/v1' }).billing, 'local');
  assert.equal(priceFor(t, 'ollama', 'glm-5.3:cloud', { baseURL: 'http://127.0.0.1:11434/v1' }).billing, 'metered');
  assert.equal(priceFor(t, 'ollama', 'glm-5.3:cloud', { baseURL: 'http://127.0.0.1:11434/v1' }).source, 'ollama-snapshot');
  assert.equal(priceFor(t, 'ollama', 'glm-5.3-flash', { baseURL: 'https://ollama.com.evil.example/v1' }).source, 'unpriced');
  assert.equal(priceFor(t, 'ollama', 'glm-5.3-flash', { baseURL: 'https://evil.example/ollama.com/v1' }).source, 'unpriced');
  assert.equal(priceFor(t, 'ollama', 'glm-5.3-flash', { baseURL: 'https://ollama.com@evil.example/v1' }).source, 'unpriced');
  assert.equal(priceFor(t, 'ollama', 'glm-5.3-flash', { baseURL: 'https://OLLAMA.com/v1' }).source, 'ollama-snapshot');
  assert.notEqual(priceFor(t, 'google', 'gemini-x', { localProviders: ['google'] }).billing, 'local'); // typo guard
  // localProviders cannot make cloud Ollama free either
  assert.equal(priceFor(t, 'ollama', 'glm-5.3-flash', { baseURL: 'https://ollama.com/v1', localProviders: ['ollama'] }).billing, 'metered');
  // a prices.json override still wins
  const ov = { ...t, overrides: { 'ollama/glm-5.3-flash': { inPerM: 9, outPerM: 9 } } };
  assert.equal(priceFor(ov, 'ollama', 'glm-5.3-flash', { baseURL: 'https://ollama.com/v1' }).source, 'override');
});
test('Z.ai coding endpoint -> subscription (API-equivalent from LiteLLM when known); lookalikes are not; declared subscription', () => {
  const t = { overrides: {}, entries: { 'glm-4.6': { input_cost_per_token: 6e-7, output_cost_per_token: 2.2e-6 } } };
  const p = priceFor(t, 'zai', 'glm-4.6', { baseURL: 'https://api.z.ai/api/coding/paas/v4' });
  assert.equal(p.billing, 'subscription'); assert.equal(p.inPerM, 0.6);
  assert.equal(priceFor(t, 'zai', 'glm-4.6', { baseURL: 'https://api.z.ai/api/paas/v4' }).billing, 'metered');
  for (const u of ['https://api.z.ai.evil.example/api/coding/x', 'https://evil.example/api.z.ai/api/coding/', 'https://api.z.ai@evil.example/api/coding/', 'http://api.z.ai/api/coding/x', 'https://api.z.ai/api/codingx', '']) assert.equal(isZaiCodingEndpoint(u), false, u);
  assert.equal(isZaiCodingEndpoint('https://api.z.ai/api/coding/paas/v4'), true);
  assert.equal(priceFor(t, 'acme', 'glm-4.6', { subscriptions: ['acme'] }).billing, 'subscription');
  assert.equal(priceFor(t, 'acme', 'glm-4.6', {}).billing, 'metered');
  assert.equal(priceFor(t, 'acme', 'glm-4.6', { subscriptions: ['acme'], localProviders: ['acme'] }).billing, 'local');
  assert.equal(ollamaModelKey(snapshotTable().models, '__proto__'), null);
});
test('parser: hostile page shapes (400k unclosed cells, 300k rows) finish fast and are rejected', () => {
  const t = Date.now();
  assert.equal(parseOllamaPricing('<table><tr>' + '<td>'.repeat(400000)), null);
  assert.equal(parseOllamaPricing('<table><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr>' + '<tr>'.repeat(300000)), null);
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
});
