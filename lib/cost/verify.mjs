// lib/cost/verify.mjs — integrity check and export of the spend ledger. Pure functions plus the shared reader (ledger.mjs).
// Verify re-derives each v2 row's amounts from the row's own tokens, rates, tier and planCoveredUsd. It reads the RAW
// parsed values (the reader's clean() would zero an out-of-domain number and hide it). It never reads prompt or
// completion text because the ledger holds none.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { auditLedger, ledgerRows, resolveSince, KNOWN_FIELDS } from './ledger.mjs';
import { usdFromRates, TIER_THRESHOLD } from './cost.mjs';

export const VERIFY_TOLERANCE = 1e-9; // |a-b| <= 1e-9 * max(1, |a|, |b|)
export const VERIFY_NOTE = "verify proves arithmetic and file integrity (usd and apiEquivUsd re-derived from each row's own tokens, rates, tier and planCoveredUsd; ids unique; no torn lines), not that a published price was right.";
const CAP = { mismatches: 100, duplicates: 100, unknown: 50 };
const BILLINGS = new Set(['metered', 'subscription', 'free', 'local', 'credits']);
const RATE_NAMES = ['inPerM', 'outPerM', 'cacheReadPerM', 'cacheWritePerM'];
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
// a problem in one of these makes the amounts impossible to re-derive: report it and stop
const BLOCKING = new Set([...TOKEN_FIELDS, 'usd', 'apiEquivUsd', 'planCoveredUsd', 'rates', 'billing']);
const r6 = (x) => Number(x.toFixed(6));
const MAX_TEXT = 200; // a tampered row can hold any JSON: what a report quotes of it is bounded
const MAX_UNKNOWN_PER_ROW = 10;
/** A stored value as the report quotes it: numbers, booleans and null as they are, anything else cut to 200 characters. */
const quote = (v) => {
  if (v === undefined) return null;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  let t;
  try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch { t = '[unprintable]'; }
  return String(t).slice(0, MAX_TEXT);
};
const close = (a, b) => Math.abs(a - b) <= VERIFY_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));
const nonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Examine ONE raw parsed row (not through clean(): domain errors must be seen).
 *  -> { id, tsMs, v2, problems: [{ field, expected, stored }], unknown: [field names outside KNOWN_FIELDS] } */
export function examineRow(o) {
  const out = {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, MAX_TEXT) : null,
    tsMs: typeof o.ts === 'string' ? Date.parse(o.ts) : NaN,
    v2: o.v === 2,
    problems: [],
    unknown: Object.keys(o).filter((k) => !KNOWN_FIELDS.has(k)).slice(0, MAX_UNKNOWN_PER_ROW).map((k) => k.slice(0, 64)),
  };
  const bad = (field, expected, stored) => out.problems.push({ field, expected: quote(expected), stored: quote(stored) });
  if (Number.isNaN(out.tsMs)) bad('ts', 'ISO timestamp', o.ts);
  if (o.v !== undefined && o.v !== 2) bad('v', 2, o.v);
  if (o.v !== 2) return out; // a v1 row has no rates to re-derive from: counted, never a mismatch
  const tok = {};
  for (const k of TOKEN_FIELDS) {
    if (Number.isInteger(o[k]) && o[k] >= 0) tok[k] = o[k];
    else { bad(k, 'integer >= 0', o[k]); tok[k] = 0; }
  }
  for (const k of ['usd', 'apiEquivUsd', 'planCoveredUsd']) if (!nonNeg(o[k])) bad(k, 'number >= 0', o[k]);
  if (!BILLINGS.has(o.billing)) bad('billing', [...BILLINGS].join('|'), o.billing);
  let rates = null;
  if (o.rates === null) {
    // no rates is honest only where no API-equivalent price is known: an unpriced model, or a subscription model
    const unknownPrice = o.priceSource === 'unpriced' || (o.billing === 'subscription' && o.priceSource === 'subscription');
    if (!unknownPrice) bad('rates', 'rates (priced row)', null);
  } else if (o.rates && typeof o.rates === 'object' && !Array.isArray(o.rates) && RATE_NAMES.every((n) => nonNeg(o.rates[n]))) rates = o.rates;
  else bad('rates', 'four rates >= 0 or null', o.rates);
  if (o.tier !== 'base' && o.tier !== 'above200k') bad('tier', 'base|above200k', o.tier);
  else if (o.tier === 'above200k' && tok.input + tok.cacheRead + tok.cacheWrite <= TIER_THRESHOLD) bad('tier', 'base (prompt <= 200000 tokens)', o.tier);
  if (out.problems.some((p) => BLOCKING.has(p.field))) return out;
  const api = rates ? r6(usdFromRates(tok, rates)) : 0;
  if (!close(api, o.apiEquivUsd)) bad('apiEquivUsd', api, o.apiEquivUsd);
  if (o.planCoveredUsd > o.apiEquivUsd && !close(o.planCoveredUsd, o.apiEquivUsd)) bad('planCoveredUsd', `<= ${o.apiEquivUsd}`, o.planCoveredUsd);
  // Only metered and credits rows are charged against the plan: usd = apiEquivUsd - planCoveredUsd (a credits row is
  // covered in full, so it is 0). Subscription, free and local rows are charged 0 whatever their API-equivalent value.
  const usd = o.billing === 'metered' ? Math.max(0, r6(o.apiEquivUsd - o.planCoveredUsd)) : 0;
  if (!close(usd, o.usd)) bad('usd', usd, o.usd);
  if (o.billing === 'credits') { if (!close(o.planCoveredUsd, o.apiEquivUsd)) bad('planCoveredUsd', o.apiEquivUsd, o.planCoveredUsd); }
  else if (o.billing !== 'metered' && !close(o.planCoveredUsd, 0)) bad('planCoveredUsd', 0, o.planCoveredUsd);
  return out;
}

