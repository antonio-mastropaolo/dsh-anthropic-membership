import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCaps, saveCaps, checkCaps, normalizeCaps, DEFAULT_CAPS, readCapsFile, capsView, validateCapsChange, parseCapsAssignments, applyCapsChange, setCaps, PROVIDER_ID_RE, CAP_MAX_USD } from './caps.mjs';
import { SLUG_RE } from '../config.mjs';

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

const put = (d, text) => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'caps.json'), text); };

test('loadCaps keeps its enumerable shape; problem/exists/file are non-enumerable', () => {
  const d = mk();
  const c = loadCaps(d);
  assert.deepEqual({ ...c }, { dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50 });
  assert.deepEqual(Object.keys(c).sort(), ['dailyUsd', 'perProviderDailyUsd', 'sessionUsd', 'warnPct']);
  assert.equal(c.exists, false); assert.equal(c.problem, null); assert.equal(c.file, path.join(d, 'caps.json'));
  for (const k of ['problem', 'exists', 'file', 'warnings']) assert.equal(Object.keys(c).includes(k), false, k);
});

test('invalid JSON, non-object and unreadable files are named, not silent', () => {
  const d = mk(); put(d, '{nope');
  assert.equal(readCapsFile(d).problem, 'not valid JSON');
  const v = capsView(d);
  assert.equal(v.problem, 'caps.json invalid: not valid JSON; using defaults'); assert.equal(v.fatal, true);
  assert.equal(loadCaps(d).dailyUsd, 40);
  put(d, '[1]');
  assert.equal(readCapsFile(d).problem, 'not a JSON object'); assert.equal(capsView(d).fatal, true);
  put(d, JSON.stringify({ dailyUsd: 'lots' }));
  const f = capsView(d);
  assert.equal(f.fatal, false); assert.match(f.problem, /dailyUsd must be a number >= 0/); assert.doesNotMatch(f.problem, /caps\.json: /);
  assert.match(f.problem, /^caps\.json invalid: .*; using defaults$/);
  const e = mk(); fs.mkdirSync(path.join(e, 'caps.json'), { recursive: true });
  assert.equal(readCapsFile(e).problem, 'unreadable (EISDIR)');
  const r = applyCapsChange(e, { dailyUsd: 5 });
  assert.equal(r.ok, false); assert.ok(fs.statSync(path.join(e, 'caps.json')).isDirectory());
  assert.equal(capsView(mk()).problem, null);
});

test('validateCapsChange accepts the documented keys; provider 0 becomes removal', () => {
  const r = validateCapsChange({ dailyUsd: 40, sessionUsd: 0, warnPct: 50, 'provider.google': 5, 'provider.xai': null, 'provider.zai': 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, { dailyUsd: 40, sessionUsd: 0, warnPct: 50, 'provider.google': 5, 'provider.xai': null, 'provider.zai': null });
});

test('validateCapsChange rejects bad values and keys, never pollutes prototypes', () => {
  const rows = [
    [{ dailyUsd: NaN }, 'dailyUsd'], [{ dailyUsd: Infinity }, 'dailyUsd'], [JSON.parse('{"dailyUsd":1e999}'), 'dailyUsd'],
    [{ dailyUsd: -1 }, 'dailyUsd'], [{ sessionUsd: CAP_MAX_USD + 1 }, 'sessionUsd'], [{ dailyUsd: '40' }, 'dailyUsd'], [{ dailyUsd: true }, 'dailyUsd'],
    [{ warnPct: 0 }, 'warnPct'], [{ warnPct: 100 }, 'warnPct'], [{ warnPct: 50.5 }, 'warnPct'],
    [{ 'provider.Google': 1 }, 'provider.Google'], [{ ['provider.' + 'a'.repeat(41)]: 1 }, 'provider.'], [{ 'provider.': 1 }, 'provider.'], [{ 'provider.-x': 1 }, 'provider.-x'],
    [{ 'provider.constructor': 1 }, 'constructor'], [{ 'provider.toString': 1 }, 'toString'], [{ 'provider.__proto__': 1 }, '__proto__'],
    [{ 'provider.google': -1 }, 'provider.google'], [{ 'provider.google': 'x' }, 'provider.google'],
    [{ foo: 1 }, 'foo'], [JSON.parse('{"__proto__":{"x":1}}'), '__proto__'], [{ constructor: 1 }, 'constructor'],
    [[1], 'object'], [null, 'object'], ['x', 'object'], [{}, 'nothing'],
    [Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`provider.p${i}`, 1])), 'too many'],
  ];
  for (const [input, needle] of rows) {
    const r = validateCapsChange(input);
    assert.equal(r.ok, false, JSON.stringify(input)?.slice(0, 80));
    assert.ok(r.errors.some((m) => m.includes(needle)), `${needle} in ${r.errors}`);
    assert.equal(({}).x, undefined); assert.equal(Object.prototype.x, undefined);
  }
});

