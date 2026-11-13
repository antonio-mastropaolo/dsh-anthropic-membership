// lib/cost/cost.mjs — token usage x price => USD. Pure.
import { randomUUID } from 'node:crypto';
import { normalizeUsage, reasoningTokens } from './usage-normalize.mjs';

const r6 = (x) => Number(x.toFixed(6));
export const TIER_THRESHOLD = 200000;

/** The rates a request is billed at: the above200k schedule when billed prompt tokens exceed 200k and the price has
 *  one (the whole request), else the base rates. cacheWrite stays at the base rate in the high tier when that
 *  schedule publishes none. -> { hi, rates:{inPerM,outPerM,cacheReadPerM,cacheWritePerM} } */
function pickRates(price, prompt) {
  const hi = price?.above200k && prompt > TIER_THRESHOLD ? price.above200k : null;
  return {
    hi,
    rates: {
      inPerM: (hi ? hi.inPerM : price?.inPerM) || 0,
      outPerM: (hi ? hi.outPerM : price?.outPerM) || 0,
      cacheReadPerM: (hi ? hi.cacheReadPerM : price?.cacheReadPerM) || 0,
      cacheWritePerM: (hi && hi.cacheWritePerM != null ? hi.cacheWritePerM : price?.cacheWritePerM) || 0,
    },
  };
}

/** USD (unrounded) of normalized tokens at explicit rates. costOf, makeSpendRecord and ledger verify share this arithmetic. */
export function usdFromRates(u, rates) {
  return (u.input / 1e6) * rates.inPerM + (u.output / 1e6) * rates.outPerM + (u.cacheRead / 1e6) * rates.cacheReadPerM + (u.cacheWrite / 1e6) * rates.cacheWritePerM;
}

/**
 * costOf(usage, price) -> {usd, inUsd, outUsd, cacheReadUsd, cacheWriteUsd, tier, rates}
 * `usage` may be any shape normalizeUsage understands. All amounts are the API-equivalent cost at
 * `price`; the CALLER decides what is charged (subscription/free/local => charged $0, keep this as
 * apiEquivUsd). tier = "above200k" when billed prompt (input+cacheRead+cacheWrite) exceeds 200k tokens
 * and the price has an above200k schedule (the whole request is billed at that schedule, as Google and
 * Anthropic do); else "base". `rates` = the four per-million rates actually applied.
 */
export function costOf(usage, price) {
  const u = normalizeUsage(usage);
  const { hi, rates } = pickRates(price, u.input + u.cacheRead + u.cacheWrite);
  const inUsd = (u.input / 1e6) * rates.inPerM;
  const outUsd = (u.output / 1e6) * rates.outPerM;
  const cacheReadUsd = (u.cacheRead / 1e6) * rates.cacheReadPerM;
  const cacheWriteUsd = (u.cacheWrite / 1e6) * rates.cacheWritePerM;
  return {
    usd: r6(usdFromRates(u, rates)),
    inUsd: r6(inUsd), outUsd: r6(outUsd), cacheReadUsd: r6(cacheReadUsd), cacheWriteUsd: r6(cacheWriteUsd),
    tier: hi ? 'above200k' : 'base',
    rates,
  };
}

/** What is actually charged: only metered billing costs money. */
export function chargedUsd(cost, price) { return price?.billing === 'metered' ? cost.usd : 0; }

const rateName = (n) => (String(n).endsWith('PerM') ? String(n) : `${n}PerM`);

/** Build a ledger record (no content) from one call. Ledger v2: self-describing, so `usd` can be re-derived from the row
 *  itself (rates, tier, planCoveredUsd). `meta` carries what only the caller knows (purpose, turn, step, parentSessionId,
 *  finish, ttftMs, durationMs); anything absent is null, never guessed. planCoveredUsd starts at 0; the caller that
 *  applies plan credits sets it. */
export function makeSpendRecord({ ts = new Date().toISOString(), sessionId = '', provider, model, usage, price, meta = {} }) {
  const u = normalizeUsage(usage);
  const c = costOf(u, price);
  // a price with no known rate (unpriced model, or a subscription model with no known API-equivalent) has no rates to store
  const priced = Boolean(price) && price.source !== 'unpriced' && price.apiEquivKnown !== false;
  const derivedSrc = c.tier === 'above200k' ? price?.above200k?.derived : price?.derived;
  const m = meta || {};
  return {
    id: randomUUID(), // stable across retries: a row written twice after a failed write counts once
    ts, sessionId: String(sessionId || ''), provider: String(provider || ''), model: String(model || ''),
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
    usd: chargedUsd(c, price), apiEquivUsd: c.usd, priceSource: price?.source || 'unpriced', billing: price?.billing || 'metered',
    v: 2,
    purpose: m.purpose ?? 'chat',
    turn: m.turn ?? null, step: m.step ?? null, parentSessionId: m.parentSessionId ?? null,
    rates: priced ? c.rates : null,
    derived: priced ? (Array.isArray(derivedSrc) ? derivedSrc.map(rateName) : []) : null,
    tier: c.tier,
    offPeak: priced ? Boolean(price.offPeak) : null,
    planCoveredUsd: 0,
    reasoning: reasoningTokens(usage),
    finish: m.finish ?? null, ttftMs: m.ttftMs ?? null, durationMs: m.durationMs ?? null,
  };
}
