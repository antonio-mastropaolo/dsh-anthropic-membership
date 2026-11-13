import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanReading, appendReading, readPlanHistory, trimPlanHistory, createPlanHistoryWriter, collapse, fitWindow, planForecast,
  historyPath, HISTORY_FILE, TRIM_MARKER, WINDOW_MS, KEEP_ROWS, MIN_SPACING_MS, TRIM_EVERY_MS,
} from './plan-history.mjs';
import { createPlanUsageStore } from './plan-usage.mjs';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plan-history-'));
const NOW = Date.UTC(2026, 10, 12, 14, 0);
const MIN = 60e3;
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
// a stored row: minAgo minutes before NOW, resetting resetsInMin minutes after NOW
const rd = (window, minAgo, percent, resetsInMin = 180) => ({ v: 1, window, percent, resetsAt: iso(NOW + resetsInMin * MIN), fetchedAt: NOW - Math.round(minAgo * MIN) });
const put = (dir, rows) => fs.writeFileSync(historyPath(dir), rows.map((r) => `\n${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
const lines = (dir) => fs.readFileSync(historyPath(dir), 'utf8').split('\n').filter((l) => l.trim());
const FIVE = { windowMs: WINDOW_MS.fiveHour, now: NOW };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (+-${tol})`);

test('cleanReading rebuilds exactly five keys and refuses bad input', () => {
  const win = { percent: 42, resetsAt: '2026-11-12T17:00:00.000123+00:00', token: 'sk-x', label: 'secret', email: 'a@b.c', __proto__: { evil: 1 } };
  const r = cleanReading('fiveHour', win, NOW);
  assert.deepEqual(Object.keys(r).sort(), ['fetchedAt', 'percent', 'resetsAt', 'v', 'window']);
  assert.deepEqual(r, { v: 1, window: 'fiveHour', percent: 42, resetsAt: '2026-11-12T17:00:00.000Z', fetchedAt: NOW });
  const ok = { percent: 10, resetsAt: '2026-11-12T17:00:00Z' };
  for (const bad of [{ ...ok, percent: 42.5 }, { ...ok, percent: -1 }, { ...ok, percent: 101 }, { ...ok, percent: '42' }, { ...ok, resetsAt: 'garbage' }, { ...ok, resetsAt: null }, { ...ok, resetsAt: 123 }, null, 'x', undefined]) {
    assert.equal(cleanReading('fiveHour', bad, NOW), null, JSON.stringify(bad));
  }
  assert.equal(cleanReading('fiveHour', ok, 0), null);
  assert.equal(cleanReading('fiveHour', ok, 1.5), null);
  assert.equal(cleanReading('fiveHour', ok, '123'), null);
  assert.equal(cleanReading('sevenDayOpus', ok, NOW), null, 'only the two documented windows');
  assert.equal(cleanReading('__proto__', ok, NOW), null);
  assert.equal(cleanReading('fiveHour', { percent: 0, resetsAt: ok.resetsAt }, NOW).percent, 0);
  assert.equal(cleanReading('sevenDay', { percent: 100, resetsAt: ok.resetsAt }, NOW).percent, 100);
});

test('the file holds only the documented fields: secrets in the hook payload never reach it', () => {
  const dir = mk();
  const w = createPlanHistoryWriter({ dataDir: dir, now: () => NOW });
  const win = (p) => ({ percent: p, resetsAt: iso(NOW + 3 * H), label: 'secret', token: 'sk-x', email: 'me@example.com' });
  const n = w.record({ fetchedAt: NOW, fiveHour: win(12), sevenDay: win(40), scopedWeekly: { percent: 9, label: 'secret', resetsAt: iso(NOW) }, extraEnabled: true, token: 'sk-y' });
  assert.equal(n, 2);
  const ls = lines(dir);
  assert.equal(ls.length, 2);
  for (const l of ls) assert.deepEqual(Object.keys(JSON.parse(l)).sort(), ['fetchedAt', 'percent', 'resetsAt', 'v', 'window']);
  const raw = fs.readFileSync(historyPath(dir), 'utf8');
  for (const bad of ['secret', 'sk-', 'extra', 'scoped', '@', 'token', 'label']) assert.ok(!raw.includes(bad), `file must not contain ${bad}`);
});

test('rows are single O_APPEND lines, file 0600, data dir 0700; blank and torn lines are ignored', () => {
  const parent = mk();
  const dir = path.join(parent, 'fresh');
  const w = createPlanHistoryWriter({ dataDir: dir, now: () => NOW });
  w.record({ fetchedAt: NOW, fiveHour: { percent: 5, resetsAt: iso(NOW + H) }, sevenDay: { percent: 6, resetsAt: iso(NOW + 5 * H) } });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(historyPath(dir)).mode & 0o777, 0o600);
  const raw = fs.readFileSync(historyPath(dir), 'utf8');
  assert.match(raw, /^\n\{[^\n]+\}\n\n\{[^\n]+\}\n$/, 'each row is "\\n{json}\\n"');
  assert.equal(HISTORY_FILE, 'plan-history.jsonl');
  // a torn last line (half JSON, no newline) is ignored, and the next row does not merge with it
  fs.appendFileSync(historyPath(dir), '{"v":1,"window":"fiveHour","per');
  assert.equal(readPlanHistory(dir, { now: NOW }).rows.length, 2);
  w.record({ fetchedAt: NOW + MIN, fiveHour: { percent: 6, resetsAt: iso(NOW + H) } });
  const rows = readPlanHistory(dir, { now: NOW + MIN }).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[2].percent, 6);
  // a loose mode on an existing file is tightened by the next append
  fs.chmodSync(historyPath(dir), 0o644);
  appendReading(dir, rd('fiveHour', 0, 7));
  assert.equal(fs.statSync(historyPath(dir)).mode & 0o777, 0o600);
});