test('parseCapsAssignments maps words to the flat map and keeps bad values invalid', () => {
  const p = parseCapsAssignments(['dailyUsd=40', 'provider.google=5', 'provider.xai=off', 'warnPct=50', 'sessionUsd=off']);
  assert.equal(p.ok, true);
  assert.deepEqual({ ...p.input }, { dailyUsd: 40, 'provider.google': 5, 'provider.xai': null, warnPct: 50, sessionUsd: 0 });
  assert.equal(validateCapsChange(p.input).ok, true);
  for (const bad of ['dailyUsd=1e3', 'dailyUsd=0x10', 'dailyUsd=NaN', 'dailyUsd= 5', 'dailyUsd=', 'warnPct=off', 'dailyUsd=-1', 'dailyUsd=1e999']) {
    const q = parseCapsAssignments([bad]);
    assert.equal(q.ok && validateCapsChange(q.input).ok, false, bad);
  }
  const proto = parseCapsAssignments(['__proto__=5']);
  assert.equal(proto.ok && validateCapsChange(proto.input).ok, false);
  const pv = validateCapsChange(proto.input); assert.ok(pv.errors.some((m) => m.includes('unknown key')));
  assert.equal(Object.prototype['5'], undefined);
  assert.equal(parseCapsAssignments(['dailyUsd=1', 'dailyUsd=2']).ok, false);
  assert.equal(parseCapsAssignments(['dailyUsd']).ok, false);
  assert.equal(parseCapsAssignments([]).ok, false);
});

test('PROVIDER_ID_RE equals config.mjs SLUG_RE', () => { assert.equal(PROVIDER_ID_RE.source, SLUG_RE.source); });

test('setCaps writes exactly the caps keys, 0600, atomically; merges; removes one provider', () => {
  const d = mk();
  assert.equal(setCaps(d, { dailyUsd: 7, 'provider.google': 5, 'provider.xai': 3 }).ok, true);
  const f = path.join(d, 'caps.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600); assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { dailyUsd: 7, sessionUsd: 15, perProviderDailyUsd: { google: 5, xai: 3 }, warnPct: 50, stopAtPlanLimit: false });
  const r = setCaps(d, { 'provider.xai': 0, warnPct: 80 });
  assert.equal(r.ok, true); assert.equal(r.replaced, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { dailyUsd: 7, sessionUsd: 15, perProviderDailyUsd: { google: 5 }, warnPct: 80, stopAtPlanLimit: false });
  assert.deepEqual(r.view.caps.perProviderDailyUsd, { google: 5 });
  assert.equal(loadCaps(d).warnPct, 80);
  assert.deepEqual(fs.readdirSync(d), ['caps.json']);
  assert.equal(setCaps(d, { dailyUsd: -1 }).ok, false);
  assert.equal(loadCaps(d).dailyUsd, 7);
});

test('setCaps does not follow a symlink at caps.json', () => {
  const d = mk(); fs.mkdirSync(d, { recursive: true });
  const victim = path.join(path.dirname(d), 'victim.txt'); fs.writeFileSync(victim, 'KEEP');
  fs.symlinkSync(victim, path.join(d, 'caps.json'));
  const r = setCaps(d, { dailyUsd: 9 });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'KEEP');
  const st = fs.lstatSync(path.join(d, 'caps.json'));
  assert.equal(st.isSymbolicLink(), false); assert.equal(st.isFile(), true); assert.equal(st.mode & 0o777, 0o600);
  assert.equal(loadCaps(d).dailyUsd, 9);
});

test('setCaps does not write through a symlink planted at a temp-style name', () => {
  const d = mk(); fs.mkdirSync(d, { recursive: true });
  const victim = path.join(path.dirname(d), 'victim2.txt'); fs.writeFileSync(victim, 'KEEP');
  fs.symlinkSync(victim, path.join(d, '.caps.json.tmp'));
  fs.symlinkSync(victim, path.join(d, 'caps.json.tmp'));
  assert.equal(setCaps(d, { dailyUsd: 9 }).ok, true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'KEEP');
});

test('setCaps over an unparseable file keeps caps.json.broken and repairs; field-invalid keeps the valid fields', () => {
  const d = mk(); put(d, '{nope');
  const r = setCaps(d, { dailyUsd: 12 });
  assert.equal(r.ok, true); assert.equal(r.replaced, 'not valid JSON');
  const b = path.join(d, 'caps.json.broken');
  assert.equal(fs.readFileSync(b, 'utf8'), '{nope'); assert.equal(fs.statSync(b).mode & 0o777, 0o600);
  assert.equal(capsView(d).problem, null); assert.equal(loadCaps(d).dailyUsd, 12);
  put(d, JSON.stringify({ dailyUsd: 'lots', sessionUsd: 5 }));
  const r2 = setCaps(d, { warnPct: 70 });
  assert.equal(r2.ok, true); assert.match(r2.replaced, /dailyUsd/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'caps.json'), 'utf8')), { dailyUsd: 40, sessionUsd: 5, perProviderDailyUsd: {}, warnPct: 70, stopAtPlanLimit: false });
});

