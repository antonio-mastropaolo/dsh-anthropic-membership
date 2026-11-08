import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, chargedUsd, makeSpendRecord } from './cost.mjs';

const P = { inPerM: 0.75, outPerM: 3.75, cacheReadPerM: 0.075, cacheWritePerM: 0.75, billing: 'metered', source: 'litellm' };

test('costOf hand-computed (Gemini flash rates)', () => {
  const c = costOf({ input: 1000, output: 2000, cacheRead: 10000, cacheWrite: 0 }, P);
  // 1000*0.75/1e6 + 2000*3.75/1e6 + 10000*0.075/1e6
  assert.equal(c.inUsd, 0.00075); assert.equal(c.outUsd, 0.0075); assert.equal(c.cacheReadUsd, 0.00075);
  assert.equal(c.usd, 0.009); assert.equal(c.tier, 'base');
});
test('cache is not double counted from OpenAI-style usage', () => {
  const c = costOf({ prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1000 } }, P);
  assert.equal(c.inUsd, 0); assert.equal(c.cacheReadUsd, 0.000075);
});
test('cache-write bills at the write rate (the 170x-underestimate guard)', () => {
  const c = costOf({ input: 105, output: 0, cacheRead: 0, cacheWrite: 93312 }, { ...P, inPerM: 5, cacheWritePerM: 6.25 });
  assert.equal(c.cacheWriteUsd, 0.5832); assert.ok(c.usd > 0.58);
});
test('above200k tier switches whole request when billed prompt > 200k', () => {
  const price = { ...P, inPerM: 2, outPerM: 12, cacheReadPerM: 0.2, above200k: { inPerM: 4, outPerM: 18, cacheReadPerM: 0.4 } };
  const lo = costOf({ input: 200000, output: 1000, cacheRead: 0, cacheWrite: 0 }, price);
  assert.equal(lo.tier, 'base'); assert.equal(lo.inUsd, 0.4);
  const hi = costOf({ input: 100000, output: 1000, cacheRead: 100001, cacheWrite: 0 }, price);
  assert.equal(hi.tier, 'above200k'); assert.equal(hi.inUsd, 0.4); assert.equal(hi.outUsd, 0.018); assert.equal(hi.cacheReadUsd, 0.040000);
});
test('no above200k schedule -> stays base for huge prompts', () => {
  assert.equal(costOf({ input: 900000, output: 0 }, P).tier, 'base');
});
test('zero price => zero cost; missing price => zero', () => {
  assert.equal(costOf({ input: 5e6, output: 5e6 }, { inPerM: 0, outPerM: 0 }).usd, 0);
  assert.equal(costOf({ input: 5e6, output: 5e6 }, undefined).usd, 0);
});
test('chargedUsd only for metered', () => {
  const c = { usd: 3 };
  assert.equal(chargedUsd(c, { billing: 'metered' }), 3);
  for (const b of ['subscription', 'free', 'local']) assert.equal(chargedUsd(c, { billing: b }), 0);
});
test('makeSpendRecord: subscription charges 0 but keeps apiEquivUsd; no content fields', () => {
  const rec = makeSpendRecord({ sessionId: 's1', provider: 'anthropic', model: 'claude-opus-4-8', usage: { inputTokens: 1e6, outputTokens: 0 },
    price: { inPerM: 5, outPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25, billing: 'subscription', source: 'subscription' } });
  assert.equal(rec.usd, 0); assert.equal(rec.apiEquivUsd, 5); assert.equal(rec.billing, 'subscription');
  assert.deepEqual(Object.keys(rec).sort(), ['apiEquivUsd', 'billing', 'cacheRead', 'cacheWrite', 'input', 'model', 'output', 'priceSource', 'provider', 'sessionId', 'ts', 'usd']);
});
