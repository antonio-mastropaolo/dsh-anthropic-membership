import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlanGuard, evaluatePlanLimit, planBlockedStream, windowsFor, PLAN_LIMIT_CODE, PLAN_MAX_AGE_MS, PLAN_READ_BUDGET_MS } from './plan-guard.mjs';
import { isCreditFailure } from '../host/engine.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const FUTURE = '2026-11-12T15:00:00Z';
const PAST = '2026-11-12T10:00:00Z';
const w = (percent, resetsAt = FUTURE) => ({ percent, resetsAt });
const plan = (over = {}) => ({ mode: 'plan', fetchedAt: NOW - 1000, fiveHour: w(10), sevenDay: w(10), scopedWeekly: null, sevenDayOpus: null, sevenDaySonnet: null, ...over });
const dirWith = (caps) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-guard-'));
  if (caps !== null) fs.writeFileSync(path.join(d, 'caps.json'), JSON.stringify(caps));
  return d;
};
const ask = (g, model = 'claude-opus-5-5') => g.check({ provider: 'anthropic', model, billing: 'subscription' });
const guardFor = (p, caps = { stopAtPlanLimit: true }, extra = {}) => createPlanGuard({ dataDir: dirWith(caps), getPlan: async () => p, now: () => NOW, ...extra });

test('constants: 10 minutes of trust, 2 seconds of waiting', () => {
  assert.equal(PLAN_MAX_AGE_MS, 600000);
  assert.equal(PLAN_READ_BUDGET_MS, 2000);
  assert.equal(PLAN_LIMIT_CODE, 'PLAN_LIMIT');
});

test('blocks at 100% on the 5-hour window, naming the window and the reset time', async () => {
  const v = await ask(guardFor(plan({ fiveHour: w(100) })));
  assert.equal(v.action, 'block');
  assert.equal(v.code, 'PLAN_LIMIT');
  assert.equal(v.which, 'plan-limit');
  assert.match(v.reason, /5-hour window is at 100%.*resets/);
});

test('blocks on the weekly window; per-model weekly only for that model family', async () => {
  assert.equal((await ask(guardFor(plan({ sevenDay: w(100) })))).action, 'block');
  const opus = plan({ sevenDayOpus: w(100) });
  const vo = await ask(guardFor(opus), 'claude-opus-5-5');
  assert.equal(vo.action, 'block');
  assert.match(vo.reason, /weekly Opus window/);
  assert.equal((await ask(guardFor(opus), 'claude-sonnet-5-5')).action, 'ok');
  const son = plan({ sevenDaySonnet: w(100) });
  assert.equal((await ask(guardFor(son), 'claude-sonnet-5-5')).action, 'block');
  assert.equal((await ask(guardFor(son), 'claude-opus-5-5')).action, 'ok');
  assert.equal((await ask(guardFor(son), 'claude-haiku-5')).action, 'ok');
  const labelled = plan({ scopedWeekly: { label: 'Opus', ...w(100) } });
  assert.equal((await ask(guardFor(labelled), 'claude-opus-5-5')).action, 'block');
  assert.equal((await ask(guardFor(labelled), 'claude-sonnet-5-5')).action, 'ok');
  const unnamed = plan({ scopedWeekly: { label: 'Research', ...w(100) } });
  assert.equal((await ask(guardFor(unnamed), 'claude-opus-5-5')).action, 'ok');
  assert.deepEqual(windowsFor(plan({ sevenDayOpus: w(50) }), 'claude-haiku-5').map((x) => x.label), ['5-hour window', 'weekly window']);
});

test('allows at 99% on every window', async () => {
  const p = plan({ fiveHour: w(99), sevenDay: w(99), sevenDayOpus: w(99), sevenDaySonnet: w(99), scopedWeekly: { label: 'Opus', ...w(99) } });
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5']) assert.equal((await ask(guardFor(p), m)).action, 'ok');
});

test('allows when the setting is off or absent, and a caps.json flip applies on the next call', async () => {
  const exhausted = plan({ fiveHour: w(100) });
  for (const caps of [null, {}, { stopAtPlanLimit: false }]) {
    const v = await ask(guardFor(exhausted, caps));
    assert.equal(v.action, 'ok'); assert.equal(v.why, 'off');
  }
  const d = dirWith({ stopAtPlanLimit: false });
  const g = createPlanGuard({ dataDir: d, getPlan: async () => exhausted, now: () => NOW });
  assert.equal((await ask(g)).action, 'ok');
  fs.writeFileSync(path.join(d, 'caps.json'), JSON.stringify({ stopAtPlanLimit: true }));
  assert.equal((await ask(g)).action, 'block');
  fs.writeFileSync(path.join(d, 'caps.json'), JSON.stringify({ stopAtPlanLimit: false }));
  assert.equal((await ask(g)).action, 'ok');
});