test('setCaps rejects more than 64 provider caps', () => {
  const d = mk();
  const a = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`provider.p${i}`, 1]));
  assert.equal(setCaps(d, a).ok, true);
  const b = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`provider.q${i}`, 1]));
  const r = setCaps(d, b);
  assert.equal(r.ok, false); assert.match(r.errors[0], /at most 64/);
  assert.equal(Object.keys(loadCaps(d).perProviderDailyUsd).length, 60);
});

test('normalizeCaps skips prototype-named providers', () => {
  const { caps, warnings } = normalizeCaps(JSON.parse('{"perProviderDailyUsd":{"constructor":1,"__proto__":2,"google":3}}'));
  assert.deepEqual(caps.perProviderDailyUsd, { google: 3 }); assert.equal(warnings.length, 2);
  assert.equal(Object.getPrototypeOf(caps.perProviderDailyUsd), Object.prototype);
});

test('stopAtPlanLimit round-trips through setCaps and caps words; rejects 1, "true", "maybe"; default false; the four enumerable keys are unchanged', () => {
  const d = mk();
  assert.equal(loadCaps(d).stopAtPlanLimit, false);
  assert.equal(capsView(d).stopAtPlanLimit, false);
  assert.equal(capsView(d).defaults.stopAtPlanLimit, false);
  const on = parseCapsAssignments(['stopAtPlanLimit=on']);
  assert.equal(on.ok, true); assert.equal(on.input.stopAtPlanLimit, true);
  assert.equal(parseCapsAssignments(['stopAtPlanLimit=off']).input.stopAtPlanLimit, false);
  const r = setCaps(d, on.input);
  assert.equal(r.ok, true); assert.equal(r.view.stopAtPlanLimit, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'caps.json'), 'utf8')).stopAtPlanLimit, true);
  const c = loadCaps(d);
  assert.equal(c.stopAtPlanLimit, true);
  assert.deepEqual(Object.keys(c).sort(), ['dailyUsd', 'perProviderDailyUsd', 'sessionUsd', 'warnPct']);
  assert.equal(Object.keys(c).includes('stopAtPlanLimit'), false);
  assert.equal(setCaps(d, { dailyUsd: 9 }).view.stopAtPlanLimit, true, 'other changes keep the opt-in');
  assert.equal(setCaps(d, { stopAtPlanLimit: false }).view.stopAtPlanLimit, false);
  for (const bad of [1, 0, 'true', 'maybe', null, 'on']) {
    const v = validateCapsChange({ stopAtPlanLimit: bad });
    assert.equal(v.ok, false, String(bad));
    assert.ok(v.errors.some((m) => m.includes('stopAtPlanLimit must be true or false')));
  }
  const word = parseCapsAssignments(['stopAtPlanLimit=maybe']);
  assert.equal(word.ok && validateCapsChange(word.input).ok, false);
  assert.equal(loadCaps(d).stopAtPlanLimit, false);
});

test('a non-boolean stopAtPlanLimit in caps.json keeps it off and says so; the rest of the file still applies', () => {
  const d = mk(); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'caps.json'), JSON.stringify({ dailyUsd: 7, stopAtPlanLimit: 'yes' }));
  const c = loadCaps(d);
  assert.equal(c.stopAtPlanLimit, false); assert.equal(c.dailyUsd, 7);
  assert.deepEqual(c.warnings, ['caps.json: stopAtPlanLimit must be true or false, default (off) kept']);
  assert.equal(normalizeCaps({ stopAtPlanLimit: true }).stopAtPlanLimit, true);
  assert.equal(normalizeCaps(null).stopAtPlanLimit, false);
});

test('applyCapsChange: a change another writer lands between its read and its write is merged, not overwritten', () => {
  const d = mk(); fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, 'caps.json');
  fs.writeFileSync(file, JSON.stringify({ dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50, stopAtPlanLimit: false }));
  // the "other writer" (host POST /caps) sets stopAtPlanLimit right after this writer's first read of the file
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(p, ...rest) {
    const out = realRead.call(this, p, ...rest);
    if (p === file && ++reads === 1) fs.writeFileSync(file, JSON.stringify({ dailyUsd: 40, sessionUsd: 15, perProviderDailyUsd: {}, warnPct: 50, stopAtPlanLimit: true }));
    return out;
  };
  let r;
  try { r = applyCapsChange(d, { dailyUsd: 7 }); } finally { fs.readFileSync = realRead; }
  assert.equal(r.ok, true);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.dailyUsd, 7, 'this writer\'s change is there');
  assert.equal(disk.stopAtPlanLimit, true, 'the other writer\'s toggle is not lost');
  assert.equal(r.view.stopAtPlanLimit, true);
});
