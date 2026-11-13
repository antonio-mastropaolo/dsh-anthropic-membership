import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSpend, summarize, KNOWN_FIELDS } from './ledger.mjs';
import { makeSpendRecord, costOf, usdFromRates } from './cost.mjs';
import { reasoningTokens } from './usage-normalize.mjs';

const mk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-v2-')), 'hub');
const P = { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: 'litellm', billing: 'metered', derived: ['cacheWrite'] };
const U = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, reasoningTokens: 40 };

test('makeSpendRecord writes a v2 row with the rates actually used, tier, derived, purpose chat, and honest nulls', () => {
  const r = makeSpendRecord({ sessionId: 's1', provider: 'google', model: 'm', usage: U, price: P, meta: { turn: 3, step: 2, finish: 'stop', ttftMs: 120, durationMs: 900 } });
  assert.equal(r.v, 2); assert.equal(r.purpose, 'chat');
  assert.deepEqual(r.rates, { inPerM: 2, outPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 });
  assert.deepEqual(r.derived, ['cacheWritePerM']);
  assert.equal(r.tier, 'base'); assert.equal(r.offPeak, false); assert.equal(r.planCoveredUsd, 0);
  assert.equal(r.reasoning, 40); assert.equal(r.turn, 3); assert.equal(r.step, 2);
  assert.equal(r.parentSessionId, null); assert.equal(r.finish, 'stop'); assert.equal(r.ttftMs, 120); assert.equal(r.durationMs, 900);
  assert.ok(Math.abs(r.apiEquivUsd - usdFromRates({ input: 1000, output: 100, cacheRead: 9000, cacheWrite: 0 }, r.rates)) < 1e-9);
  const bare = makeSpendRecord({ sessionId: 's1', provider: 'google', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, price: P });
  assert.deepEqual([bare.turn, bare.step, bare.parentSessionId, bare.reasoning, bare.finish, bare.ttftMs, bare.durationMs], [null, null, null, null, null, null, null]);
});

test('above200k rows store the high-tier rates and derived list; costOf exposes the same rates', () => {
  const price = { ...P, derived: [], above200k: { inPerM: 4, outPerM: 18, cacheReadPerM: 0.4, cacheWritePerM: 5, derived: ['cacheReadPerM'] } };
  const r = makeSpendRecord({ sessionId: 's', provider: 'p', model: 'm', usage: { inputTokens: 150000, outputTokens: 10, cacheReadTokens: 100000 }, price });
  assert.equal(r.tier, 'above200k'); assert.equal(r.rates.inPerM, 4); assert.deepEqual(r.derived, ['cacheReadPerM']);
  assert.equal(costOf({ input: 150000, output: 10, cacheRead: 100000 }, price).rates.outPerM, 18);
});

test('an unpriced model stores rates:null and derived:null and apiEquivUsd 0 (never a guess)', () => {
  const r = makeSpendRecord({ sessionId: 's', provider: 'p', model: 'm', usage: U, price: { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, source: 'unpriced', billing: 'metered' } });
  assert.equal(r.rates, null); assert.equal(r.derived, null); assert.equal(r.apiEquivUsd, 0);
  const sub = makeSpendRecord({ sessionId: 's', provider: 'p', model: 'm', usage: U, price: { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, source: 'subscription', billing: 'subscription', apiEquivKnown: false } });
  assert.equal(sub.rates, null, 'a subscription model with no known API-equivalent price has no rates either');
});

test('reasoningTokens: DSH, pi-ai, OpenAI chat/responses, Gemini shapes; null when not reported (0 is a report)', () => {
  assert.equal(reasoningTokens({ inputTokens: 1, outputTokens: 5, reasoningTokens: 3 }), 3);
  assert.equal(reasoningTokens({ input: 1, output: 5, reasoning: 2 }), 2);
  assert.equal(reasoningTokens({ prompt_tokens: 1, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 } }), 4);
  assert.equal(reasoningTokens({ input_tokens: 1, output_tokens: 9, output_tokens_details: { reasoning_tokens: 6 } }), 6);
  assert.equal(reasoningTokens({ promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 7 }), 7);
  assert.equal(reasoningTokens({ inputTokens: 1, outputTokens: 5 }), null);
  assert.equal(reasoningTokens({ inputTokens: 1, outputTokens: 5, reasoningTokens: 0 }), 0);
  assert.equal(reasoningTokens(null), null);
});