/**
 * verifyLedger(dataDir, { since, now, full }) -> { ok, since, rows, checked, v1, mismatchCount, mismatches[<=100],
 *   tornLines, duplicateCount, duplicateIds[<=100], unknownFields[<=50], complete, unreadable, note }
 * ok = no mismatch, no torn line and the read was complete. Duplicate ids and unknown fields are reported, not failed.
 * `since` limits the rows counted; torn lines cannot be dated, so they are always counted. `full: true` re-reads every
 * byte (the default only parses bytes appended since the previous check in this process).
 */
export function verifyLedger(dataDir, { since = 'all', now = Date.now(), full = false } = {}) {
  const sinceMs = resolveSince(since, now);
  const a = auditLedger(dataDir, examineRow, { reread: full });
  let rows = 0, checked = 0, v1 = 0, mismatchCount = 0;
  const mismatches = [];
  const unknown = new Set();
  for (const it of a.items) {
    if (!Number.isNaN(it.tsMs) && it.tsMs < sinceMs) continue;
    rows++;
    if (it.v2) checked++; else v1++;
    for (const k of it.unknown) if (unknown.size < CAP.unknown) unknown.add(k);
    for (const p of it.problems) {
      mismatchCount++;
      if (mismatches.length < CAP.mismatches) mismatches.push({ id: it.id, ...p });
    }
  }
  const dupIds = [...new Set(a.duplicates)];
  const ok = mismatchCount === 0 && a.torn === 0 && a.complete && !a.unreadable;
  return {
    ok, since, rows, checked, v1, mismatchCount, mismatches,
    tornLines: a.torn, duplicateCount: a.duplicates.length, duplicateIds: dupIds.slice(0, CAP.duplicates),
    unknownFields: [...unknown].sort().slice(0, CAP.unknown),
    complete: a.complete, unreadable: a.unreadable, note: VERIFY_NOTE,
  };
}

