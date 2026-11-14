// lib/cost/external.mjs — DISPLAY-ONLY read of other spend ledgers (JSONL rows with ts, usd, optional provider),
// e.g. a metering proxy's log. Opt-in: config.json `extraLedgers` or env DSH_HUB_EXTRA_LEDGERS (comma-separated).
// Caps and the spend guard never read this; it only feeds the `external` block of GET /spend.
//
// No double counting: a call that went through DSH's own ledger AND a metering proxy (the rocco gateway forwards DSH's
// calls) is in both files. A meter row that matches a DSH row is dropped from these totals (the DSH row is the one
// that counts); a meter row nothing in DSH matches still counts here ("Outside DSH"). See DEDUPE_WINDOW_MS.
import fs from 'node:fs';
import path from 'node:path';
import { resolveSince } from './ledger.mjs';

export const EXTERNAL_SOURCE = 'meter';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const r6 = (x) => Number(x.toFixed(6));

/** A meter row and a DSH row are the same call when the model id and the output token count are equal (and > 0) and
 *  their timestamps are within this many ms. DSH stamps its row when the stream ends; the meter stamps its own row when
 *  its response ends, on the same machine's clock, so the two differ only by the relay latency and the final flush
 *  (well under a second in practice). 5 s leaves room for a slow tail without letting two different calls look alike:
 *  the key also needs the exact output token count, and each DSH row can absorb at most one meter row. The meter stamps `ts` when it
 *  records the call, after it ended, so only `ts` is compared. */
export const DEDUPE_WINDOW_MS = 5000;
const modelKey = (m) => (typeof m === 'string' ? m.trim().toLowerCase().slice(0, 200) : '');

/** Extra ledgers to show: env DSH_HUB_EXTRA_LEDGERS (comma-separated absolute paths), else config.extraLedgers, else none. */
export function externalLedgerPaths(env = process.env, config = null) {
  const v = env.DSH_HUB_EXTRA_LEDGERS;
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter((s) => path.isAbsolute(s));
  return Array.isArray(config?.extraLedgers) ? [...config.extraLedgers] : [];
}
/** @deprecated single-path form; null when nothing is configured. */
export const externalLedgerPath = (env = process.env, config = null) => externalLedgerPaths(env, config)[0] ?? null;

/**
 * @returns null when the file is missing/unreadable, else
 *   { source, totals: { usd, calls }, byProvider: { [provider]: { usd, calls } } }
 * Rows without `provider` count as "meter". Malformed lines and non-numeric usd are skipped/zeroed.
 * Only ts, provider, usd, model and output_tokens are read (the last two only to match DSH rows): session ids and other fields are never returned.
 */
// path -> { ino, offset, rows: [{ t, usd, prov, m, o }] } (m = model id, o = output tokens: matching only, never returned): each file is parsed once, then only its appended bytes
const extCache = new Map();
function parsedRows(file) {
  let st;
  try { st = fs.statSync(file); } catch { extCache.delete(file); return null; }
  let c = extCache.get(file);
  if (!c || c.ino !== st.ino || st.size < c.offset) c = { ino: st.ino, offset: 0, rows: [] };
  if (st.size > c.offset) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - c.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
      // cut at the last newline in BYTES (never measure decoded text: a torn multi-byte character would shift it)
      const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
      if (lastNl >= 0) {
        for (const line of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
          const t = Date.parse(o.ts);
          if (Number.isNaN(t)) continue;
          const usd = typeof o.usd === 'number' && Number.isFinite(o.usd) && o.usd >= 0 ? o.usd : 0;
          let prov = typeof o.provider === 'string' && o.provider ? o.provider.slice(0, 60) : 'meter';
          if (UNSAFE_KEYS.has(prov)) prov = `_${prov}`;
          const o2 = Number.isInteger(o.output_tokens) && o.output_tokens > 0 ? o.output_tokens : 0;
          c.rows.push({ t, usd, prov, m: modelKey(o.model), o: o2 });
        }
        c.offset += lastNl + 1;
      }
    } catch { if (!c.rows.length) { extCache.delete(file); return null; } }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  extCache.set(file, c);
  return c.rows;
}

