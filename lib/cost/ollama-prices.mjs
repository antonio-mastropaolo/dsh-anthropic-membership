// lib/cost/ollama-prices.mjs — Ollama Cloud rate table: bundled snapshot + a copy refreshed from ollama.com/pricing.
// The page is UNTRUSTED input: bounded size, parsed with plain string splitting and number regexes only (never
// evaluated, never stored as text), accepted only when it yields >= MIN_MODELS rows of finite non-negative numbers.
// Network is an injected fetch and never blocks a request (the engine loads it in the background like the LiteLLM table).
import fs from 'node:fs';
import path from 'node:path';
import { OLLAMA_PRICING_URL, OLLAMA_SNAPSHOT } from './ollama-snapshot.mjs';

export { OLLAMA_PRICING_URL, OLLAMA_SNAPSHOT };
export const OLLAMA_TTL_MS = 24 * 3600e3;       // fetch at most once per 24 h
export const OLLAMA_FAIL_BACKOFF_MS = 3600e3;   // after a failed fetch/parse, wait this long before trying again
export const MIN_MODELS = 10;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_RATE = 10000;                         // USD per million tokens: anything above is a parse error, not a price
const MAX_MODELS = 500;
const CACHE_NAME = 'ollama-prices.json';
const NAME_RE = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

const okRate = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RATE);
const cleanRate = (t) => (t && typeof t === 'object' && okRate(t.inPerM ?? null) && okRate(t.cachedPerM ?? null) && okRate(t.outPerM ?? null)
  ? { inPerM: t.inPerM ?? null, cachedPerM: t.cachedPerM ?? null, outPerM: t.outPerM ?? null } : null);

/** Validate a models map (from the cache file or the parser): null-prototype, safe names, finite non-negative numbers. */
export function sanitizeOllamaModels(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (UNSAFE.has(k) || !NAME_RE.test(k) || !v || typeof v !== 'object') continue;
    const base = cleanRate(v);
    if (!base) continue;
    const e = { ...base };
    if (v.offPeak !== undefined) { const op = cleanRate(v.offPeak); if (op) e.offPeak = op; }
    out[k] = e;
    if (++n >= MAX_MODELS) break;
  }
  return out;
}

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
const MAX_ROW_CHARS = 4000; // a real row is ~600 characters; longer is not a price row (also bounds the cell scan)
const CELL_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
const RATE_RE = /^\$?\s*(\d{1,6}(?:\.\d{1,8})?)$/;
const ROW_NAME_RE = /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,63})(\s*\(\s*off-peak\s*\))?$/i;

/**
 * parseOllamaPricing(html) -> models map | null. Finds the table whose header reads Model / Input / Cached input /
 * Output; every row becomes { inPerM, cachedPerM, outPerM } ("-" = null), "<name> (Off-Peak)" rows attach as offPeak
 * to <name>. A row that does not match exactly is dropped. Returns null unless at least MIN_MODELS models parse.
 */
export function parseOllamaPricing(html) {
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_PAGE_BYTES) return null;
  const lower = html.toLowerCase();
  let from = 0;
  const raw = Object.create(null);
  const offPeak = Object.create(null);
  for (let guard = 0; guard < 50; guard++) {
    const open = lower.indexOf('<table', from);
    if (open < 0) break;
    const close = lower.indexOf('</table>', open);
    const end = close < 0 ? html.length : close;
    from = end + 1;
    const rows = html.slice(open, end).split(/<tr\b/i).slice(1);
    if (!rows.length) continue;
    const cellsOf = (row) => { if (row.length > MAX_ROW_CHARS) return []; const c = []; for (const m of row.matchAll(CELL_RE)) { c.push(stripTags(m[1])); if (c.length > 8) break; } return c; };
    const head = cellsOf(rows[0]).map((c) => c.toLowerCase());
    if (head.length !== 4 || head[0] !== 'model' || head[1] !== 'input' || head[2] !== 'cached input' || head[3] !== 'output') continue;
    for (const row of rows.slice(1)) {
      const c = cellsOf(row);
      if (c.length !== 4) continue;
      const nm = ROW_NAME_RE.exec(c[0]);
      if (!nm) continue;
      const rates = [];
      let bad = false;
      for (const cell of c.slice(1)) {
        if (cell === '-' || cell === '—' || cell === '–') { rates.push(null); continue; }
        const m = RATE_RE.exec(cell);
        const v = m ? Number(m[1]) : NaN;
        if (!(Number.isFinite(v) && v >= 0 && v <= MAX_RATE)) { bad = true; break; }
        rates.push(v);
      }
      if (bad) continue;
      const name = nm[1].toLowerCase();
      if (UNSAFE.has(name)) continue;
      const t = { inPerM: rates[0], cachedPerM: rates[1], outPerM: rates[2] };
      if (nm[2]) offPeak[name] = t; else raw[name] = t;
    }
  }
  for (const [k, t] of Object.entries(offPeak)) if (raw[k]) raw[k] = { ...raw[k], offPeak: t };
  const models = sanitizeOllamaModels(raw);
  return Object.keys(models).length >= MIN_MODELS ? models : null;
}

/** True outside 12:00-18:00 UTC on weekdays and all day on weekends (the call's timestamp decides). */
export function isOffPeak(atMs) {
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  const h = d.getUTCHours();
  return !(h >= 12 && h < 18);
}

/** Model id -> table key: exact id, then the part before ":" ; a trailing ":cloud" / "-cloud" is dropped first. */
export function ollamaModelKey(models, modelId) {
  let id = String(modelId || '').trim().toLowerCase();
  if (!id) return null;
  id = id.replace(/[:-]cloud$/, '');
  const has = (k) => k && Object.prototype.hasOwnProperty.call(models || {}, k);
  if (has(id)) return id;
  const base = id.split(':')[0];
  return has(base) ? base : null;
}

