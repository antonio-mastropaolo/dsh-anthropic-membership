// lib/cost/external.mjs — DISPLAY-ONLY read of other spend ledgers (JSONL rows with ts, usd, optional provider),
// e.g. a metering proxy's log. Opt-in: config.json `extraLedgers` or env DSH_HUB_EXTRA_LEDGERS (comma-separated).
// Caps and the spend guard never read this; it only feeds the `external` block of GET /spend.
import fs from 'node:fs';
import path from 'node:path';
import { resolveSince } from './ledger.mjs';

export const EXTERNAL_SOURCE = 'meter';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const r6 = (x) => Number(x.toFixed(6));

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
 * Only ts, provider and usd are read: session ids and other fields are never returned.
 */
export function summarizeExternal(files, { since, now = Date.now() } = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter((f) => typeof f === 'string' && f);
  const texts = [];
  for (const f of list) { try { texts.push(fs.readFileSync(f, 'utf8')); } catch { /* missing/unreadable: skip */ } }
  if (!texts.length) return null;
  const sinceMs = resolveSince(since, now);
  const totals = { usd: 0, calls: 0 };
  const byProvider = Object.create(null);
  for (const line of texts.join('\n').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const t = Date.parse(o.ts);
    if (Number.isNaN(t) || t < sinceMs) continue;
    const usd = typeof o.usd === 'number' && Number.isFinite(o.usd) && o.usd >= 0 ? o.usd : 0;
    let prov = typeof o.provider === 'string' && o.provider ? o.provider.slice(0, 60) : 'meter';
    if (UNSAFE_KEYS.has(prov)) prov = `_${prov}`;
    const g = (byProvider[prov] ||= { usd: 0, calls: 0 });
    g.usd += usd; g.calls++;
    totals.usd += usd; totals.calls++;
  }
  totals.usd = r6(totals.usd);
  for (const g of Object.values(byProvider)) g.usd = r6(g.usd);
  return { source: EXTERNAL_SOURCE, totals, byProvider };
}