test('fails open: stale, exactly 10 min trusted, missing/future fetchedAt, other modes, errors, hang, reset window, null percent', async () => {
  const hot = { fiveHour: w(100) };
  const stale = await ask(guardFor(plan({ ...hot, fetchedAt: NOW - PLAN_MAX_AGE_MS - 1 })));
  assert.equal(stale.action, 'ok'); assert.equal(stale.why, 'gauge-stale');
  assert.equal((await ask(guardFor(plan({ ...hot, fetchedAt: NOW - PLAN_MAX_AGE_MS })))).action, 'block');
  for (const fetchedAt of [undefined, null, NOW + 5000, 'soon']) {
    const v = await ask(guardFor(plan({ ...hot, fetchedAt })));
    assert.equal(v.action, 'ok'); assert.equal(v.why, 'gauge-stale');
  }
  for (const mode of ['unavailable', 'expired', 'api', 'signed-out']) {
    const v = await ask(guardFor({ ...plan(hot), mode }));
    assert.equal(v.action, 'ok'); assert.equal(v.why, 'gauge-unavailable');
  }
  assert.equal((await ask(guardFor(null))).action, 'ok');
  const thrown = await ask(createPlanGuard({ dataDir: dirWith({ stopAtPlanLimit: true }), getPlan: async () => { throw new Error('boom'); }, now: () => NOW }));
  assert.equal(thrown.action, 'ok');
  const syncThrow = await ask(createPlanGuard({ dataDir: dirWith({ stopAtPlanLimit: true }), getPlan: () => { throw new Error('boom'); }, now: () => NOW }));
  assert.equal(syncThrow.action, 'ok');
  const t0 = Date.now();
  const hung = await ask(createPlanGuard({ dataDir: dirWith({ stopAtPlanLimit: true }), getPlan: () => new Promise(() => {}), now: () => NOW, budgetMs: 20 }));
  assert.equal(hung.action, 'ok');
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the hung gauge');
  const reset = await ask(guardFor(plan({ fiveHour: w(100, PAST) })));
  assert.equal(reset.action, 'ok'); assert.equal(reset.why, 'under-limit');
  assert.equal((await ask(guardFor(plan({ fiveHour: w(null), sevenDay: w(undefined) })))).action, 'ok');
  assert.equal((await ask(guardFor(plan({ fiveHour: w(100, null) })))).action, 'block', 'no reset time: still blocks, without a time');
});

test('never touches other providers or billing kinds: getPlan is not called, and an exhausted plan still gives ok', async () => {
  let calls = 0;
  const g = createPlanGuard({ dataDir: dirWith({ stopAtPlanLimit: true }), getPlan: async () => { calls++; return plan({ fiveHour: w(100), sevenDay: w(100) }); }, now: () => NOW });
  for (const [provider, billing] of [['google', 'subscription'], ['openai-codex', 'subscription'], ['anthropic', 'metered'], ['anthropic', 'local'], ['anthropic', 'free'], ['anthropic', 'credits'], ['anthropic', undefined], [undefined, 'subscription']]) {
    const v = await g.check({ provider, model: 'claude-opus-5-5', billing });
    assert.equal(v.action, 'ok', `${provider}/${billing}`);
    assert.equal(v.why, 'not-claude-subscription', `${provider}/${billing}`);
  }
  assert.equal(calls, 0, 'the gauge is never read for other providers or billing kinds');
  assert.equal((await ask(g)).action, 'block', 'the same guard does block anthropic/subscription on that plan');
  assert.equal(calls, 1);
});

test('the guard never uses the network', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'plan-guard.mjs'), 'utf8');
  assert.ok(!/fetch\s*\(/.test(src));
  assert.ok(!/\bhttps?\b/.test(src));
  assert.ok(!/node:(http|https|net|dns)/.test(src));
});

test('evaluatePlanLimit is pure: no plan, no block', () => {
  assert.equal(evaluatePlanLimit({ plan: undefined, model: 'x', now: NOW }).action, 'ok');
});

test('planBlockedStream yields one finish/error chunk with code PLAN_LIMIT; isCreditFailure does not match it', async () => {
  const chunks = [];
  for await (const c of planBlockedStream('your Claude 5-hour window is at 100% of the plan')) chunks.push(c);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'PLAN_LIMIT');
  assert.match(chunks[0].reason.failure.message, /5-hour window/);
  assert.match(chunks[0].reason.failure.message, /stopAtPlanLimit=off/);
  assert.equal(isCreditFailure(chunks[0].reason.failure), false);
  assert.ok(Object.isFrozen(chunks[0].reason.failure));
});
