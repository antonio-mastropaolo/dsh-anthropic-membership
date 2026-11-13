// lib/cost/totals.mjs — running USD totals for the per-request spend guard.
//
// The guard needs three numbers per metered request: today's spend, today's spend of one provider, and one session's
// whole-history spend. A full summary visits every ledger row for each; this keeps the totals and folds in only the
// rows that are new since the last read. It reads through the shared incremental reader (`readFileSet`), so the
// bytes are parsed once per file by the reader and the rows are folded once per file here. The result is equal to
// summarize({since:'today'}).totals.usd / .byProvider[p].usd / summarize({since:'all'}).bySession[key].usd.
//
// Fold state is kept per inode (a rotation renames a file, it keeps its inode, so it is not folded twice). Anything
// that could make the folded rows differ from the reader's current rows rebuilds the totals from scratch: a folded
// file that vanished, shrank, was replaced or was read again from byte 0. A row id is counted once across files.
import { readFileSet, dayKey, sessionKey } from './ledger.mjs';

const r6 = (x) => Number(x.toFixed(6));
const keyOf = (r) => `${r.id || ''}|${r.ts}|${r.provider}|${r.sessionId}|${r.usd}`;

// Streaming FNV-1a over the row keys of one file (two lanes of 32 bits): a cheap fingerprint of the folded prefix.
function mix(sig, text) {
  let [a, b] = sig;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return [a, b];
}
const SEED = [0x811c9dc5, 0x9747b28c];
const sigOf = (rows, count) => { let s = SEED; for (let i = 0; i < count; i++) s = mix(s, `${keyOf(rows[i])}\n`); return s; };
const sameSig = (x, y) => x[0] === y[0] && x[1] === y[1];

export function createLedgerTotals(dataDir) {
  let folds, days, sessions, seenIds;
  const reset = () => { folds = new Map(); days = new Map(); sessions = new Map(); seenIds = new Set(); };
  reset();

  function foldRow(r) {
    if (r.id) { if (seenIds.has(r.id)) return; seenIds.add(r.id); } // a retried row counts once
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) return;
    const k = dayKey(t);
    let d = days.get(k);
    if (!d) { d = { usd: 0, byProvider: new Map() }; days.set(k, d); }
    d.usd += r.usd;
    const p = r.provider || '?';
    d.byProvider.set(p, (d.byProvider.get(p) || 0) + r.usd);
    if (t >= 0) { const s = sessionKey(r.sessionId); sessions.set(s, (sessions.get(s) || 0) + r.usd); } // the whole-history window starts at epoch 0
  }

  /** Is what was folded from this file still what the reader holds for it? Same reader entry: its rows only ever grow.
   *  A new entry object means the reader read the file afresh (renamed by a rotation, truncated, replaced): the folded
   *  prefix must then still fingerprint the same. */
  function intact(fold, entry) {
    if (fold.entry === entry) return true;
    const rows = entry.rows;
    if (rows.length < fold.count || !sameSig(sigOf(rows, fold.count), fold.sig)) return false;
    fold.entry = entry;
    return true;
  }

  /** -> { todayUsd, providerUsd, sessionUsd, complete, unreadable }.
   *  todayUsd: spend dated from the start of the local day of `now` on (future-dated rows included, like summarize);
   *  providerUsd: that day's spend of `provider` ('' has none, like summarize's byProvider['']);
   *  sessionUsd: the session's whole history. When the ledger could not be read in full, `complete` is false and the
   *  numbers are not to be used: they are never presented as "no spend". */
  function read({ now = Date.now(), provider = '', sessionId = '' } = {}) {
    const { files, complete, unreadable } = readFileSet(dataDir);
    if (!complete || unreadable) return { todayUsd: 0, providerUsd: 0, sessionUsd: 0, complete: false, unreadable: !!unreadable };
    const live = new Set(files.map((f) => f.ino));
    let stale = [...folds.keys()].some((i) => !live.has(i));
    if (!stale) for (const f of files) {
      const fold = folds.get(f.ino);
      if (fold && !intact(fold, f.entry)) { stale = true; break; }
    }
    if (stale) reset();
    for (const f of files) {
      const rows = f.entry.rows;
      let fold = folds.get(f.ino);
      if (!fold) { fold = { entry: f.entry, count: 0, sig: SEED }; folds.set(f.ino, fold); }
      for (let i = fold.count; i < rows.length; i++) {
        foldRow(rows[i]);
        fold.sig = mix(fold.sig, `${keyOf(rows[i])}\n`);
      }
      fold.count = rows.length;
      fold.entry = f.entry;
    }
    const today = dayKey(now);
    let todayUsd = 0, providerUsd = 0;
    for (const [k, d] of days) {
      if (k < today) continue; // YYYY-MM-DD strings compare as dates
      todayUsd += d.usd;
      if (provider) providerUsd += d.byProvider.get(provider) || 0;
    }
    return { todayUsd: r6(todayUsd), providerUsd: r6(providerUsd), sessionUsd: r6(sessions.get(sessionKey(sessionId)) || 0), complete: true, unreadable: false };
  }

  return { read };
}
