// lib/plan-history.mjs — <dataDir>/plan-history.jsonl: percent / resetsAt / fetchedAt per Claude plan window, nothing else.
// No identity, token, organisation or label ever reaches the file: every row is rebuilt from five validated values.
// The forecast read from it is an ESTIMATE: it is never consulted by the guard, the caps or the plan guard.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, secureDir } from './paths.mjs';
import { FIVE_HOUR_MS } from './plan-usage.mjs';

export const HISTORY_FILE = 'plan-history.jsonl';
export const TRIM_MARKER = 'plan-history.trimmed';
export const WINDOW_MS = Object.freeze({ fiveHour: FIVE_HOUR_MS, sevenDay: 7 * 24 * 3600e3 });
export const KEEP_MS = 14 * 24 * 3600e3;
export const KEEP_ROWS = 5000;
export const MIN_SPACING_MS = 5 * 60e3;
export const TRIM_EVERY_MS = 24 * 3600e3;
export const MIN_READINGS = 3;
export const MIN_SPAN_MS = 5 * 60e3;
export const RECENT_FRACTION = 0.2;
export const MAX_AGE_MS = 20 * 60e3;
export const RESET_TOLERANCE_MS = 60e3;
const SAME_RESET_MS = 1000; // resets_at noise below this is the same window (and the same reading)
const DEDUPE_MS = 30e3;
const READ_TAIL_BYTES = 2 * 1024 * 1024;
const FUTURE_SLACK_MS = 5 * 60e3;
const H = 3600e3;
export const historyPath = (dataDir) => path.join(dataDir, HISTORY_FILE);
const sameReset = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_RESET_MS;

/** The ONLY place a row is built: five keys, each rebuilt from a validated value. null when anything is off. */
export function cleanReading(window, win, fetchedAt) {
  if (typeof window !== 'string' || !Object.hasOwn(WINDOW_MS, window) || !win || typeof win !== 'object') return null;
  const { percent, resetsAt } = win;
  const t = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 || !Number.isFinite(t)) return null;
  if (!Number.isInteger(fetchedAt) || fetchedAt <= 0) return null;
  return { v: 1, window, percent, resetsAt: new Date(t).toISOString(), fetchedAt };
}

/** One O_APPEND write of "\n{json}\n" (a torn neighbour never merges with this row). 0600; a symlink at the path is refused (O_NOFOLLOW). */
export function appendReading(dataDir, row) {
  secureDir(dataDir);
  const c = fs.constants;
  const fd = fs.openSync(historyPath(dataDir), c.O_WRONLY | c.O_APPEND | c.O_CREAT | c.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const buf = Buffer.from(`\n${JSON.stringify(row)}\n`, 'utf8');
    if (fs.writeSync(fd, buf, 0, buf.length) !== buf.length) throw new Error('short write to the plan history');
  } finally { fs.closeSync(fd); }
}

function parseText(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && o.v === 1) { const r = cleanReading(o.window, o, o.fetchedAt); if (r) rows.push(r); }
    } catch { /* torn or foreign line */ }
  }
  return rows;
}
const bound = (rows, now) => rows.filter((r) => r.fetchedAt >= now - KEEP_MS && r.fetchedAt <= now + FUTURE_SLACK_MS).sort((a, b) => a.fetchedAt - b.fetchedAt).slice(-KEEP_ROWS);

