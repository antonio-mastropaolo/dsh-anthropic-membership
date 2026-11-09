// lib/cost/ledger.mjs — append-only spend ledger (spend.jsonl, 0600) and summaries.
// Records hold NUMBERS and ids only — never prompt/completion content. Fields are whitelisted key by key.
//
// Several DSH processes may append concurrently (e.g. the web host and a headless run):
//  - appends are O_APPEND single-line writes;
//  - rotation first renames spend.jsonl to a private temp name (atomic: exactly one process wins), then
//    hard-links it to a fresh spend.<n>.jsonl (link fails rather than overwriting) — no rotation can
//    clobber another, and an append racing the rename still lands in the renamed file;
//  - if the hard link cannot be made (EPERM on some filesystems, no free name), the temp file is linked back
//    to spend.jsonl; if even that fails it stays as a `.spend.rotating.*` orphan, which readers still count.
//    Rotation never throws out of appendSpend: a failed rotation only means spend.jsonl keeps growing;
//  - readers cache parsed rows per file and only read the bytes appended since last time, so the
//    per-request spend guard does not re-parse the whole history; files are de-duplicated by inode (the
//    temp name and its spend.<n>.jsonl link are the same file for a moment).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROTATE_BYTES = 20 * 1024 * 1024;
const FILE = 'spend.jsonl';
const ROTATED_RE = /^spend\.\d+\.jsonl$/;
const ORPHAN_RE = /^\.spend\.rotating\.\d+\.[0-9a-f]+$/;
const str = (v, n = 200) => String(v ?? '').slice(0, n);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const r6 = (x) => Number(x.toFixed(6));
const p2 = (x) => String(x).padStart(2, '0');
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

/** Aggregation key for a session id: empty/missing ids share one bucket ("?"). Caps use the same key. */
export const sessionKey = (id) => (id ? String(id) : '?');
// keys that would reach Object.prototype on a plain object; aggregation maps are null-prototype anyway
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeKey = (k) => (UNSAFE_KEYS.has(k) ? `_${k}` : k);

function clean(rec) {
  const ts = typeof rec?.ts === 'string' && !Number.isNaN(Date.parse(rec.ts)) ? rec.ts : new Date().toISOString();
  return {
    ts, sessionId: str(rec?.sessionId), provider: str(rec?.provider), model: str(rec?.model),
    input: Math.round(num(rec?.input)), output: Math.round(num(rec?.output)),
    cacheRead: Math.round(num(rec?.cacheRead)), cacheWrite: Math.round(num(rec?.cacheWrite)),
    usd: r6(num(rec?.usd)), apiEquivUsd: r6(num(rec?.apiEquivUsd)),
    priceSource: str(rec?.priceSource, 40), billing: str(rec?.billing, 20),
  };
}

function rotate(dataDir, file) {
  const tmp = path.join(dataDir, `.spend.rotating.${process.pid}.${randomBytes(6).toString('hex')}`);
  try {
    fs.renameSync(file, tmp); // atomic: if another process already rotated, this is ENOENT
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  let stamp = Date.now();
  for (let i = 0; i < 10_000; i++, stamp++) {
    try {
      fs.linkSync(tmp, path.join(dataDir, `spend.${stamp}.jsonl`)); // never overwrites an existing rotation
      try { fs.unlinkSync(tmp); } catch { /* readers de-duplicate by inode */ }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') break;
    }
  }
  // could not archive it: put it back as spend.jsonl (fails if an append already made a new one), else
  // leave the orphan where readers still count it
  try { fs.linkSync(tmp, file); fs.unlinkSync(tmp); } catch { /* orphan kept */ }
  throw new Error('ledger rotation failed; spend.jsonl kept');
}

/** Append one record. Rotates spend.jsonl -> spend.<epochms>.jsonl once it reaches 20 MB. Returns the stored record. */
export function appendSpend(dataDir, record, { rotateBytes = ROTATE_BYTES } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, FILE);
  try {
    if (fs.statSync(file).size >= rotateBytes) rotate(dataDir, file);
  } catch { /* missing file, or a failed rotation: either way the record below is still appended */ }
  const rec = clean(record);
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
  return rec;
}

// path -> { ino, offset, rows }   (offset = bytes consumed up to the last complete line)
const fileCache = new Map();
let parsedBytes = 0;
/** Test hook: bytes parsed from disk so far (proves unchanged files are not re-read). */
export const _ledgerParsedBytes = () => parsedBytes;
export const _resetLedgerCache = () => { fileCache.clear(); parsedBytes = 0; };