test('a planted symlink is not followed: nothing is written through it, and it is not read', () => {
  const dir = mk();
  const target = path.join(mk(), 'victim.txt');
  fs.writeFileSync(target, '');
  fs.symlinkSync(target, historyPath(dir));
  const w = createPlanHistoryWriter({ dataDir: dir, now: () => NOW });
  assert.equal(w.record({ fetchedAt: NOW, fiveHour: { percent: 5, resetsAt: iso(NOW + H) } }), 0);
  assert.throws(() => appendReading(dir, rd('fiveHour', 0, 5)), /ELOOP|ENOENT|EMLINK/);
  assert.equal(fs.readFileSync(target, 'utf8'), '');
  // a symlink to a file that DOES hold valid rows is not read either
  fs.writeFileSync(target, `\n${JSON.stringify(rd('fiveHour', 1, 50))}\n`);
  assert.deepEqual(readPlanHistory(dir, { now: NOW }).rows, []);
  assert.deepEqual(trimPlanHistory(dir, { now: NOW }), { trimmed: false, kept: 0, dropped: 0 });
});

test('an identical reading inside 5 minutes is not written again; a changed one is; an identical one after 5 minutes is', () => {
  const dir = mk();
  const w = createPlanHistoryWriter({ dataDir: dir, now: () => NOW });
  const rec = (at, five) => w.record({ fetchedAt: at, fiveHour: { percent: five, resetsAt: iso(NOW + 2 * H) } });
  assert.equal(rec(NOW, 10), 1);
  assert.equal(rec(NOW + MIN, 10), 0, 'identical inside 5 min');
  assert.equal(rec(NOW + 2 * MIN, 11), 1, 'changed percent');
  assert.equal(rec(NOW + 3 * MIN, 11), 0);
  assert.equal(rec(NOW + 2 * MIN + MIN_SPACING_MS, 11), 1, 'identical, 5 min after the last written row');
  assert.equal(lines(dir).length, 3);
  // a different resetsAt (a new window) is a change
  assert.equal(w.record({ fetchedAt: NOW + 8 * MIN, fiveHour: { percent: 11, resetsAt: iso(NOW + 9 * H) } }), 1);
});

