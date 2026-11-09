import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cycleStart, nextReset, applyCredits, planStatus } from './plans.mjs';
import { appendSpend, _resetLedgerCache, providerSpend } from './ledger.mjs';

const U = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h);
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cost-plans-'));

test('cycle start: the most recent resetsOnDay at 00:00 UTC', () => {
  assert.equal(cycleStart(9, U(2026, 11, 9, 5)), U(2026, 11, 9));     // reset day itself
  assert.equal(cycleStart(9, U(2026, 11, 8, 23)), U(2026, 10, 9));    // day before: last month's
  assert.equal(cycleStart(9, U(2026, 11, 20)), U(2026, 11, 9));
  assert.equal(cycleStart(1, U(2026, 1, 1)), U(2026, 1, 1));
  assert.equal(cycleStart(15, U(2026, 1, 3)), U(2025, 12, 15));       // across the year
});
test('resetsOnDay 31 is clamped to the month\'s last day (30-day month, February)', () => {
  assert.equal(cycleStart(31, U(2026, 11, 15)), U(2026, 10, 31));     // November has 30 days
  assert.equal(cycleStart(31, U(2026, 11, 30, 4)), U(2026, 11, 30));  // clamped reset day reached
  assert.equal(cycleStart(31, U(2026, 11, 29, 23)), U(2026, 10, 31));
  assert.equal(cycleStart(31, U(2026, 3, 1)), U(2026, 2, 28));        // 2026 is not a leap year
  assert.equal(cycleStart(30, U(2028, 3, 1)), U(2028, 2, 29));        // leap February
  assert.equal(nextReset(31, U(2026, 11, 15)), U(2026, 11, 30));
  assert.equal(nextReset(31, U(2026, 11, 30, 4)), U(2026, 12, 31));
  assert.equal(nextReset(9, U(2026, 11, 9, 5)), U(2026, 12, 9));
});
test('credits split: within, crossing, beyond the included amount', () => {
  const plan = { includedUsd: 10 };
  assert.deepEqual(applyCredits(plan, 2, 3), { billing: 'credits', usd: 0, apiEquivUsd: 3 });
  assert.deepEqual(applyCredits(plan, 5, 5), { billing: 'credits', usd: 0, apiEquivUsd: 5 }); // lands exactly on the line
  const cross = applyCredits(plan, 9, 3);
  assert.equal(cross.billing, 'metered'); assert.ok(Math.abs(cross.usd - 2) < 1e-9); assert.equal(cross.apiEquivUsd, 3);
  assert.deepEqual(applyCredits(plan, 10, 3), { billing: 'metered', usd: 3, apiEquivUsd: 3 });
  assert.deepEqual(applyCredits(plan, 50, 3), { billing: 'metered', usd: 3, apiEquivUsd: 3 });
  assert.deepEqual(applyCredits({ includedUsd: 0 }, 0, 1), { billing: 'metered', usd: 1, apiEquivUsd: 1 });
});
test('ledger: providerSpend sums only this provider\'s metered/credits api value since the cycle start', () => {
  const dir = mk(); _resetLedgerCache();
  const row = (ts, provider, billing, usd, api) => appendSpend(dir, { ts, provider, model: 'm', input: 1, output: 1, usd, apiEquivUsd: api, billing, priceSource: 'ollama' });
  row('2026-10-20T00:00:00Z', 'ollama', 'credits', 0, 5);     // before the cycle
  row('2026-11-10T00:00:00Z', 'ollama', 'credits', 0, 2);
  row('2026-11-11T00:00:00Z', 'ollama', 'metered', 1, 3);     // crossing row: 1 overage of 3 api value
  row('2026-11-12T00:00:00Z', 'google', 'metered', 9, 9);     // other provider
  row('2026-11-12T00:00:00Z', 'ollama', 'subscription', 0, 7); // not credit spend
  const r = providerSpend(dir, 'ollama', U(2026, 11, 9));
  assert.equal(r.apiEquivUsd, 5); assert.equal(r.complete, true);
});
test('planStatus: used, remaining, overage, cycle dates', () => {
  const dir = mk(); _resetLedgerCache();
  appendSpend(dir, { ts: '2026-11-10T00:00:00Z', provider: 'ollama', model: 'm', usd: 0, apiEquivUsd: 62, billing: 'credits', priceSource: 'ollama' });
  const now = U(2026, 11, 20);
  const [s] = planStatus(dir, { ollama: { name: 'Pro', includedUsd: 60, resetsOnDay: 9 } }, now);
  assert.equal(s.provider, 'ollama'); assert.equal(s.name, 'Pro');
  assert.equal(s.usedUsd, 60); assert.equal(s.remainingUsd, 0); assert.equal(s.overageUsd, 2);
  assert.equal(s.cycleStart, '2026-11-09T00:00:00.000Z'); assert.equal(s.resetsAt, '2026-12-09T00:00:00.000Z');
  assert.equal(s.complete, true);
});