test('a v2 row round-trips through the ledger; text and unknown fields are dropped; a v1 row gains no v2 key', () => {
  const d = mk();
  const v2 = makeSpendRecord({ sessionId: 's', provider: 'google', model: 'm', usage: U, price: P, meta: { turn: 1, step: 1, finish: 'stop' } });
  appendSpend(d, { ...v2, prompt: 'SECRET PROMPT', completion: 'SECRET', messages: [] });
  appendSpend(d, { ts: new Date().toISOString(), sessionId: 's', provider: 'google', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 0.1, apiEquivUsd: 0.1, priceSource: 'litellm', billing: 'metered', rates: { inPerM: 1 }, purpose: 'chat' });
  const lines = fs.readFileSync(path.join(d, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(!/SECRET/.test(JSON.stringify(lines)));
  for (const l of lines) for (const k of Object.keys(l)) assert.ok(KNOWN_FIELDS.has(k), k);
  assert.deepEqual(lines[0].rates, v2.rates);
  assert.ok(!('v' in lines[1]) && !('rates' in lines[1]) && !('purpose' in lines[1]), 'v1 rows stay v1');
});

test('invalid v2 values become null, never guessed', () => {
  const d = mk();
  const base = makeSpendRecord({ sessionId: 's', provider: 'p', model: 'm', usage: U, price: P });
  const out = appendSpend(d, { ...base, turn: -1, step: 'x', rates: { inPerM: 1 }, tier: 'weird', finish: 'STOP!', ttftMs: 'fast', parentSessionId: 12, derived: ['bogus'] });
  assert.deepEqual([out.turn, out.step, out.rates, out.tier, out.finish, out.ttftMs, out.parentSessionId, out.derived], [null, null, null, null, null, null, null, null]);
});

test('summarize by purpose: v2 rows bucket by purpose, v1 rows by "unknown"; other reports are unchanged', () => {
  const d = mk();
  const mkRow = (purpose, usd) => ({ ...makeSpendRecord({ sessionId: 's', provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, price: P, meta: { purpose } }), usd, apiEquivUsd: usd });
  appendSpend(d, mkRow('chat', 1)); appendSpend(d, mkRow('chat', 2)); appendSpend(d, mkRow('compaction', 0.5));
  appendSpend(d, { ts: new Date().toISOString(), sessionId: 's', provider: 'p', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, usd: 4, apiEquivUsd: 4, priceSource: 'litellm', billing: 'metered' });
  const s = summarize(d, { since: 'all', by: 'purpose' });
  assert.deepEqual(Object.keys(s.groups).sort(), ['chat', 'compaction', 'unknown']);
  assert.equal(s.groups.chat.usd, 3); assert.equal(s.groups.chat.calls, 2); assert.equal(s.groups.unknown.usd, 4);
  assert.equal(s.byPurpose, s.groups); assert.equal(s.totals.usd, 7.5); assert.equal(summarize(d, { by: 'provider' }).groups.p.calls, 4);
  assert.throws(() => summarize(d, { by: 'nope' }), /provider\|model\|session\|day\|purpose/);
});

test('price layer flags derived rates: override rows that omit a cache rate, and above200k rows missing a published rate', async () => {
  const { priceFor } = await import('./prices.mjs');
  const o = priceFor({ entries: {}, overrides: { 'acme/m': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.1 } } }, 'acme', 'm', { localProviders: [] });
  assert.equal(o.source, 'override'); assert.deepEqual(o.derived, ['cacheWrite']);
  const full = priceFor({ entries: {}, overrides: { 'acme/m': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 1.2 } } }, 'acme', 'm', { localProviders: [] });
  assert.equal(full.derived, undefined);
  const e = { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 1e-7, cache_creation_input_token_cost: 1.25e-6,
    input_cost_per_token_above_200k_tokens: 2e-6, output_cost_per_token_above_200k_tokens: 1e-5, cache_read_input_token_cost_above_200k_tokens: 2e-7 };
  const hi = priceFor({ entries: { 'claude-x': e }, overrides: {} }, 'openrouter', 'claude-x');
  assert.deepEqual(hi.above200k.derived, ['cacheWritePerM']);
  const rec = makeSpendRecord({ sessionId: 's', provider: 'openrouter', model: 'claude-x', usage: { inputTokens: 300000, outputTokens: 1 }, price: hi });
  assert.equal(rec.tier, 'above200k'); assert.deepEqual(rec.derived, ['cacheWritePerM']);
});