/** The Ollama route rule: provider ollama/ollama-cloud AND (host is exactly ollama.com OR the model ends in :cloud / -cloud). */
export const isCloudModelId = (m) => /[:-]cloud$/i.test(String(m || ''));
export function isOllamaCloudHost(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return false;
  try { const u = new URL(baseURL.trim()); return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.toLowerCase() === 'ollama.com'; } catch { return false; }
}

/** The built-in table in the loader's shape. */
export function snapshotTable() {
  return { models: sanitizeOllamaModels(OLLAMA_SNAPSHOT.models), source: 'snapshot', date: OLLAMA_SNAPSHOT.date, fetchedAt: 0, count: Object.keys(OLLAMA_SNAPSHOT.models).length, url: OLLAMA_SNAPSHOT.source, warnings: [] };
}

const cachePath = (dataDir) => path.join(dataDir, CACHE_NAME);
function readCache(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(dataDir), 'utf8'));
    if (!c || typeof c !== 'object') return null;
    const models = sanitizeOllamaModels(c.models);
    return {
      models: Object.keys(models).length >= MIN_MODELS ? models : null,
      fetchedAt: Number.isFinite(c.fetchedAt) ? c.fetchedAt : 0,
      attemptedAt: Number.isFinite(c.attemptedAt) ? c.attemptedAt : 0,
      date: typeof c.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : null,
    };
  } catch { return null; }
}
function writeCache(dataDir, obj) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = cachePath(dataDir);
  const tmp = path.join(dataDir, `.${CACHE_NAME}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Synchronous best-known table for a request that cannot wait: the cache file if valid, else the snapshot. */
export function loadOllamaTableSync(dataDir) {
  const c = dataDir ? readCache(dataDir) : null;
  if (c && c.models) return { models: c.models, source: 'cache', date: c.date || (c.fetchedAt ? dayOf(c.fetchedAt) : null), fetchedAt: c.fetchedAt, count: Object.keys(c.models).length, url: OLLAMA_PRICING_URL, warnings: [] };
  return snapshotTable();
}

async function fetchPage(fetchImpl, url, timeoutMs) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, ac ? { signal: ac.signal, redirect: 'follow' } : undefined);
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    if (typeof res.url === 'string' && res.url) { // a redirect off ollama.com is not the pricing page
      let h = ''; try { h = new URL(res.url).hostname.toLowerCase(); } catch { /* bad url */ }
      if (h !== 'ollama.com') throw new Error('redirected away from ollama.com');
    }
    if (Number(res.headers?.get?.('content-length') || 0) > MAX_PAGE_BYTES) throw new Error('pricing page too large');
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PAGE_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('pricing page too large'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    if (typeof res.text !== 'function') throw new Error('no text body');
    const t = await res.text();
    if (typeof t !== 'string' || t.length > MAX_PAGE_BYTES) throw new Error('pricing page too large');
    return t;
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * loadOllamaTable({ dataDir, fetchImpl, now, ttlMs, url, timeoutMs }) -> { models, source, date, fetchedAt, count, url, warnings }
 * source: "cache" (fresh <24 h) | "network" | "stale-cache" (refresh failed) | "snapshot" (never fetched).
 * A page that does not parse (< 10 models) is rejected: the previous cache, else the snapshot, stays and a warning is recorded.
 */
export async function loadOllamaTable({ dataDir, fetchImpl = globalThis.fetch, now = Date.now(), ttlMs = OLLAMA_TTL_MS, url = OLLAMA_PRICING_URL, timeoutMs = 15000 } = {}) {
  const warnings = [];
  const cache = dataDir ? readCache(dataDir) : null;
  const shape = (models, source, date, fetchedAt) => ({ models, source, date, fetchedAt, count: Object.keys(models).length, url, warnings });
  const fromCache = (source) => shape(cache.models, source, cache.date || (cache.fetchedAt ? dayOf(cache.fetchedAt) : null), cache.fetchedAt);
  const fallback = () => (cache && cache.models ? fromCache('stale-cache') : { ...snapshotTable(), warnings });
  const clockOk = cache && now >= cache.fetchedAt && now >= cache.attemptedAt;
  if (cache && cache.models && clockOk && now - cache.fetchedAt < ttlMs) return fromCache('cache');
  // a recent failed attempt: do not hit the page again yet
  if (cache && clockOk && cache.attemptedAt && now - cache.attemptedAt < OLLAMA_FAIL_BACKOFF_MS) { warnings.push('ollama pricing: last refresh failed, retrying later'); return fallback(); }
  if (typeof fetchImpl !== 'function') { warnings.push('ollama pricing: no fetch available, using the stored table'); return fallback(); }
  const failed = (msg) => {
    warnings.push(`ollama pricing: ${msg}; keeping the ${cache && cache.models ? 'previous' : 'bundled'} table`);
    if (dataDir) { try { writeCache(dataDir, { fetchedAt: cache?.fetchedAt || 0, attemptedAt: now, date: cache?.date || null, models: cache?.models || {} }); } catch { /* best effort */ } }
    return fallback();
  };
  try {
    const page = await fetchPage(fetchImpl, url, timeoutMs);
    const models = parseOllamaPricing(page);
    if (!models) return failed(`the page did not parse (fewer than ${MIN_MODELS} valid rows)`);
    const date = dayOf(now);
    if (dataDir) { try { writeCache(dataDir, { fetchedAt: now, attemptedAt: now, date, models }); } catch (e) { warnings.push(`ollama pricing: could not write cache: ${e.code || 'error'}`); } }
    return shape(models, 'network', date, now);
  } catch (e) { return failed(`refresh failed (${String(e && e.message).slice(0, 80)})`); }
}