test('trim keeps the newest 5000 rows, drops rows older than 14 days, and a no-op does not rewrite', () => {
  const dir = mk();
  const many = [];
  for (let i = 0; i < KEEP_ROWS + 3; i++) many.push({ v: 1, window: i % 2 ? 'fiveHour' : 'sevenDay', percent: i % 100, resetsAt: iso(NOW + H), fetchedAt: NOW - (KEEP_ROWS + 3 - i) * 1000 });
  put(dir, many);
  const r = trimPlanHistory(dir, { now: NOW });
  assert.deepEqual(r, { trimmed: true, kept: KEEP_ROWS, dropped: 3 });
  const kept = readPlanHistory(dir, { now: NOW }).rows;
  assert.equal(kept.length, KEEP_ROWS);
  assert.equal(kept[0].fetchedAt, many[3].fetchedAt);
  assert.equal(kept[kept.length - 1].fetchedAt, many[many.length - 1].fetchedAt);
  assert.equal(fs.statSync(historyPath(dir)).mode & 0o777, 0o600);
  // age bound
  put(dir, [rd('fiveHour', 15 * 24 * 60, 10), rd('fiveHour', 13 * 24 * 60, 11), rd('fiveHour', 5, 12)]);
  assert.deepEqual(trimPlanHistory(dir, { now: NOW }), { trimmed: true, kept: 2, dropped: 1 });
  assert.deepEqual(readPlanHistory(dir, { now: NOW }).rows.map((x) => x.percent), [11, 12]);
  // a no-op leaves the same inode
  const ino = fs.statSync(historyPath(dir)).ino;
  assert.equal(trimPlanHistory(dir, { now: NOW }).trimmed, false);
  assert.equal(fs.statSync(historyPath(dir)).ino, ino);
  assert.equal(trimPlanHistory(mk(), { now: NOW }).trimmed, false, 'no file');
});

