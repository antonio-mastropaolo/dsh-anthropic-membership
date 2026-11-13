// lib/cost/reservation.mjs — in-flight spend reservations, so parallel requests cannot overshoot a cap together.
//
// A metered request that passes the guard reserves its WORST-CASE cost until its ledger row is written (or the stream ends).
// While other requests are in flight, a new request is checked against recorded + reserved + its own worst case.
// SAME PROCESS ONLY: another DSH process has its own store and does not see these reservations; the caps stay per-row-ledger
// truth, not a distributed lock. The estimate uses chars/4 for a request never seen before, a heuristic, not a bound.
import { costOf } from './cost.mjs';

/** Output tokens assumed when options.maxTokens is not a positive finite number. */
export const OUTPUT_CEILING_TOKENS = 32000;
/** A reservation no chunk has touched for this long is swept (a consumer that dropped its iterator without return()). */
export const RESERVATION_IDLE_MS = 10 * 60_000;
/** A reservation older than this is swept even while chunks keep arriving. */
export const RESERVATION_MAX_AGE_MS = 2 * 3600_000;
const IMAGE_CHARS = 6000; // an image block counts as 1500 tokens, never its base64 length
const MAX_DEPTH = 8;

/** Characters in a system / messages / tools value, without serialising the whole request. Never throws on odd shapes
 *  (a throwing getter on the caller's object is the caller's problem and propagates). */
export function approxChars(v, depth = 0) {
  if (v == null || depth > MAX_DEPTH) return 0;
  if (typeof v === 'string') return v.length;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).length;
  if (Array.isArray(v)) { let n = 0; for (const x of v) n += approxChars(x, depth + 1); return n; }
  if (typeof v === 'object') {
    if (v.type === 'image') return IMAGE_CHARS;
    let n = 0;
    for (const k of Object.keys(v)) n += k.length + approxChars(v[k], depth + 1);
    return n;
  }
  return 0;
}
export const approxPromptTokens = (o) => Math.ceil((approxChars(o?.system) + approxChars(o?.messages) + approxChars(o?.tools)) / 4);

/** Worst-case cost of one request: prompt = the previous prompt size for this session+route if known, else chars/4;
 *  output = options.maxTokens if a positive finite number, else OUTPUT_CEILING_TOKENS; priced at the route's rates through
 *  costOf (so the above-200k tier applies), as the larger of "all input at the input rate" and "all input as cache writes".
 *  -> { usd, promptTokens, outputTokens, basis: 'previous-prompt' | 'request-size' } */
export function estimateRequest(options, price, { previousPromptTokens = null } = {}) {
  const known = Number.isFinite(previousPromptTokens) && previousPromptTokens > 0;
  const promptTokens = known ? Math.floor(previousPromptTokens) : approxPromptTokens(options);
  const mt = options?.maxTokens;
  const outputTokens = Number.isFinite(mt) && mt > 0 ? Math.floor(mt) : OUTPUT_CEILING_TOKENS;
  const usd = Math.max(
    costOf({ input: promptTokens, output: outputTokens }, price).usd,
    costOf({ cacheWrite: promptTokens, output: outputTokens }, price).usd,
  );
  return { usd, promptTokens, outputTokens, basis: known ? 'previous-prompt' : 'request-size' };
}

/** The store. Tokens are integers. totals() -> { usd, count, byProvider, bySession }: the two maps are null-prototype
 *  objects (a provider or session id such as "__proto__" is only a key); bySession is keyed by the RAW session id.
 *  Invariant: stats().reserved === released + expired + active. */
export function createReservations({ now = Date.now, idleMs = RESERVATION_IDLE_MS, maxAgeMs = RESERVATION_MAX_AGE_MS } = {}) {
  const live = new Map();
  let seq = 0;
  const st = { reserved: 0, released: 0, expired: 0 };
  const sweep = () => {
    const t = now();
    for (const [k, e] of live) if (t - e.touchedAt > idleMs || t - e.startedAt > maxAgeMs) { live.delete(k); st.expired++; }
  };
  return {
    reserve({ provider, sessionId, usd }) {
      sweep();
      const t = now();
      const token = ++seq;
      live.set(token, { provider: String(provider || ''), sessionId: String(sessionId || ''), usd: Number.isFinite(usd) && usd > 0 ? usd : 0, startedAt: t, touchedAt: t });
      st.reserved++;
      return token;
    },
    touch(token) { const e = live.get(token); if (e) e.touchedAt = now(); },
    /** true the first time, false for an unknown, expired, already released or null token */
    release(token) { if (!live.delete(token)) return false; st.released++; return true; },
    totals() {
      sweep();
      let usd = 0;
      const byProvider = Object.create(null), bySession = Object.create(null);
      for (const e of live.values()) {
        usd += e.usd;
        byProvider[e.provider] = (byProvider[e.provider] || 0) + e.usd;
        bySession[e.sessionId] = (bySession[e.sessionId] || 0) + e.usd;
      }
      return { usd, count: live.size, byProvider, bySession };
    },
    stats() { sweep(); return { ...st, active: live.size }; },
  };
}
