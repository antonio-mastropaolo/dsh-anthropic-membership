// lib/cost/ledger.mjs — append-only spend ledger (spend.jsonl, 0600) and summaries.
// Records hold NUMBERS and ids only — never prompt/completion content. Fields are whitelisted key by key.
import fs from 'node:fs';
import path from 'node:path';

export const ROTATE_BYTES = 20 * 1024 * 1024;
const FILE = 'spend.jsonl';
const str = (v, n = 200) => String(v ?? '').slice(0, n);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const r6 = (x) => Number(x.toFixed(6));
const p2 = (x) => String(x).padStart(2, '0');
export const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

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

/** Append one record. Rotates spend.jsonl -> spend.<epochms>.jsonl once it reaches 20 MB. Returns the stored record. */
export function appendSpend(dataDir, record, { rotateBytes = ROTATE_BYTES } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, FILE);
  try {
    if (fs.statSync(file).size >= rotateBytes) {
      // never overwrite an earlier rotation (two rotations in one ms would silently lose rows)
      let stamp = Date.now(), dest;
      while (fs.existsSync((dest = path.join(dataDir, `spend.${stamp}.jsonl`)))) stamp++;
      fs.renameSync(file, dest);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const rec = clean(record);
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
  return rec;
}

function readRows(dataDir) {
  let names = [];
  try { names = fs.readdirSync(dataDir).filter((f) => f === FILE || /^spend\.\d+\.jsonl$/.test(f)); } catch { return []; }
  const rows = [];
  for (const f of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dataDir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(clean(o)); } catch { /* torn line */ }
    }
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

const emptyAgg = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, apiEquivUsd: 0 });
function add(a, r) {
  a.calls++; a.input += r.input; a.output += r.output; a.cacheRead += r.cacheRead; a.cacheWrite += r.cacheWrite;
  a.usd += r.usd; a.apiEquivUsd += r.apiEquivUsd;
}
const fin = (a) => { a.usd = r6(a.usd); a.apiEquivUsd = r6(a.apiEquivUsd); return a; };

/**
 * summarize(dataDir, {since, by, now}) ->
 *  { since, sinceMs, totals, byProvider, byModel, bySession, byDay, groups, by }
 * every by* is {key: {calls,input,output,cacheRead,cacheWrite,usd,apiEquivUsd}}; `groups` = the one chosen by `by`
 * ("provider"|"model"|"session"|"day"; default provider). usd = charged, apiEquivUsd = API-list equivalent.
 */
export function summarize(dataDir, { since, by = 'provider', now = Date.now() } = {}) {
  const sinceMs = resolveSince(since, now);
  const totals = emptyAgg(), byProvider = {}, byModel = {}, bySession = {}, byDay = {};
  for (const r of readRows(dataDir)) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t) || t < sinceMs) continue;
    add(totals, r);
    add((byProvider[r.provider || '?'] ||= emptyAgg()), r);
    add((byModel[`${r.provider}/${r.model}`] ||= emptyAgg()), r);
    add((bySession[r.sessionId || '?'] ||= emptyAgg()), r);
    add((byDay[dayKey(t)] ||= emptyAgg()), r);
  }
  for (const m of [byProvider, byModel, bySession, byDay]) for (const v of Object.values(m)) fin(v);
  fin(totals);
  const pick = { provider: byProvider, model: byModel, session: bySession, day: byDay }[by];
  if (!pick) throw new Error(`bad by: ${by} (provider|model|session|day)`);
  return { since: since ?? 'all', sinceMs, by, totals, byProvider, byModel, bySession, byDay, groups: pick };
}