test('trim cannot lose the file on a crash: the original stays byte-identical and no temp file is left', () => {
  const dir = mk();
  put(dir, [rd('fiveHour', 15 * 24 * 60, 10), rd('fiveHour', 5, 12)]);
  const before = fs.readFileSync(historyPath(dir));
  assert.throws(() => trimPlanHistory(dir, { now: NOW, writeFile: () => { throw new Error('disk full'); } }), /disk full/);
  assert.ok(fs.readFileSync(historyPath(dir)).equals(before));
  assert.deepEqual(fs.readdirSync(dir), [HISTORY_FILE]);
  // the real atomic write leaves 0600 and no temp
  const r = trimPlanHistory(dir, { now: NOW });
  assert.equal(r.trimmed, true);
  assert.equal(fs.statSync(historyPath(dir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [HISTORY_FILE]);
});

test('trim redoes the pass when another process appended meanwhile (size re-check before the rename)', () => {
  const dir = mk();
  put(dir, [rd('fiveHour', 15 * 24 * 60, 10), rd('fiveHour', 5, 12)]);
  let appended = false;
  const writeFile = (file, text, mode) => {
    // runs right before the rename: the size re-check has already happened, so a late append here is the documented residual window
    fs.writeFileSync(file, text, { mode });
  };
  // simulate an append between the first read and the re-check by appending when the old row is first parsed
  const origRead = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    const out = origRead.call(this, p, ...rest);
    if (!appended && String(p) === historyPath(dir)) { appended = true; fs.appendFileSync(p, `\n${JSON.stringify(rd('fiveHour', 1, 77))}\n`); }
    return out;
  };
  try {
    const r = trimPlanHistory(dir, { now: NOW, writeFile });
    assert.equal(r.trimmed, true);
  } finally { fs.readFileSync = origRead; }
  assert.deepEqual(readPlanHistory(dir, { now: NOW }).rows.map((x) => x.percent), [12, 77], 'the row appended during the pass is kept');
});

test('the writer trims at most once per 24 h', () => {
  const dir = mk();
  let t = NOW;
  const w = createPlanHistoryWriter({ dataDir: dir, now: () => t });
  put(dir, [rd('fiveHour', 20 * 24 * 60, 1)]);
  const rec = (p) => w.record({ fetchedAt: t, fiveHour: { percent: p, resetsAt: iso(t + 2 * H) } });
  rec(10);
  assert.equal(readPlanHistory(dir, { now: t }).rows.length, 1, 'the first record trimmed the 20-day-old row');
  const ino = fs.statSync(historyPath(dir)).ino;
  fs.appendFileSync(historyPath(dir), `\n${JSON.stringify({ ...rd('fiveHour', 0, 2), fetchedAt: t - 15 * 24 * H })}\n`);
  t += 23 * H;
  rec(20);
  assert.equal(fs.statSync(historyPath(dir)).ino, ino, 'not trimmed again after 23 h');
  assert.ok(lines(dir).some((l) => JSON.parse(l).percent === 2), 'the old row is still in the file');
  t += H;
  assert.equal(TRIM_EVERY_MS, 24 * H);
  rec(30);
  assert.ok(!lines(dir).some((l) => JSON.parse(l).percent === 2), 'trimmed after 24 h');
});

test('readPlanHistory applies both bounds even when the file was never trimmed', () => {
  const dir = mk();
  const rows = [rd('fiveHour', 15 * 24 * 60, 1), rd('fiveHour', 60, 2), rd('fiveHour', -30, 3) /* 30 min in the future */];
  for (let i = 0; i < KEEP_ROWS + 10; i++) rows.push({ v: 1, window: 'sevenDay', percent: 50, resetsAt: iso(NOW + H), fetchedAt: NOW - 3 * H - i * 1000 });
  put(dir, rows);
  const r = readPlanHistory(dir, { now: NOW });
  assert.equal(r.exists, true);
  assert.ok(r.rows.length <= KEEP_ROWS);
  assert.ok(!r.rows.some((x) => x.percent === 1 || x.percent === 3), 'older than 14 days and from the future are dropped');
  assert.ok(r.rows.every((x, i, a) => i === 0 || a[i - 1].fetchedAt <= x.fetchedAt), 'oldest first');
  assert.equal(readPlanHistory(mk(), { now: NOW }).exists, false);
});

test('a 10 MB file of garbage lines reads without trouble and yields only the valid rows', () => {
  const dir = mk();
  const junk = '{"v":1,"window":"fiveHour","percent":"x"}\nnot json at all \u0000\u0001\n[1,2,3]\n{"v":2}\n'.repeat(140000);
  assert.ok(junk.length > 10e6);
  fs.writeFileSync(historyPath(dir), junk + `\n${JSON.stringify(rd('fiveHour', 2, 33))}\n`);
  const r = readPlanHistory(dir, { now: NOW });
  assert.deepEqual(r.rows.map((x) => x.percent), [33]);
});

test('fitWindow: a flat window never reaches 100% before the reset', () => {
  const rows = [120, 96, 72, 48, 24, 0].map((m) => rd('fiveHour', m, 40));
  const f = fitWindow(rows, FIVE);
  assert.equal(f.status, 'no-limit');
  assert.equal(f.mayReach, false);
  assert.equal(f.readings, 3, 'the recent stretch (last fifth of the window) is fitted');
  assert.equal(f.windowReadings, 6);
  assert.equal(f.ratePerHour, 0);
  assert.equal(f.percent, 40);
});

test('fitWindow: a steep window gives a limit time and a range around it', () => {
  const rows = [120, 96, 72, 48, 24, 0].map((m, i) => rd('fiveHour', m, 10 + 8 * i));
  const f = fitWindow(rows, FIVE);
  assert.equal(f.status, 'limit');
  assert.equal(f.readings, 3);
  assert.equal(f.windowReadings, 6);
  near(f.limitAt - f.lastReadingAt, 2.5 * H, MIN, 'limit 2.5 h after the last reading');
  assert.ok(f.earliestAt < f.limitAt && f.limitAt < f.latestAt, `${f.earliestAt} < ${f.limitAt} < ${f.latestAt}`);
  near(f.ratePerHour, 20, 0.1, 'rate');
  assert.equal(f.lastReadingAt, NOW);
  assert.equal(f.ageMs, 0);
  assert.equal(f.resetsAt, iso(NOW + 180 * MIN));
});

test('fitWindow: a limit after the reset is no-limit; the hedge says when the fastest pace could get there', () => {
  const slow = [120, 96, 72, 48, 24, 0].map((m, i) => rd('fiveHour', m, 10 + 6 * i)); // 15 %/h: 100% at +4 h, reset at +3 h
  const f = fitWindow(slow, FIVE);
  assert.equal(f.status, 'no-limit');
  assert.equal(f.mayReach, false);
  assert.equal(f.limitAt, undefined);
  // the reset 3.9 h away (7-day window so the 5-hour start does not cut the readings): the middle estimate misses it, the fast bound does not
  const edge = [120, 96, 72, 48, 24, 0].map((m, i) => rd('sevenDay', m, 10 + 6 * i, 234));
  const g = fitWindow(edge, { windowMs: WINDOW_MS.sevenDay, now: NOW });
  assert.equal(g.status, 'no-limit');
  assert.equal(g.mayReach, true);
  assert.ok(g.earliestAt < Date.parse(g.resetsAt));
});

test('fitWindow: a reset in the middle uses only the new window', () => {
  const R1 = -60, R2 = 240;
  const old = [200, 150, 100, 70].map((m, i) => rd('fiveHour', m, 90 + 2 * i, R1));
  const fresh = [50, 25, 0].map((m, i) => rd('fiveHour', m, 2 + i, R2));
  const f = fitWindow([...old, ...fresh], FIVE);
  assert.equal(f.readings, 3);
  assert.notEqual(f.status, 'limit');
  assert.equal(f.status, 'no-limit');
  assert.equal(f.percent, 4);
  // the old rows alone would have said otherwise: they are not smuggled in
  assert.ok(f.ratePerHour < 5, `rate ${f.ratePerHour}`);
});

test('fitWindow: now past the reset is "reset", never extrapolated', () => {
  const rows = [30, 20, 10].map((m, i) => rd('fiveHour', m, 80 + 5 * i, -1));
  const f = fitWindow(rows, FIVE);
  assert.equal(f.status, 'reset');
  assert.equal(f.limitAt, undefined);
  assert.equal(f.earliestAt, undefined);
});

test('fitWindow: fewer than 3 readings, or 3 readings spanning under 5 minutes, is "insufficient" with the count', () => {
  const two = fitWindow([rd('fiveHour', 20, 10), rd('fiveHour', 0, 30)], FIVE);
  assert.equal(two.status, 'insufficient');
  assert.equal(two.readings, 2);
  assert.equal(two.needed, 3);
  const one = fitWindow([rd('fiveHour', 0, 10)], FIVE);
  assert.deepEqual([one.status, one.readings], ['insufficient', 1]);
  const short = fitWindow([rd('fiveHour', 4, 10), rd('fiveHour', 2, 11), rd('fiveHour', 0, 12)], FIVE);
  assert.equal(short.status, 'insufficient');
  assert.equal(short.readings, 3);
});

test('fitWindow: resolution edges', () => {
  // 40, 40, 41 over 10 minutes against a far reset: the slowest bound is flat, so there is no latest time
  const far = (m, p) => rd('sevenDay', m, p, 6 * 24 * 60);
  const f = fitWindow([far(10, 40), far(5, 40), far(0, 41)], { windowMs: WINDOW_MS.sevenDay, now: NOW });
  assert.equal(f.status, 'limit');
  assert.equal(f.latestAt, null);
  assert.ok(f.earliestAt < f.limitAt);
  // reaching the limit
  const at = fitWindow([rd('fiveHour', 10, 99), rd('fiveHour', 5, 99), rd('fiveHour', 0, 100)], FIVE);
  assert.equal(at.status, 'at-limit');
  assert.equal(at.percent, 100);
  // a start at 0%
  const zero = fitWindow([rd('fiveHour', 60, 0), rd('fiveHour', 30, 0), rd('fiveHour', 0, 1)], FIVE);
  assert.ok(['no-limit', 'limit'].includes(zero.status));
  // 97, 98, 99: the fast bound is already past, so it is clamped to now
  const near100 = fitWindow([rd('fiveHour', 12, 97), rd('fiveHour', 7, 98), rd('fiveHour', 2, 99)], FIVE);
  assert.equal(near100.status, 'limit');
  assert.ok(near100.earliestAt >= NOW, 'never a time in the past');
  assert.ok(near100.earliestAt <= near100.limitAt);
  assert.ok(near100.limitAt >= NOW);
});

test('fitWindow: a newest reading older than 20 minutes is "stale"; no rows is "none"', () => {
  const rows = [60, 40, 21].map((m, i) => rd('fiveHour', m, 10 + i));
  const f = fitWindow(rows, FIVE);
  assert.equal(f.status, 'stale');
  assert.equal(f.ageMs, 21 * MIN);
  assert.equal(f.limitAt, undefined);
  assert.notEqual(fitWindow([60, 40, 19].map((m, i) => rd('fiveHour', m, 10 + i)), FIVE).status, 'stale');
  assert.deepEqual(fitWindow([], FIVE), { status: 'none', readings: 0 });
});

test('readings 60 s apart with resetsAt noise (<= 1 s) form one window; a different resetsAt (> 60 s) does not', () => {
  const noisy = (m, p, jitterMs) => ({ ...rd('fiveHour', m, p), resetsAt: iso(NOW + 180 * MIN + jitterMs) });
  const rows = [10, 9, 8, 7, 6, 5, 4].map((m, i) => noisy(m, 10 + i * 2, (i % 3) * 400));
  const f = fitWindow(rows, FIVE);
  assert.equal(f.readings, 7);
  const other = [...rows, { ...noisy(3, 40, 0), resetsAt: iso(NOW + 180 * MIN + 61e3) }];
  const g = fitWindow(other, FIVE);
  assert.equal(g.readings, 1, 'only the newest window counts');
  assert.equal(g.status, 'insufficient');
});

test('collapse: two processes logging the same fetch seconds apart count once', () => {
  const a = rd('fiveHour', 10, 20), b = { ...a, fetchedAt: a.fetchedAt + 5000 }, c = { ...a, fetchedAt: a.fetchedAt + 45000 };
  const jit = { ...a, fetchedAt: a.fetchedAt + 7000, resetsAt: iso(Date.parse(a.resetsAt) + 300) };
  assert.equal(collapse([a, b]).length, 1);
  assert.equal(collapse([a, jit]).length, 1, 'sub-second resetsAt noise still collapses');
  assert.equal(collapse([a, c]).length, 2, '45 s apart are two readings');
  assert.equal(collapse([a, { ...b, percent: 21 }]).length, 2);
});

test('planForecast: both windows, lastReadingAt and ageMs; no file -> all "none"', () => {
  const dir = mk();
  const none = planForecast(dir, { now: NOW });
  assert.deepEqual(none, { estimate: true, lastReadingAt: null, ageMs: null, windows: { fiveHour: { status: 'none', readings: 0 }, sevenDay: { status: 'none', readings: 0 } } });
  const rows = [...[120, 96, 72, 48, 24, 3].map((m, i) => rd('fiveHour', m, 10 + 8 * i)), ...[50, 25, 4].map((m, i) => rd('sevenDay', m, 30, 5 * 24 * 60))];
  put(dir, rows);
  const f = planForecast(dir, { now: NOW });
  assert.equal(f.estimate, true);
  assert.equal(f.lastReadingAt, NOW - 3 * MIN);
  assert.equal(f.ageMs, 3 * MIN);
  assert.equal(f.windows.fiveHour.status, 'limit');
  assert.equal(f.windows.sevenDay.status, 'no-limit');
  assert.deepEqual(JSON.parse(JSON.stringify(f)), f);
});

test('the hook: onReading is called once per successful fetch, not for a cached read or a 429, and a throwing hook does not break read()', async () => {
  let t = 1_000_000, status = 200;
  const seen = [];
  const data = { five_hour: { utilization: 41.6, resets_at: '2026-11-12T17:00:00.000123+00:00' }, seven_day: { utilization: 7, resets_at: '2026-11-17T14:00:00+00:00' }, extra_usage: { is_enabled: true } };
  let throwing = false;
  const store = createPlanUsageStore({
    now: () => t, getToken: () => 'tok-secret',
    fetchUsage: async () => (status === 200 ? { ok: true, status: 200, data } : { ok: false, status, data: null }),
    countWindow: async () => ({ messages: 1, modelCalls: 2 }),
    onReading: (r) => { seen.push(r); if (throwing) throw new Error('hook boom'); },
  });
  const a = await store.read();
  assert.equal(a.mode, 'plan');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fetchedAt, 1_000_000);
  assert.deepEqual(seen[0].fiveHour, { percent: 42, resetsAt: '2026-11-12T17:00:00.000123+00:00' });
  assert.deepEqual(seen[0].sevenDay, { percent: 7, resetsAt: '2026-11-17T14:00:00+00:00' });
  await store.read();
  assert.equal(seen.length, 1, 'a cached read is not a reading');
  t += 61_000; throwing = true;
  const b = await store.read();
  assert.equal(b.mode, 'plan', 'a throwing hook does not break read()');
  assert.equal(seen.length, 2);
  t += 61_000; status = 429;
  const c = await store.read();
  assert.equal(c.mode, 'unavailable');
  assert.equal(seen.length, 2, 'a 429 is not a reading');
  t += 400_000; status = 200; throwing = false;
  await store.read();
  assert.equal(seen.length, 3);
  // no hook at all is the default
  const plain = createPlanUsageStore({ now: () => t, getToken: () => 'x', fetchUsage: async () => ({ ok: true, status: 200, data }) });
  assert.equal((await plain.read()).mode, 'plan');
});

