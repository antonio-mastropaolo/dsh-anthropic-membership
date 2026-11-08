// lib/cost/external.mjs — DISPLAY-ONLY read of the agent-patcher meter ledger (~/.claude/abliteration/spend.jsonl).
// Caps and the spend guard never read this; it only feeds the `external` block of GET /spend.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSince } from './ledger.mjs';

export const DEFAULT_EXTERNAL_LEDGER = path.join(os.homedir(), '.claude', 'abliteration', 'spend.jsonl');
export const EXTERNAL_SOURCE = 'agent-patcher meter';
const r6 = (x) => Number(x.toFixed(6));

/** Single-path override: env DSH_HUB_EXTRA_LEDGERS, else the default meter ledger. */
export function externalLedgerPath(env = process.env) {
  const v = env.DSH_HUB_EXTRA_LEDGERS;
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_EXTERNAL_LEDGER;
}

/**
 * @returns null when the file is missing/unreadable, else
 *   { source, totals: { usd, calls }, byProvider: { [provider]: { usd, calls } } }
 * Rows without `provider` count as "abliteration". Malformed lines and non-numeric usd are skipped/zeroed.
 * Only ts, provider and usd are read: session ids and other fields are never returned.
 */
export function summarizeExternal(file, { since, now = Date.now() } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const sinceMs = resolveSince(since, now);
  const totals = { usd: 0, calls: 0 };
  const byProvider = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const t = Date.parse(o.ts);
    if (Number.isNaN(t) || t < sinceMs) continue;
    const usd = typeof o.usd === 'number' && Number.isFinite(o.usd) && o.usd >= 0 ? o.usd : 0;
    const prov = typeof o.provider === 'string' && o.provider ? o.provider.slice(0, 60) : 'abliteration';
    const g = (byProvider[prov] ||= { usd: 0, calls: 0 });
    g.usd += usd; g.calls++;
    totals.usd += usd; totals.calls++;
  }
  totals.usd = r6(totals.usd);
  for (const g of Object.values(byProvider)) g.usd = r6(g.usd);
  return { source: EXTERNAL_SOURCE, totals, byProvider };
}