function parseInto(rows, text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(clean(o)); } catch { /* torn line */ }
  }
}

function rowsOf(full, st) {
  let c = fileCache.get(full);
  if (!c || c.ino !== st.ino || st.size < c.offset) c = { ino: st.ino, offset: 0, rows: [] }; // new, replaced or truncated
  if (st.size > c.offset) {
    let fd;
    try {
      fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(st.size - c.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, c.offset);
      const text = buf.subarray(0, n).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl >= 0) { // only consume complete lines; a half-written last line is read next time
        parseInto(c.rows, text.slice(0, lastNl + 1));
        const consumed = Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
        c.offset += consumed;
        parsedBytes += consumed;
      }
    } catch { /* unreadable right now: keep what we have */ }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  fileCache.set(full, c);
  return c.rows;
}

function readRows(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir).filter((f) => f === FILE || ROTATED_RE.test(f) || ORPHAN_RE.test(f)); } catch { return []; }
  const live = new Set(names.map((f) => path.join(dataDir, f)));
  for (const k of fileCache.keys()) if (path.dirname(k) === dataDir && !live.has(k)) fileCache.delete(k);
  const rows = [];
  const seenIno = new Set();
  for (const full of live) {
    let st;
    try { st = fs.statSync(full); } catch { fileCache.delete(full); continue; }
    if (seenIno.has(st.ino)) { fileCache.delete(full); continue; } // a second name for a file already read
    seenIno.add(st.ino);
    for (const r of rowsOf(full, st)) rows.push(r);
  }
  return rows;
}

/** since: number(ms) | Date | ISO string | "today" | "7d" | "30d" | "all" (undefined = all). Local-time day boundaries. */
export function resolveSince(since, now = Date.now()) {
  if (since === undefined || since === null || since === 'all') return 0;
  if (since instanceof Date) return since.getTime();
  if (typeof since === 'number') return since;
  const s = String(since);
  if (s === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const m = /^(\d+)d$/.exec(s);
  if (m) { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (Number(m[1]) - 1)); return d.getTime(); } // "7d" = today + 6 previous days
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad since: ${s}`);
  return t;
}

const emptyAgg = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, apiEquivUsd: 0, unpricedCalls: 0 });
function add(a, r) {
  a.calls++; a.input += r.input; a.output += r.output; a.cacheRead += r.cacheRead; a.cacheWrite += r.cacheWrite;
  a.usd += r.usd; a.apiEquivUsd += r.apiEquivUsd;
  // a metered call with no known price is stored at $0: count it so the UI can say caps did not see it
  if (r.priceSource === 'unpriced' && r.billing === 'metered') a.unpricedCalls++;
}
const fin = (a) => { a.usd = r6(a.usd); a.apiEquivUsd = r6(a.apiEquivUsd); return a; };
const bucket = (map, key) => (map[safeKey(key)] ||= emptyAgg());

/**
 * summarize(dataDir, {since, by, now}) ->
 *  { since, sinceMs, totals, byProvider, byModel, bySession, byDay, groups, by }
 * every by* is {key: {calls,input,output,cacheRead,cacheWrite,usd,apiEquivUsd,unpricedCalls}}; `groups` = the one
 * chosen by `by` ("provider"|"model"|"session"|"day"; default provider). usd = charged, apiEquivUsd = API-list equivalent.
 * Maps are null-prototype (a "__proto__" id from a ledger line can never reach Object.prototype).
 */
export function summarize(dataDir, { since, by = 'provider', now = Date.now() } = {}) {
  const sinceMs = resolveSince(since, now);
  const totals = emptyAgg();
  const byProvider = Object.create(null), byModel = Object.create(null), bySession = Object.create(null), byDay = Object.create(null);
  for (const r of readRows(dataDir)) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < sinceMs) continue;
    add(totals, r);
    add(bucket(byProvider, r.provider || '?'), r);
    add(bucket(byModel, `${r.provider}/${r.model}`), r);
    add(bucket(bySession, sessionKey(r.sessionId)), r);
    add(bucket(byDay, dayKey(t)), r);
  }
  for (const m of [byProvider, byModel, bySession, byDay]) for (const v of Object.values(m)) fin(v);
  fin(totals);
  const pick = { provider: byProvider, model: byModel, session: bySession, day: byDay }[by];
  if (!pick) throw new Error(`bad by: ${by} (provider|model|session|day)`);
  return { since: since ?? 'all', sinceMs, by, totals, byProvider, byModel, bySession, byDay, groups: pick };
}