/** -> { file, exists, rows } (valid rows only, both bounds applied, oldest first). Reads at most the last 2 MB; a symlink is not followed. */
export function readPlanHistory(dataDir, { now = Date.now() } = {}) {
  const file = historyPath(dataDir);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - READ_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line of a tail read is partial
    return { file, exists: true, rows: bound(parseText(text), now) };
  } catch (e) {
    return { file, exists: e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR', rows: [] };
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/** Drop rows past either bound by rewriting through a temp file + rename. A failed write leaves the old file untouched.
 *  The size is re-checked right before the rename and the pass redone (up to 3 times) when another process appended meanwhile. */
export function trimPlanHistory(dataDir, { now = Date.now(), writeFile = atomicWriteFile } = {}) {
  const file = historyPath(dataDir);
  const nothing = { trimmed: false, kept: 0, dropped: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    let text, size;
    try {
      if (!fs.lstatSync(file).isFile()) return nothing; // never read through, or replace, a planted link
      size = fs.statSync(file).size; text = fs.readFileSync(file, 'utf8');
    } catch { return nothing; }
    const all = parseText(text);
    const kept = bound(all, now);
    if (kept.length === all.length) return { trimmed: false, kept: kept.length, dropped: 0 };
    let again = false;
    try { again = fs.statSync(file).size !== size; } catch { again = true; }
    if (again && attempt < 2) continue;
    writeFile(file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 0o600);
    return { trimmed: true, kept: kept.length, dropped: all.length - kept.length };
  }
  return nothing;
}

/** When the last trim ran, by any process: the epoch ms in the marker file, or -Infinity (no marker, a link, or garbage). */
function lastTrimTime(dataDir) {
  try {
    const f = path.join(dataDir, TRIM_MARKER);
    if (!fs.lstatSync(f).isFile()) return -Infinity;
    const t = Number(fs.readFileSync(f, 'utf8').trim());
    return Number.isFinite(t) && t > 0 ? t : -Infinity;
  } catch { return -Infinity; }
}
function markTrimmed(dataDir, at) {
  try {
    const f = path.join(dataDir, TRIM_MARKER);
    try { if (!fs.lstatSync(f).isFile()) return; } catch { /* absent: created below */ }
    atomicWriteFile(f, `${at}\n`, 0o600); // temp + rename: a planted link is replaced, never written through
  } catch { /* best effort: the next process trims again */ }
}

/** The reading hook's consumer. record({fetchedAt, fiveHour, sevenDay}) -> rows written; never throws. */
export function createPlanHistoryWriter({ dataDir, now = Date.now } = {}) {
  const last = new Map(); // window -> { percent, resetsAt, at }
  let lastTrimAt = -Infinity; // this process; the marker file carries the same fact across restarts and processes
  return {
    record(reading) {
      let written = 0;
      try {
        for (const w of Object.keys(WINDOW_MS)) {
          const row = cleanReading(w, reading?.[w], reading?.fetchedAt);
          if (!row) continue;
          const prev = last.get(w);
          if (prev && prev.percent === row.percent && sameReset(prev.resetsAt, row.resetsAt) && row.fetchedAt - prev.at < MIN_SPACING_MS) continue;
          appendReading(dataDir, row);
          last.set(w, { percent: row.percent, resetsAt: row.resetsAt, at: row.fetchedAt });
          written++;
        }
        if (now() - lastTrimAt >= TRIM_EVERY_MS) {
          lastTrimAt = now();
          if (lastTrimAt - lastTrimTime(dataDir) >= TRIM_EVERY_MS) { markTrimmed(dataDir, lastTrimAt); trimPlanHistory(dataDir, { now: lastTrimAt }); }
        }
      } catch { /* best effort: the plan card never depends on the history */ }
      return written;
    },
  };
}

/** Same percent and (within a second) the same resetsAt within 30 s of the previous kept row (two DSH processes logging one fetch) counts once. */
export function collapse(rows) {
  const out = [];
  for (const r of rows) {
    const p = out[out.length - 1];
    if (p && p.percent === r.percent && sameReset(p.resetsAt, r.resetsAt) && r.fetchedAt - p.fetchedAt < DEDUPE_MS) continue;
    out.push(r);
  }
  return out;
}

/**
 * Fit inside the CURRENT window only, over its RECENT stretch: the readings of the last RECENT_FRACTION of the window
 * length (60 min of a 5-hour window, 33.6 h of a weekly one), reaching back to the 3 newest readings when fewer fall in
 * it, so a burst earlier in the window stops driving the slope once usage has gone quiet. rows: readings of ONE window.
 * Least-squares slope of the whole percents. The range is the wider of two slope bounds: the +-0.5 % rounding of the
 * first and last reading, and +-2 standard errors of the fitted slope (the scatter of the readings around the line).
 * ESTIMATE: the result is a time and a range, never a limit, and nothing is extrapolated across a reset.
 */
export function fitWindow(rows, { windowMs, now }) {
  const sorted = [...rows].sort((a, b) => a.fetchedAt - b.fetchedAt);
  const latest = sorted[sorted.length - 1];
  if (!latest) return { status: 'none', readings: 0 };
  const resetMs = Date.parse(latest.resetsAt);
  const base = { resetsAt: latest.resetsAt, lastReadingAt: latest.fetchedAt, ageMs: now - latest.fetchedAt };
  if (now - latest.fetchedAt > MAX_AGE_MS) return { ...base, status: 'stale', readings: 0 };
  if (now >= resetMs) return { ...base, status: 'reset', readings: 0 };
  const startMs = resetMs - windowMs;
  const inWindow = collapse(sorted.filter((r) => r.fetchedAt >= startMs && r.fetchedAt <= resetMs && Math.abs(Date.parse(r.resetsAt) - resetMs) <= RESET_TOLERANCE_MS));
  const total = inWindow.length;
  if (latest.percent >= 100) return { ...base, status: 'at-limit', readings: total, percent: 100 };
  const recentFrom = (inWindow[total - 1]?.fetchedAt ?? latest.fetchedAt) - windowMs * RECENT_FRACTION;
  let pts = inWindow.filter((r) => r.fetchedAt >= recentFrom);
  if (pts.length < MIN_READINGS) pts = inWindow.slice(-MIN_READINGS);
  const n = pts.length;
  if (n < MIN_READINGS || pts[n - 1].fetchedAt - pts[0].fetchedAt < MIN_SPAN_MS) return { ...base, status: 'insufficient', readings: n, needed: MIN_READINGS };
  const t0 = pts[0].fetchedAt, tl = pts[n - 1].fetchedAt;
  const x = pts.map((p) => (p.fetchedAt - t0) / H), y = pts.map((p) => p.percent);
  const mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const slope = sxy / sxx, dt = (tl - t0) / H, pF = y[0], pL = y[n - 1];
  let rss = 0;
  for (let i = 0; i < n; i++) rss += (y[i] - (my + slope * (x[i] - mx))) ** 2;
  const se = Math.sqrt(rss / (n - 2) / sxx); // standard error of the slope, %/h
  const hi = Math.max(slope, ((pL + 0.5) - (pF - 0.5)) / dt, slope + 2 * se);
  const lo = Math.max(0, Math.min(slope, ((pL - 0.5) - (pF + 0.5)) / dt, slope - 2 * se));
  const eta = (level, s) => (s > 0 ? Math.max(now, tl + ((100 - Math.min(100, level)) / s) * H) : Infinity);
  const mid = eta(pL, Math.max(0, slope)), early = eta(pL + 0.5, hi), late = eta(pL - 0.5, lo);
  const common = { ...base, readings: n, windowReadings: total, percent: pL, ratePerHour: Number(Math.max(0, slope).toFixed(3)) };
  if (mid <= resetMs) return { ...common, status: 'limit', limitAt: Math.round(mid), earliestAt: Math.round(early), latestAt: late <= resetMs ? Math.round(late) : null };
  return { ...common, status: 'no-limit', earliestAt: Number.isFinite(early) ? Math.round(early) : null, mayReach: early <= resetMs };
}

/** The `plan` part of the forecast report: one fit per window plus the age of the newest reading. */
export function planForecast(dataDir, { now = Date.now() } = {}) {
  const { rows } = readPlanHistory(dataDir, { now });
  const by = (w) => rows.filter((r) => r.window === w);
  const last = rows.reduce((m, r) => Math.max(m, r.fetchedAt), 0) || null;
  return { estimate: true, lastReadingAt: last, ageMs: last === null ? null : now - last,
    windows: { fiveHour: fitWindow(by('fiveHour'), { windowMs: WINDOW_MS.fiveHour, now }), sevenDay: fitWindow(by('sevenDay'), { windowMs: WINDOW_MS.sevenDay, now }) } };
}