test('fitWindow: a burst an hour ago followed by an idle hour does not keep predicting a limit, and the range is not falsely tight', () => {
  // 0 % -> 40 % over the first 20 minutes, then flat at 60 % for the last hour (reset 3 h out)
  const rows = [rd('fiveHour', 120, 0), rd('fiveHour', 100, 40), rd('fiveHour', 60, 60), rd('fiveHour', 40, 60), rd('fiveHour', 20, 60), rd('fiveHour', 0, 60)];
  const f = fitWindow(rows, FIVE);
  assert.equal(f.status, 'no-limit', JSON.stringify(f));
  assert.equal(f.ratePerHour, 0);
  assert.equal(f.readings, 4, 'only the recent stretch (the last fifth of the window) is fitted');
});

test('fitWindow: the range widens with the scatter of the readings, not only with the 0.5 % rounding', () => {
  const clean = fitWindow([10, 20, 30, 40, 50, 60].map((p, i) => rd('fiveHour', 50 - 10 * i, p)), FIVE);
  const noisy = fitWindow([10, 26, 28, 44, 46, 60].map((p, i) => rd('fiveHour', 50 - 10 * i, p)), FIVE);
  assert.equal(clean.status, 'limit', JSON.stringify(clean));
  assert.equal(noisy.status, 'limit', JSON.stringify(noisy));
  assert.ok(clean.limitAt - clean.earliestAt <= 3 * MIN && clean.latestAt - clean.limitAt <= 3 * MIN, 'a perfect line keeps the rounding-only range');
  assert.ok(noisy.limitAt - noisy.earliestAt >= 6 * MIN, `noisy early end ${(noisy.limitAt - noisy.earliestAt) / MIN} min`);
  assert.ok(noisy.latestAt === null || noisy.latestAt - noisy.limitAt >= 6 * MIN, `noisy late end ${(noisy.latestAt - noisy.limitAt) / MIN} min`);
});