/** The meter rows (of `sets`, at or after sinceMs) that a DSH ledger row already accounts for: a Set of row objects.
 *  `dshRows`: array, or a function returning one, of { ts (ms or ISO), model, output }; read only when a meter row could match. */
function matchedRows(sets, dshRows, sinceMs, windowMs) {
  const cand = [];
  for (const rows of sets) for (const r of rows) if (r.t >= sinceMs && r.m && r.o > 0) cand.push(r);
  if (!cand.length || !dshRows) return new Set();
  let list;
  try { list = typeof dshRows === 'function' ? dshRows() : dshRows; } catch { return new Set(); }
  if (!Array.isArray(list)) return new Set();
  // model|output tokens -> sorted timestamps of the DSH rows that could be the same call
  const idx = new Map();
  for (const d of list) {
    const t = typeof d?.ts === 'number' ? d.ts : Date.parse(d?.ts);
    const out = d?.output;
    const m = modelKey(d?.model);
    if (!m || !Number.isFinite(t) || !Number.isInteger(out) || out <= 0 || t < sinceMs - windowMs) continue;
    const k = `${m}|${out}`;
    (idx.get(k) || idx.set(k, []).get(k)).push(t);
  }
  for (const a of idx.values()) a.sort((x, y) => x - y);
  const used = new Map(); // key -> Set of indexes already paired with a meter row
  const hit = new Set();
  cand.sort((a, b) => a.t - b.t);
  for (const r of cand) {
    const k = `${r.m}|${r.o}`;
    const a = idx.get(k);
    if (!a) continue;
    const taken = used.get(k) || used.set(k, new Set()).get(k);
    let best = -1, bestD = Infinity;
    for (const at of [r.t]) {
      // first index with a[i] >= at - windowMs, then scan while inside the window (windows are tiny: this is a handful of steps)
      let lo = 0, hi = a.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < at - windowMs) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < a.length && a[i] <= at + windowMs; i++) {
        if (taken.has(i)) continue;
        const d = Math.abs(a[i] - at);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best >= 0) { taken.add(best); hit.add(r); }
  }
  return hit;
}

/**
 * summarizeExternal(files, { since, now, dshRows, windowMs }): `dshRows` (array or function) are the DSH ledger's rows
 * ({ ts, model, output }); a meter row matching one (see DEDUPE_WINDOW_MS) is left out of totals and byProvider and
 * counted in `deduped` instead. Without `dshRows` nothing is dropped.
 */
export function summarizeExternal(files, { since, now = Date.now(), dshRows = null, windowMs = DEDUPE_WINDOW_MS } = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === 'string' && f);
  const sets = list.map(parsedRows).filter(Boolean);
  if (!sets.length) return null;
  const sinceMs = resolveSince(since, now);
  const dup = matchedRows(sets, dshRows, sinceMs, windowMs);
  const totals = { usd: 0, calls: 0 };
  const deduped = { usd: 0, calls: 0 };
  const byProvider = Object.create(null);
  for (const rows of sets) for (const r of rows) {
    if (r.t < sinceMs) continue;
    if (dup.has(r)) { deduped.usd += r.usd; deduped.calls++; continue; }
    const g = (byProvider[r.prov] ||= { usd: 0, calls: 0 });
    g.usd += r.usd; g.calls++;
    totals.usd += r.usd; totals.calls++;
  }
  totals.usd = r6(totals.usd);
  deduped.usd = r6(deduped.usd);
  for (const g of Object.values(byProvider)) g.usd = r6(g.usd);
  return { source: EXTERNAL_SOURCE, totals, byProvider, deduped };
}