// ---- export ----
export const EXPORT_COLUMNS = ['ts', 'id', 'sessionId', 'provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'usd', 'apiEquivUsd', 'priceSource', 'billing', 'v', 'purpose', 'turn', 'step', 'parentSessionId', 'rate_inPerM', 'rate_outPerM', 'rate_cacheReadPerM', 'rate_cacheWritePerM', 'derived', 'tier', 'offPeak', 'planCoveredUsd', 'reasoning', 'finish', 'ttftMs', 'durationMs'];
const FLAT = ['ts', 'id', 'sessionId', 'provider', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'usd', 'apiEquivUsd', 'priceSource', 'billing', 'v', 'purpose', 'turn', 'step', 'parentSessionId'];
const TAIL = ['tier', 'offPeak', 'planCoveredUsd', 'reasoning', 'finish', 'ttftMs', 'durationMs'];
const FORMULA = /^[=+\-@\t\r]/;

/** One CSV cell. Absent -> empty. A text cell that a spreadsheet would run as a formula gets a leading ' and is quoted. */
function cell(v) {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join('|') : String(v);
  let force = false;
  if (typeof v === 'string' && FORMULA.test(s)) { s = `'${s}`; force = true; }
  return force || /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const val = (row, k) => (row[k] === undefined ? null : row[k]);

/** exportRows(rows, 'csv' | 'jsonl') -> text. CSV: EXPORT_COLUMNS header, one line per row ("\n" ends every line).
 *  JSONL: one object per line with the same fields in the same order, `rates` and `derived` nested; v1 rows carry null
 *  for the fields they never had. Only ledger fields are written. */
export function exportRows(rows, format) {
  if (format === 'csv') {
    const out = [EXPORT_COLUMNS.join(',')];
    for (const r of rows) {
      const flat = FLAT.map((k) => cell(val(r, k)));
      const rates = RATE_NAMES.map((n) => cell(r.rates ? r.rates[n] : null));
      const tail = [cell(val(r, 'derived')), ...TAIL.map((k) => cell(val(r, k)))];
      out.push([...flat, ...rates, ...tail].join(','));
    }
    return `${out.join('\n')}\n`;
  }
  if (format === 'jsonl') {
    return rows.map((r) => {
      const o = {};
      for (const k of FLAT) o[k] = val(r, k);
      o.rates = r.rates ? Object.fromEntries(RATE_NAMES.map((n) => [n, r.rates[n]])) : null;
      o.derived = Array.isArray(r.derived) ? [...r.derived] : null;
      for (const k of TAIL) o[k] = val(r, k);
      return JSON.stringify(o);
    }).map((l) => `${l}\n`).join('');
  }
  throw new Error(`bad export format: ${format} (csv|jsonl)`);
}

/** The ledger rows to export: since filtered, de-duplicated by id, oldest first (ties keep ledger order). */
export function readExportRows(dataDir, { since = 'all', now = Date.now() } = {}) {
  const r = ledgerRows(dataDir);
  const sinceMs = resolveSince(since, now);
  const rows = r.rows.filter((x) => Date.parse(x.ts) >= sinceMs).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { rows, complete: r.complete, unreadable: r.unreadable };
}

/** Write `text` to `file` exactly as given (no shell, no ~ expansion), mode 0600. Without `force` an existing path
 *  (file, directory or symlink, even a dangling one) is refused with code EEXIST and left untouched. With `force` the
 *  text goes to a fresh private temp file next to it that then replaces the path atomically: a symlink at the path is
 *  replaced, never written through. */
export function writeExport(file, text, { force = false } = {}) {
  if (!force) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
    return;
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    throw e;
  }
}

const LEDGER_NAME_RE = /^\.?spend\./i; // any case: on a case-insensitive filesystem SPEND.JSONL is spend.jsonl
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

/** Whether an export to `file` would touch the ledger in `dataDir`. -> 'ledger' | 'force-in-data-dir' | null.
 *  Decided by what the path IS, not only by its spelling: a name that looks like a ledger file (any case) inside the
 *  data dir, or an existing path that is the same file (device + inode) as any ledger-looking file of the data dir
 *  (so a case variant on a case-insensitive filesystem, or another name of the same file, cannot slip past).
 *  With `force` (which replaces whatever is at the path) any path inside the data dir is refused. */
export function exportTargetIsLedger(dataDir, file, { force = false } = {}) {
  const target = path.resolve(file);
  const dir = realOrNull(path.dirname(target));
  const data = realOrNull(dataDir);
  const inDataDir = dir !== null && data !== null && dir === data;
  if (inDataDir && LEDGER_NAME_RE.test(path.basename(target))) return 'ledger';
  let st = null;
  try { st = fs.lstatSync(target); } catch { /* nothing there yet */ }
  if (st) {
    let names = [];
    try { names = fs.readdirSync(dataDir).filter((f) => LEDGER_NAME_RE.test(f)); } catch { /* no data dir: no ledger */ }
    for (const f of names) {
      try {
        const l = fs.lstatSync(path.join(dataDir, f));
        if (l.dev === st.dev && l.ino === st.ino) return 'ledger';
      } catch { /* vanished */ }
    }
  }
  return force && inDataDir ? 'force-in-data-dir' : null;
}