test('fitWindow: sparse readings still forecast (the fit reaches back to the 3 newest readings)', () => {
  const sparse = [rd('sevenDay', 4000, 10, 5000), rd('sevenDay', 3000, 20, 5000), rd('sevenDay', 0, 30, 5000)];
  const f = fitWindow(sparse, { windowMs: WINDOW_MS.sevenDay, now: NOW });
  assert.notEqual(f.status, 'insufficient', JSON.stringify(f));
  assert.equal(f.readings, 3);
});

test('the trim time is persisted: a restarted process (a new writer) does not trim again inside 24 h', () => {
  const dir = mk();
  let t = NOW;
  const rec = (w, p) => w.record({ fetchedAt: t, fiveHour: { percent: p, resetsAt: iso(t + 2 * H) } });
  put(dir, [rd('fiveHour', 20 * 24 * 60, 1)]);
  rec(createPlanHistoryWriter({ dataDir: dir, now: () => t }), 10);
  assert.ok(!lines(dir).some((l) => JSON.parse(l).percent === 1), 'the first process trimmed the 20-day-old row');
  const marker = fs.readdirSync(dir).filter((f) => f !== HISTORY_FILE);
  assert.deepEqual(marker, [TRIM_MARKER], 'one small marker file, nothing else');
  assert.equal(fs.statSync(path.join(dir, TRIM_MARKER)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, TRIM_MARKER), 'utf8').trim(), String(NOW), 'holds the time of the trim only');
  fs.appendFileSync(historyPath(dir), `\n${JSON.stringify({ ...rd('fiveHour', 0, 2), fetchedAt: t - 15 * 24 * H })}\n`);
  t += 2 * H; // DSH restarted: a new writer, lastTrimAt starts empty
  rec(createPlanHistoryWriter({ dataDir: dir, now: () => t }), 20);
  assert.ok(lines(dir).some((l) => JSON.parse(l).percent === 2), 'not trimmed again 2 h later by the new process');
  t += 23 * H;
  rec(createPlanHistoryWriter({ dataDir: dir, now: () => t }), 30);
  assert.ok(!lines(dir).some((l) => JSON.parse(l).percent === 2), 'trimmed once 24 h have passed');
});

test('a garbage or planted-symlink trim marker never breaks recording', () => {
  const dir = mk();
  const target = path.join(mk(), 'victim');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(dir, TRIM_MARKER));
  const w = createPlanHistoryWriter({ dataDir: dir, now: () => NOW });
  assert.equal(w.record({ fetchedAt: NOW, fiveHour: { percent: 5, resetsAt: iso(NOW + H) } }), 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep', 'the link target is never written');
  fs.rmSync(path.join(dir, TRIM_MARKER));
  fs.writeFileSync(path.join(dir, TRIM_MARKER), 'not a number');
  const w2 = createPlanHistoryWriter({ dataDir: dir, now: () => NOW + 5 * MIN });
  assert.equal(w2.record({ fetchedAt: NOW + 5 * MIN, fiveHour: { percent: 6, resetsAt: iso(NOW + H) } }), 1);
});
