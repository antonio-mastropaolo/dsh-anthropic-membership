// lib/cost/cost.mjs — token usage x price => USD. Pure.
import { normalizeUsage } from './usage-normalize.mjs';

const r6 = (x) => Number(x.toFixed(6));
export const TIER_THRESHOLD = 200000;

/**
 * costOf(usage, price) -> {usd, inUsd, outUsd, cacheReadUsd, cacheWriteUsd, tier}
 * `usage` may be any shape normalizeUsage understands. All amounts are the API-equivalent cost at
 * `price`; the CALLER decides what is charged (subscription/free/local => charged $0, keep this as
 * apiEquivUsd). tier = "above200k" when billed prompt (input+cacheRead+cacheWrite) exceeds 200k tokens
 * and the price has an above200k schedule (the whole request is billed at that schedule, as Google and
 * Anthropic do); else "base". cacheWrite stays at the base rate in the high tier (no published tier price).
 */
export function costOf(usage, price) {
  const u = normalizeUsage(usage);
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  const hi = price?.above200k && prompt > TIER_THRESHOLD ? price.above200k : null;
  const inRate = (hi ? hi.inPerM : price?.inPerM) || 0;
  const outRate = (hi ? hi.outPerM : price?.outPerM) || 0;
  const crRate = (hi ? hi.cacheReadPerM : price?.cacheReadPerM) || 0;
  const cwRate = (hi && hi.cacheWritePerM != null ? hi.cacheWritePerM : price?.cacheWritePerM) || 0;
  const inUsd = (u.input / 1e6) * inRate;
  const outUsd = (u.output / 1e6) * outRate;
  const cacheReadUsd = (u.cacheRead / 1e6) * crRate;
  const cacheWriteUsd = (u.cacheWrite / 1e6) * cwRate;
  return {
    usd: r6(inUsd + outUsd + cacheReadUsd + cacheWriteUsd),
    inUsd: r6(inUsd), outUsd: r6(outUsd), cacheReadUsd: r6(cacheReadUsd), cacheWriteUsd: r6(cacheWriteUsd),
    tier: hi ? 'above200k' : 'base',
  };
}

/** What is actually charged: only metered billing costs money. */
export function chargedUsd(cost, price) { return price?.billing === 'metered' ? cost.usd : 0; }

/** Build a ledger record (no content) from one step. */
export function makeSpendRecord({ ts = new Date().toISOString(), sessionId = '', provider, model, usage, price }) {
  const u = normalizeUsage(usage);
  const c = costOf(u, price);
  return {
    ts, sessionId: String(sessionId || ''), provider: String(provider || ''), model: String(model || ''),
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
    usd: chargedUsd(c, price), apiEquivUsd: c.usd, priceSource: price?.source || 'unpriced', billing: price?.billing || 'metered',
  };
}
