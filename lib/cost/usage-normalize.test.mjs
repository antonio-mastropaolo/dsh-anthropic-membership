import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, promptTokens } from './usage-normalize.mjs';

test('DSH TokenUsage is already disjoint', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 5, reasoningTokens: 7, totalTokens: 1025 }),
    { input: 100, output: 20, cacheRead: 900, cacheWrite: 5 });
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 2 }), { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
});
test('pi-ai Usage / normalized shape passes through', () => {
  assert.deepEqual(normalizeUsage({ input: 5, output: 6, cacheRead: 7, cacheWrite: 8, totalTokens: 26, cost: { total: 1 } }), { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 });
});
test('OpenAI chat: prompt_tokens includes cached_tokens -> subtract (no double count)', () => {
  const u = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } });
  assert.deepEqual(u, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0 });
  assert.equal(promptTokens(u), 1000);
});
test('OpenAI chat with cache_write_tokens subtracts both', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } }),
    { input: 500, output: 1, cacheRead: 300, cacheWrite: 200 });
});
test('DeepSeek and top-level cached_tokens cache field placements', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }), { input: 40, output: 1, cacheRead: 60, cacheWrite: 0 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 1, cached_tokens: 30 }), { input: 70, output: 1, cacheRead: 30, cacheWrite: 0 });
});
test('cached > prompt never goes negative', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 50 } }).input, 0);
});
test('Anthropic: input excludes cache', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 105, output_tokens: 9, cache_read_input_tokens: 50, cache_creation_input_tokens: 93312 }),
    { input: 105, output: 9, cacheRead: 50, cacheWrite: 93312 });
});
test('OpenAI Responses subtracts input_tokens_details.cached_tokens; bare input_tokens stays', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 500, output_tokens: 5, input_tokens_details: { cached_tokens: 400 } }), { input: 100, output: 5, cacheRead: 400, cacheWrite: 0 });
  assert.deepEqual(normalizeUsage({ input_tokens: 500, output_tokens: 5 }), { input: 500, output: 5, cacheRead: 0, cacheWrite: 0 });
});
test('Gemini usageMetadata: cached subtracted, thoughts added to output', () => {
  assert.deepEqual(normalizeUsage({ promptTokenCount: 1000, candidatesTokenCount: 40, thoughtsTokenCount: 60, cachedContentTokenCount: 600, totalTokenCount: 1100 }),
    { input: 400, output: 100, cacheRead: 600, cacheWrite: 0 });
});
test('garbage in -> zeros, never throws', () => {
  for (const g of [null, undefined, 5, 'x', [], {}, { inputTokens: 'a', outputTokens: NaN }, { input: -3, output: Infinity }]) {
    const u = normalizeUsage(g);
    assert.deepEqual(u, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
});
test('idempotent on its own output', () => {
  const u = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } });
  assert.deepEqual(normalizeUsage(u), u);
});
