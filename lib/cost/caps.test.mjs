import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCaps, saveCaps, checkCaps, normalizeCaps, DEFAULT_CAPS } from './caps.mjs';

const mk = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-caps-')), 'hub');
const sum = ({ total = 0, prov = {}, sess = {} } = {}) => ({
  totals: { usd: total }, byProvider: Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, { usd: v }])),
  bySession: Object.fromEntries(Object.entries(sess).map(([k, v]) => [k, { usd: v }])),
});

test('defaults match the spec', () => {
  assert.deepEqual({ ...loadCaps(mk()) }, { dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50 });
});
test('load merges file over defaults; invalid fields fall back to default (never to "no limit")', () => {
  const d = mk(); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'caps.json'), JSON.stringify({ dailyUsd: 'lots', sessionUsd: 5, perProviderDailyUsd: { google: 10, xai: -1 }, warnPct: 150 }));
  const c = loadCaps(d);
  assert.equal(c.dailyUsd, 40); assert.equal(c.sessionUsd, 5); assert.deepEqual(c.perProviderDailyUsd, { google: 10 }); assert.equal(c.warnPct, 50);
  assert.equal(c.warnings.length, 3);
  fs.writeFileSync(path.join(d, 'caps.json'), '{nope');
  assert.equal(loadCaps(d).dailyUsd, 40);
});
test('saveCaps writes 0600 and round-trips', () => {
  const d = mk(); saveCaps(d, { dailyUsd: 7 });
  assert.equal(fs.statSync(path.join(d, 'caps.json')).mode & 0o777, 0o600);
  assert.equal(loadCaps(d).dailyUsd, 7);
});
test('block ONLY for metered billing', () => {
  const s = sum({ total: 999, sess: { a: 999 } });
  for (const billing of ['subscription', 'free', 'local']) assert.equal(checkCaps({ summary: s, provider: 'x', sessionId: 'a', billing, caps: DEFAULT_CAPS }).action, 'ok');
  assert.equal(checkCaps({ summary: s, provider: 'x', sessionId: 'a', billing: 'metered', caps: DEFAULT_CAPS }).action, 'block');
});
test('session cap blocks first, then provider-daily, then daily', () => {
  const caps = { ...DEFAULT_CAPS, perProviderDailyUsd: { google: 10 } };
  let r = checkCaps({ summary: sum({ total: 100, prov: { google: 50 }, sess: { a: 15 } }), provider: 'google', sessionId: 'a', billing: 'metered', caps });
  assert.equal(r.action, 'block'); assert.equal(r.which, 'session'); assert.match(r.reason, /per-session cap \$15/); assert.equal(r.pct, 100);
  r = checkCaps({ summary: sum({ total: 5, prov: { google: 10 }, sess: { a: 1 } }), provider: 'google', sessionId: 'a', billing: 'metered', caps });
  assert.equal(r.which, 'provider-daily');
  r = checkCaps({ summary: sum({ total: 40, sess: { a: 1 } }), provider: 'google', sessionId: 'a', billing: 'metered', caps });
  assert.equal(r.which, 'daily');
});
test('warn at warnPct, ok below; pct reports the highest cap usage', () => {
  let r = checkCaps({ summary: sum({ total: 20, sess: { a: 1 } }), provider: 'g', sessionId: 'a', billing: 'metered', caps: DEFAULT_CAPS });
  assert.equal(r.action, 'warn'); assert.equal(r.pct, 50); assert.equal(r.which, 'daily');
  r = checkCaps({ summary: sum({ total: 19.99, sess: { a: 1 } }), provider: 'g', sessionId: 'a', billing: 'metered', caps: DEFAULT_CAPS });
  assert.equal(r.action, 'ok'); assert.equal(r.pct, 49);
});
test('cap of 0 means off; unknown session counts 0', () => {
  const r = checkCaps({ summary: sum({ total: 1e6, sess: { a: 1e6 } }), provider: 'g', sessionId: 'a', billing: 'metered', caps: { dailyUsd: 0, sessionUsd: 0, perProviderDailyUsd: {}, warnPct: 50 } });
  assert.equal(r.action, 'ok');
  assert.equal(checkCaps({ summary: sum(), provider: 'g', sessionId: 'zz', billing: 'metered', caps: DEFAULT_CAPS }).action, 'ok');
});
test('session spend can come from a wider sessionSummary', () => {
  const r = checkCaps({ summary: sum({ total: 1, sess: { a: 1 } }), sessionSummary: sum({ sess: { a: 16 } }), provider: 'g', sessionId: 'a', billing: 'metered', caps: DEFAULT_CAPS });
  assert.equal(r.action, 'block');
});
test('unpriced metered model warns (spend is invisible) but does not block', () => {
  const r = checkCaps({ summary: sum(), provider: 'g', sessionId: 'a', billing: 'metered', caps: DEFAULT_CAPS, priced: false });
  assert.equal(r.action, 'warn'); assert.equal(r.which, 'unpriced');
});
test('normalizeCaps on non-object', () => { assert.equal(normalizeCaps([1]).warnings.length, 1); });
test('unpriced metered model BLOCKS when its provider has a daily cap (spend cannot be counted)', () => {
  const caps = { ...DEFAULT_CAPS, perProviderDailyUsd: { ollama: 5 } };
  const r = checkCaps({ summary: sum(), provider: 'ollama', sessionId: 'a', billing: 'metered', caps, priced: false });
  assert.equal(r.action, 'block'); assert.equal(r.which, 'unpriced-capped');
  const other = checkCaps({ summary: sum(), provider: 'google', sessionId: 'a', billing: 'metered', caps, priced: false });
  assert.equal(other.action, 'warn');
  const sub = checkCaps({ summary: sum(), provider: 'ollama', sessionId: 'a', billing: 'subscription', caps, priced: false });
  assert.equal(sub.action, 'ok');
});
