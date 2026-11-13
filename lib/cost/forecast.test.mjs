import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendSpend, _resetLedgerCache, resolveSince } from './ledger.mjs';
import { planStatus } from './plans.mjs';
import { loadCaps } from './caps.mjs';
import { appendReading } from '../plan-history.mjs';
import { ewmaPerHour, nextLocalMidnight, spendForecast, buildForecast, MIN_CALLS } from './forecast.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cost-forecast-'));
// local-time constructor: the tests do not depend on the machine's time zone
const NOW = new Date(2026, 10, 12, 14, 0).getTime();
const CAPS = { dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {} };
const MIN = 60e3;

function row(dir, minAgo, { usd = 0.02, api = usd, provider = 'openai', billing = 'metered', sessionId = 's1', now = NOW } = {}) {
  return appendSpend(dir, { ts: new Date(now - minAgo * MIN).toISOString(), sessionId, provider, model: 'm', input: 1, output: 1, usd, apiEquivUsd: api, priceSource: 'litellm', billing });
}
// one row per minute at half-minute ages (0.5, 1.5, ...): no row sits exactly on a slice edge, so the slice rates are not lumpy
const steady = (dir, minutes, opts = {}, from = 0) => { for (let i = from; i < minutes; i++) row(dir, i + 0.5, opts); };
const fc = (dir, o = {}) => spendForecast(dir, { now: NOW, caps: CAPS, ...o });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (+-${tol})`);

test('ewmaPerHour: constant spend returns that rate, a recent burst outweighs old spend', () => {
  const edges = [0, 2, 5, 9, 15, 30, 60];
  const constant = edges.slice(1).map((e, i) => ({ fromMin: edges[i], toMin: e, value: 1.2 * ((e - edges[i]) / 60) }));
  near(ewmaPerHour(constant, 15), 1.2, 1e-6, 'm15');
  near(ewmaPerHour(constant, 60), 1.2, 1e-6, 'm60');
  const burst = edges.slice(1).map((e, i) => ({ fromMin: edges[i], toMin: e, value: i === 0 ? 0.5 : 0 }));
  const m15 = ewmaPerHour(burst, 15), m60 = ewmaPerHour(burst, 60);
  near(m15, 5.2, 0.1, 'burst m15'); near(m60, 1.5, 0.1, 'burst m60');
  assert.ok(m15 > m60);
  assert.equal(ewmaPerHour([], 15), 0);
});

test('nextLocalMidnight equals the start of the local day plus one local day, also across a DST change', () => {
  const was = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const dst = new Date(2026, 10, 1, 12, 0).getTime(); // the 25-hour day (clocks go back)
    assert.equal(nextLocalMidnight(dst) - resolveSince('today', dst), 25 * 3600e3);
    const plain = new Date(2026, 10, 12, 12, 0).getTime();
    assert.equal(nextLocalMidnight(plain) - resolveSince('today', plain), 24 * 3600e3);
    const spring = new Date(2026, 2, 8, 12, 0).getTime(); // the 23-hour day
    assert.equal(nextLocalMidnight(spring) - resolveSince('today', spring), 23 * 3600e3);
  } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
});

test('steady metered pace: rates, projection to local midnight', () => {
  const dir = mk(); _resetLedgerCache();
  steady(dir, 60);
  const { charged } = fc(dir);
  assert.equal(charged.status, 'ok');
  near(charged.ratePerHour.m15, 1.2, 0.1, 'm15'); near(charged.ratePerHour.m60, 1.2, 0.1, 'm60');
  assert.ok(charged.calls15 >= 14, `calls15 ${charged.calls15}`);
  assert.equal(charged.calls60, 60);
  near(charged.todayUsd, 1.2, 1e-6, 'today');
  assert.equal(charged.midnightAt, new Date(2026, 10, 13).getTime());
  near(charged.projectedTodayUsd.mid, charged.todayUsd + charged.ratePerHour.m15 * 10, 1e-4, 'mid');
  near(charged.projectedTodayUsd.mid, 13.2, 0.5, 'mid ~13.2');
  assert.ok(charged.projectedTodayUsd.low <= charged.projectedTodayUsd.mid + 1e-9);
  assert.ok(charged.projectedTodayUsd.mid <= charged.projectedTodayUsd.high + 1e-9);
});

test('fewer than 3 chargeable calls in 15 min is suppressed with the reason and no numbers', () => {
  const dir = mk(); _resetLedgerCache();
  row(dir, 1); row(dir, 3);
  const r = fc(dir);
  assert.equal(r.charged.status, 'suppressed');
  assert.match(r.charged.reason, /fewer than 3 metered calls in the last 15 min \(2\)/);
  assert.equal(r.charged.ratePerHour, null);
  assert.equal(r.charged.projectedTodayUsd, null);
  assert.ok(r.caps.length >= 2);
  for (const c of r.caps) { assert.ok(['suppressed', 'reached'].includes(c.state), c.which + ' ' + c.state); assert.equal(c.reachedAt, null); assert.equal(c.range, null); }
  assert.match(r.caps[0].reason, /fewer than 3 metered calls/);
});

test('exactly 3 calls is enough', () => {
  const dir = mk(); _resetLedgerCache();
  row(dir, 1); row(dir, 2); row(dir, 3);
  assert.equal(MIN_CALLS, 3);
  const r = fc(dir);
  assert.equal(r.charged.status, 'ok');
  assert.equal(r.charged.calls15, 3);
  assert.ok(r.charged.ratePerHour.m15 > 0);
  assert.notEqual(r.caps[0].state, 'suppressed');
});

test('subscription and local calls neither count toward the 3 calls nor add dollars; their API value is reported as "API value, not charged"', () => {
  const dir = mk(); _resetLedgerCache();
  row(dir, 1, { usd: 0.5 }); row(dir, 2, { usd: 0.5 });
  for (let i = 0; i < 5; i++) row(dir, 1 + i, { provider: 'anthropic', billing: 'subscription', usd: 0, api: 0.1 });
  for (let i = 0; i < 4; i++) row(dir, 1 + i, { provider: 'rocco', billing: 'local', usd: 0, api: 0 });
  const r = fc(dir);
  assert.equal(r.charged.status, 'suppressed');
  assert.equal(r.charged.calls15, 2);
  assert.equal(r.charged.todayUsd, 1);
  assert.equal(r.apiValue.label, 'API value, not charged');
  assert.equal(r.apiValue.status, 'ok');
  assert.equal(r.apiValue.calls15, 5);
  near(r.apiValue.ratePerHour.m15, 2.0, 1e-6, 'api m15 = 0.5 / 0.25 h');
  // too few subscription calls: the API value pace is suppressed on its own
  const dir2 = mk(); _resetLedgerCache();
  row(dir2, 1, { provider: 'anthropic', billing: 'subscription', usd: 0, api: 0.1 });
  const r2 = fc(dir2);
  assert.equal(r2.apiValue.status, 'suppressed');
  assert.equal(r2.apiValue.ratePerHour, null);
  assert.match(r2.apiValue.reason, /fewer than 3 subscription or credits calls/);
});

test('a cap that will be reached at this pace gets a time and a range from the 15- and 60-minute rates', () => {
  const dir = mk(); _resetLedgerCache();
  steady(dir, 15, { usd: 0.06 });           // 3.6 $/h in the last 15 minutes
  steady(dir, 60, { usd: 0.02 }, 15);       // 1.2 $/h before that
  const base = fc(dir);
  const { m15, m60 } = base.charged.ratePerHour;
  assert.ok(m15 > m60, `m15 ${m15} > m60 ${m60}`);
  const todayUsd = base.charged.todayUsd;
  const cap = todayUsd + 3.6;
  const r = fc(dir, { caps: { dailyUsd: cap, sessionUsd: 0, perProviderDailyUsd: {} } });
  const d = r.caps.find((c) => c.which === 'daily');
  assert.equal(d.state, 'at-pace');
  near(d.reachedAt, NOW + (3.6 / m15) * 3600e3, 2 * MIN, 'reachedAt from the 15 min rate');
  assert.ok(d.range.earliestAt <= d.reachedAt + 1000, 'earliest <= headline');
  assert.ok(d.range.latestAt === null || d.range.latestAt > d.reachedAt, 'latest is later (or beyond the horizon)');
  near(d.range.latestAt, NOW + (3.6 / m60) * 3600e3, 2 * MIN, 'latest from the 60 min rate');
  assert.equal(d.capUsd, cap); assert.equal(d.resetsAt, new Date(2026, 10, 13).getTime());
});

test('a cap already reached is reported as reached even when the pace is suppressed', () => {
  const dir = mk(); _resetLedgerCache();
  row(dir, 1, { usd: 50 });
  const r = fc(dir, { caps: { dailyUsd: 40, sessionUsd: 0, perProviderDailyUsd: { openai: 10, google: 10 } } });
  assert.equal(r.charged.status, 'suppressed');
  const d = r.caps.find((c) => c.which === 'daily');
  assert.equal(d.state, 'reached'); assert.equal(d.reachedAt, null); assert.equal(d.spentUsd, 50);
  assert.equal(r.caps.find((c) => c.provider === 'openai').state, 'reached');
  assert.equal(r.caps.find((c) => c.provider === 'google').state, 'suppressed');
});

test('a cap that is never reached at this pace says so', () => {
  const dir = mk(); _resetLedgerCache();
  row(dir, 1, { usd: 0.001 }); row(dir, 2, { usd: 0.001 }); row(dir, 3, { usd: 0.001 });
  const r = fc(dir);
  const d = r.caps.find((c) => c.which === 'daily');
  assert.equal(d.state, 'not-at-this-pace');
  assert.equal(d.reachedAt, null);
  assert.equal(d.reason, null);
});

test('midnight crossing: a daily cap that would be hit after local midnight is not-at-this-pace', () => {
  const now = new Date(2026, 10, 12, 23, 50).getTime();
  const dir = mk(); _resetLedgerCache();
  for (let i = 0; i < 60; i++) row(dir, i + 0.5, { usd: 0.1, now });   // $6/h
  const run = (extra) => spendForecast(dir, { now, caps: { dailyUsd: 0, sessionUsd: 0, perProviderDailyUsd: {} } });
  const today = run().charged.todayUsd;
  near(run().charged.ratePerHour.m15, 6, 0.3, 'pace 6/h');
  const after = spendForecast(dir, { now, caps: { dailyUsd: today + 1.5, sessionUsd: 0, perProviderDailyUsd: {} } }).caps[0];
  assert.equal(after.state, 'not-at-this-pace', '15 min away is 00:05, past midnight');
  const before = spendForecast(dir, { now, caps: { dailyUsd: today + 0.5, sessionUsd: 0, perProviderDailyUsd: {} } }).caps[0];
  assert.equal(before.state, 'at-pace', '5 min away is 23:55, before midnight');
  assert.ok(before.reachedAt < new Date(2026, 10, 13).getTime());
});

test("after midnight today's spend counts only the new day while the pace window still sees the evening", () => {
  const now = new Date(2026, 10, 13, 0, 10).getTime();
  const dir = mk(); _resetLedgerCache();
  for (let m = 30; m < 60; m++) appendSpend(dir, { ts: new Date(2026, 10, 12, 23, m, 30).toISOString(), sessionId: 's1', provider: 'openai', model: 'm', usd: 0.02, apiEquivUsd: 0.02, billing: 'metered', priceSource: 'litellm' });
  for (let m = 0; m < 10; m++) appendSpend(dir, { ts: new Date(2026, 10, 13, 0, m, 30).toISOString(), sessionId: 's1', provider: 'openai', model: 'm', usd: 0.02, apiEquivUsd: 0.02, billing: 'metered', priceSource: 'litellm' });
  const r = spendForecast(dir, { now, caps: CAPS });
  near(r.charged.todayUsd, 0.2, 1e-6, 'only the post-midnight rows');
  assert.equal(r.charged.calls60, 40, 'the 60 minute window sees both sides of midnight');
  assert.equal(r.charged.calls15, 15);
  assert.equal(r.charged.midnightAt, new Date(2026, 10, 14).getTime());
});

test("per-provider cap uses that provider's own pace and own call count", () => {
  const dir = mk(); _resetLedgerCache();
  steady(dir, 60, { provider: 'openai' });
  row(dir, 2, { provider: 'google', usd: 0.5 });
  const r = fc(dir, { caps: { dailyUsd: 0, sessionUsd: 0, perProviderDailyUsd: { openai: 2.4, google: 5 } } });
  const o = r.caps.find((c) => c.provider === 'openai');
  assert.equal(o.which, 'provider-daily');
  assert.equal(o.state, 'at-pace');
  near(o.reachedAt, NOW + ((2.4 - o.spentUsd) / 1.2) * 3600e3, 5 * MIN, 'openai time from its own 1.2 $/h');
  assert.ok(o.calls15 >= 14);
  const g = r.caps.find((c) => c.provider === 'google');
  assert.equal(g.state, 'suppressed');
  assert.equal(g.calls15, 1);
  assert.match(g.reason, /fewer than 3 metered calls for google in the last 15 min \(1\)/);
  assert.equal(r.charged.status, 'ok', 'the global pace has its own count');
});

test('session cap: the session in use, whole-history spend, 24 h horizon; a cap of 0 gives no entry', () => {
  const dir = mk(); _resetLedgerCache();
  row(dir, 30 * 60, { usd: 10, sessionId: 's1' });            // 30 h ago, same session
  row(dir, 40 * 60, { usd: 9, sessionId: 'old' });            // another, older session
  steady(dir, 60, { sessionId: 's1' });
  const r = fc(dir, { caps: { dailyUsd: 0, sessionUsd: 15, perProviderDailyUsd: {} } });
  assert.equal(r.caps.length, 1, 'dailyUsd 0 gives no daily entry');
  const s = r.caps[0];
  assert.equal(s.which, 'session'); assert.equal(s.sessionId, 's1');
  near(s.spentUsd, 11.2, 1e-6, 'whole history of s1');
  assert.equal(s.state, 'at-pace');
  near(s.reachedAt, NOW + ((15 - 11.2) / 1.2) * 3600e3, 5 * MIN, 'session ETA');
  assert.equal(s.horizonAt, NOW + 24 * 3600e3, 'a session cap has no reset: the 24 h look-ahead is a horizon');
  assert.equal('resetsAt' in s, false);
  // beyond 24 h at this pace
  const far = fc(dir, { caps: { dailyUsd: 0, sessionUsd: 500, perProviderDailyUsd: {} } }).caps[0];
  assert.equal(far.state, 'not-at-this-pace');
  // an explicit session id wins, and a session with no recent calls is suppressed
  const other = fc(dir, { sessionId: 'old', caps: { dailyUsd: 0, sessionUsd: 15, perProviderDailyUsd: {} } }).caps[0];
  assert.equal(other.sessionId, 'old'); assert.equal(other.spentUsd, 9); assert.equal(other.state, 'suppressed');
  // sessionUsd 0: no entry and the whole history is not even read
  const off = fc(dir, { caps: { dailyUsd: 0, sessionUsd: 0, perProviderDailyUsd: {} } });
  assert.deepEqual(off.caps, []);
  const none = fc(mk(), { caps: { dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: { x: 0 } } });
  assert.deepEqual(none.caps.map((c) => c.which), ['daily'], 'no session in use, a provider cap of 0: only the daily cap');
});

test('plans: runs out before the reset, not before the reset, exhausted, suppressed', () => {
  const plans = (inc) => ({ ollama: { name: 'Pro', includedUsd: inc, resetsOnDay: 20 } });
  const cr = (dir, minAgo, api, extra = {}) => row(dir, minAgo, { provider: 'ollama', billing: 'credits', usd: 0, api, ...extra });
  // runs out: remaining 1.8, pace 1.2 $/h
  let dir = mk(); _resetLedgerCache();
  cr(dir, 10 * 24 * 60, 7);
  for (let i = 0; i < 60; i++) cr(dir, i + 0.5, 0.02);
  let p = fc(dir, { plans: plans(10) }).plans[0];
  assert.equal(p.state, 'runs-out');
  near(p.remainingUsd, 1.8, 1e-6, 'remaining');
  near(p.runsOutAt, NOW + (1.8 / 1.2) * 3600e3, 10 * MIN, 'runs out in ~1.5 h');
  assert.ok(p.range.earliestAt <= p.range.latestAt);
  assert.equal(p.provider, 'ollama'); assert.equal(p.resetsAt, new Date(Date.UTC(2026, 10, 20)).toISOString());
  // not before the reset
  p = fc(dir, { plans: plans(1000) }).plans[0];
  assert.equal(p.state, 'not-before-reset'); assert.equal(p.runsOutAt, null);
  // exhausted (needs no pace)
  dir = mk(); _resetLedgerCache();
  cr(dir, 100, 11);
  p = fc(dir, { plans: plans(10) }).plans[0];
  assert.equal(p.state, 'exhausted'); assert.equal(p.remainingUsd, 0);
  // suppressed: two calls
  dir = mk(); _resetLedgerCache();
  cr(dir, 1, 0.1); cr(dir, 2, 0.1);
  p = fc(dir, { plans: plans(10) }).plans[0];
  assert.equal(p.state, 'suppressed'); assert.match(p.reason, /fewer than 3 metered calls for ollama in the last 15 min \(2\)/);
  assert.equal(p.ratePerHour, null);
  assert.deepEqual(fc(dir).plans, [], 'only configured plans are listed');
});

test('plans: the UTC cycle boundary matches planStatus (rows before the reset do not count)', () => {
  const now = Date.UTC(2026, 10, 20, 0, 30);
  const dir = mk(); _resetLedgerCache();
  const at = (ms, api) => appendSpend(dir, { ts: new Date(ms).toISOString(), sessionId: 's1', provider: 'ollama', model: 'm', usd: 0, apiEquivUsd: api, billing: 'credits', priceSource: 'litellm' });
  at(Date.UTC(2026, 10, 19, 23, 55), 5);                  // previous cycle
  for (const m of [20, 24, 28]) at(Date.UTC(2026, 10, 20, 0, m), 0.3);
  const plans = { ollama: { name: 'Pro', includedUsd: 10, resetsOnDay: 20 } };
  const p = spendForecast(dir, { now, caps: CAPS, plans }).plans[0];
  const st = planStatus(dir, plans, now)[0];
  assert.equal(p.remainingUsd, st.remainingUsd);
  near(p.remainingUsd, 10 - 0.9, 1e-6, 'only post-reset rows');
  assert.equal(p.resetsAt, st.resetsAt);
  assert.equal(p.resetsAt, new Date(Date.UTC(2026, 11, 20)).toISOString());
});

test('an incomplete or unreadable ledger read gives complete:false and no estimates', () => {
  const dir = mk(); _resetLedgerCache();
  steady(dir, 20);
  const partial = (s) => ({ ...s, complete: false });
  const real = fc(dir);
  assert.equal(real.complete, true);
  const r = spendForecast(dir, { now: NOW, caps: CAPS, plans: { ollama: { name: 'P', includedUsd: 1, resetsOnDay: 1 } }, summarizeFn: (d, o) => partial({ since: o.since, totals: { usd: 1, calls: 5 }, byProvider: {}, bySession: {}, complete: true }) });
  assert.equal(r.complete, false);
  assert.equal(r.charged, null); assert.deepEqual(r.caps, []); assert.deepEqual(r.plans, []); assert.equal(r.apiValue, null);
  assert.match(r.reason, /could not be read in full/);
  const u = spendForecast(dir, { now: NOW, caps: CAPS, summarizeFn: () => ({ totals: { usd: 0 }, byProvider: {}, bySession: {}, complete: false, unreadable: true }) });
  assert.equal(u.complete, false);
  // a real unreadable ledger file
  const bad = mk(); _resetLedgerCache();
  steady(bad, 5);
  const f = path.join(bad, 'spend.jsonl');
  fs.chmodSync(f, 0o000);
  try {
    if (process.getuid && process.getuid() !== 0) {
      const x = fc(bad);
      assert.equal(x.complete, false); assert.equal(x.charged, null);
    }
  } finally { fs.chmodSync(f, 0o600); }
});

test('the report carries estimate:true and the inputs it used; JSON round-trips', () => {
  const dir = mk(); _resetLedgerCache();
  steady(dir, 30);
  const rep = buildForecast({ dataDir: dir, caps: CAPS, plans: {}, now: NOW });
  assert.equal(rep.estimate, true);
  assert.equal(rep.generatedAt, NOW);
  assert.equal(rep.spend.estimate, true);
  assert.equal(rep.spend.minCalls, 3);
  assert.deepEqual(rep.spend.windowsMin, [15, 60]);
  assert.equal(typeof rep.spend.charged.calls15, 'number');
  assert.equal(rep.spend.complete, true);
  assert.deepEqual(JSON.parse(JSON.stringify(rep)), rep);
  const hostile = JSON.stringify(rep);
  assert.ok(!/\/Users|sk-|@/.test(hostile), 'no path, key or address in the payload');
});

test('buildForecast includes plan, read from <dataDir>/plan-history.jsonl', () => {
  const dir = mk(); _resetLedgerCache();
  const none = buildForecast({ dataDir: dir, caps: CAPS, plans: {}, now: NOW });
  assert.equal(none.plan.estimate, true);
  assert.equal(none.plan.lastReadingAt, null);
  assert.equal(none.plan.windows.fiveHour.status, 'none');
  for (const [i, m] of [120, 96, 72, 48, 24, 0].entries()) appendReading(dir, { v: 1, window: 'fiveHour', percent: 10 + 8 * i, resetsAt: new Date(NOW + 180 * MIN).toISOString(), fetchedAt: NOW - m * MIN });
  const rep = buildForecast({ dataDir: dir, caps: CAPS, plans: {}, now: NOW });
  assert.equal(rep.plan.lastReadingAt, NOW);
  assert.equal(rep.plan.ageMs, 0);
  assert.equal(rep.plan.windows.fiveHour.status, 'limit');
  assert.equal(rep.plan.windows.fiveHour.readings, 3, 'the recent stretch of the window is fitted');
  assert.equal(rep.plan.windows.fiveHour.windowReadings, 6);
  assert.equal(rep.plan.windows.sevenDay.status, 'none');
  assert.equal(rep.spend.estimate, true, 'the spend part is unchanged');
  assert.deepEqual(JSON.parse(JSON.stringify(rep)), rep);
  assert.ok(!/@|sk-|token/.test(JSON.stringify(rep.plan)));
});

test('forecast numbers never feed the guard: no guard, caps, ledger or engine module imports the forecast module', () => {
  const root = path.dirname(new URL(import.meta.url).pathname);
  for (const f of ['caps.mjs', 'cost.mjs', 'ledger.mjs', 'plan-guard.mjs', 'plans.mjs', 'verify.mjs', '../host/engine.mjs']) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    assert.ok(!/forecast/i.test(fs.readFileSync(p, 'utf8')), `${f} must not reference the forecast`);
  }
});

test('without a session in use, the session cap follows the sessions that have recent charged calls, newest first, not the newest row of any kind', () => {
  const dir = mk(); _resetLedgerCache();
  const cap = { dailyUsd: 0, sessionUsd: 15, perProviderDailyUsd: {} };
  steady(dir, 20, { sessionId: 's1' });                                                        // metered, 20 calls
  for (let i = 0; i < 5; i++) row(dir, i * 0.1 + 0.05, { sessionId: 's2', billing: 'subscription', usd: 0, api: 0.5, provider: 'anthropic' }); // newest row, but never charged
  const r = fc(dir, { caps: cap });
  assert.deepEqual(r.caps.map((c) => c.sessionId), ['s1'], 'the subscription session is not the session cap');
  assert.notEqual(r.caps[0].state, 'suppressed');
  // two charged sessions: both listed, the one with the more recent charged call first
  const two = mk(); _resetLedgerCache();
  steady(two, 14, { sessionId: 's1' }, 8);                                                     // s1: calls 8-14 min ago
  steady(two, 1, { sessionId: 's3' }); row(two, 0.8, { sessionId: 's3' }); row(two, 0.9, { sessionId: 's3' }); // s3: calls within the last 2 min
  assert.deepEqual(fc(two, { caps: cap }).caps.map((c) => c.sessionId), ['s3', 's1']);
  // an explicit session in use still wins and is the only one
  assert.deepEqual(fc(two, { caps: cap, sessionId: 's1' }).caps.map((c) => c.sessionId), ['s1']);
  // nothing charged recently: the newest session of any kind is still reported (a reached cap is a fact)
  const idle = mk(); _resetLedgerCache();
  row(idle, 300, { sessionId: 'old', usd: 16 });
  const reached = fc(idle, { caps: cap }).caps[0];
  assert.equal(reached.sessionId, 'old'); assert.equal(reached.state, 'reached');
});

test('the report names a caps.json problem instead of silently using the defaults', () => {
  const dir = mk(); _resetLedgerCache();
  fs.writeFileSync(path.join(dir, 'caps.json'), '{garbage');
  const caps = loadCaps(dir);
  const rep = buildForecast({ dataDir: dir, caps, plans: {}, now: NOW });
  assert.match(rep.capsProblem, /caps\.json.*defaults used/);
  assert.equal(buildForecast({ dataDir: mk(), caps: loadCaps(mk()), plans: {}, now: NOW }).capsProblem, null);
  assert.equal(buildForecast({ dataDir: dir, caps: { dailyUsd: 1, sessionUsd: 0, perProviderDailyUsd: {} }, plans: {}, now: NOW }).capsProblem, null, 'a plain caps object has no problem');
});
