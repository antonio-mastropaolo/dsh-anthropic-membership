// lib/cost/forecast.mjs — ESTIMATES. Pure over the ledger's exported summarize(); never imported by the guard, caps or engine.
// Every number here is a projection from recent pace, not a limit: nothing in this file can block a request.
import { summarize, sessionKey } from './ledger.mjs';
import { planStatus } from './plans.mjs';
import { planForecast } from '../plan-history.mjs';

export const MIN_CALLS = 3;
export const SHORT_MIN = 15;
export const LONG_MIN = 60;
export const EDGES_MIN = Object.freeze([2, 5, 9, 15, 30, 60]);
export const SESSION_HORIZON_MS = 24 * 3600e3;
const MIN_MS = 60e3, HOUR_MS = 3600e3;
const r6 = (x) => Number(x.toFixed(6));
// the billing kinds whose rows can carry charged dollars / whose API value is not charged / that draw down plan credits
const CHARGEABLE = new Set(['metered', 'mixed']);
const API_VALUE = new Set(['subscription', 'credits']);
const PLAN_USE = new Set(['credits', 'metered', 'mixed']);

/** The next local midnight after `now` (start of the local day plus one local day: 23, 24 or 25 h away across a DST change). */
export function nextLocalMidnight(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Exponentially weighted $/hour over the last `windowMin` minutes from slices {fromMin, toMin, value}: kernel exp(-age/tau), tau = window/3. */
export function ewmaPerHour(slices, windowMin) {
  const tau = windowMin / 3;
  const K = (a, b) => tau * (Math.exp(-a / tau) - Math.exp(-b / tau));
  let num = 0, den = 0;
  for (const s of slices) {
    if (s.toMin > windowMin) continue;
    const w = K(s.fromMin, s.toMin);
    num += (s.value / (s.toMin - s.fromMin)) * w;
    den += w;
  }
  return den > 0 ? r6((num / den) * 60) : 0;
}

// cumulative values at each edge -> the amount that fell into each slice
function sliceSeries(sums, valueOf) {
  const out = []; let prevV = 0, prevE = 0;
  EDGES_MIN.forEach((e, i) => { const v = valueOf(sums[i]); out.push({ fromMin: prevE, toMin: e, value: Math.max(0, v - prevV) }); prevV = v; prevE = e; });
  return out;
}
const chargeable = (b) => (b && CHARGEABLE.has(b.billing) ? b.calls : 0);
const at = (sums, min) => sums[EDGES_MIN.indexOf(min)];

function paceOf(sums, valueOf, callsOf) {
  const series = sliceSeries(sums, valueOf);
  const m15 = ewmaPerHour(series, SHORT_MIN), m60 = ewmaPerHour(series, LONG_MIN);
  const calls15 = callsOf(at(sums, SHORT_MIN)), calls60 = callsOf(at(sums, LONG_MIN));
  return { calls15, calls60, suppressed: calls15 < MIN_CALLS, m15, m60, low: Math.min(m15, m60), high: Math.max(m15, m60) };
}
const suppressedReason = (what, calls15) => `fewer than ${MIN_CALLS} metered calls ${what}in the last ${SHORT_MIN} min (${calls15})`;
// the time `remaining` dollars are used up at `rate` $/h, or null when never, or not before the horizon
const reach = (now, remaining, rate, horizonAt) => {
  if (!(rate > 0)) return null;
  const t = now + (remaining / rate) * HOUR_MS;
  return t <= horizonAt ? Math.round(t) : null;
};
const rangeOf = (now, rem, pace, horizonAt) => ({ earliestAt: reach(now, rem, pace.high, horizonAt), latestAt: reach(now, rem, pace.low, horizonAt) });

function capEntry({ which, provider, sessionId, capUsd, spentUsd, pace, horizonAt, now }) {
  const base = { which, ...(provider ? { provider } : {}), ...(sessionId ? { sessionId } : {}), capUsd, spentUsd, calls15: pace.calls15, ...(which === 'session' ? { horizonAt } : { resetsAt: horizonAt }) };
  // already at or over the cap is a fact, not a forecast: reported whatever the pace (same test as the guard: spent >= cap)
  if (spentUsd >= capUsd) return { ...base, state: 'reached', reason: null, reachedAt: null, range: null };
  if (pace.suppressed) return { ...base, state: 'suppressed', reason: suppressedReason(which === 'daily' ? '' : `for ${provider || 'this session'} `, pace.calls15), reachedAt: null, range: null };
  const rem = capUsd - spentUsd;
  const reachedAt = reach(now, rem, pace.m15, horizonAt);
  return { ...base, state: reachedAt === null ? 'not-at-this-pace' : 'at-pace', reason: null, reachedAt, range: rangeOf(now, rem, pace, horizonAt) };
}

const MAX_SESSIONS = 3;
// session ids with charged calls inside the last 60 min, ordered by the smallest look-back edge they show up in (newest first), then by more calls
function recentChargedSessions(sums) {
  const seen = new Map();
  sums.forEach((s, i) => {
    for (const [key, b] of Object.entries(s.bySession)) {
      const calls = chargeable(b);
      if (key !== '?' && calls > 0 && !seen.has(key)) seen.set(key, { edge: i, calls });
    }
  });
  return [...seen.entries()].sort((a, b) => a[1].edge - b[1].edge || b[1].calls - a[1].calls).slice(0, MAX_SESSIONS).map(([k]) => k);
}

/**
 * spendForecast(dataDir, { now, caps, plans, sessionId, summarizeFn }) -> the `spend` part of the report (see the
 * JSON contract in docs/specs/plans/2026-11-12-forecast.md). `caps` is the normalized caps object, `plans` the
 * config.json `plans`, `sessionId` the session in use (else the newest ledger row's session).
 */
export function spendForecast(dataDir, { now = Date.now(), caps, plans = {}, sessionId = null, summarizeFn = summarize } = {}) {
  const sums = EDGES_MIN.map((e) => summarizeFn(dataDir, { since: now - e * MIN_MS, now }));
  const today = summarizeFn(dataDir, { since: 'today', now });
  const all = caps && caps.sessionUsd > 0 ? summarizeFn(dataDir, { since: 'all', now }) : null;
  const complete = [...sums, today, all].every((s) => !s || (s.complete !== false && !s.unreadable));
  const base = { estimate: true, generatedAt: now, complete, reason: null, minCalls: MIN_CALLS, windowsMin: [SHORT_MIN, LONG_MIN] };
  if (!complete) return { ...base, reason: 'the spend ledger could not be read in full, so there is no forecast', charged: null, caps: [], apiValue: null, plans: [] };

  const midnightAt = nextLocalMidnight(now);
  const hours = (midnightAt - now) / HOUR_MS;
  const todayUsd = today.totals.usd;
  const allCalls = (s) => Object.values(s.byProvider).reduce((n, b) => n + chargeable(b), 0);
  const g = paceOf(sums, (s) => s.totals.usd, allCalls);
  const proj = (rate) => r6(todayUsd + rate * hours);
  const charged = g.suppressed
    ? { status: 'suppressed', reason: suppressedReason('', g.calls15), calls15: g.calls15, calls60: g.calls60, ratePerHour: null, todayUsd, midnightAt, projectedTodayUsd: null }
    : { status: 'ok', reason: null, calls15: g.calls15, calls60: g.calls60, ratePerHour: { m15: g.m15, m60: g.m60 }, todayUsd, midnightAt, projectedTodayUsd: { mid: proj(g.m15), low: proj(g.low), high: proj(g.high) } };

  const capList = [];
  if (caps && caps.dailyUsd > 0) capList.push(capEntry({ which: 'daily', capUsd: caps.dailyUsd, spentUsd: todayUsd, pace: g, horizonAt: midnightAt, now }));
  for (const [p, cap] of Object.entries(caps?.perProviderDailyUsd || {})) {
    if (!(cap > 0)) continue;
    const pace = paceOf(sums, (s) => s.byProvider[p]?.usd ?? 0, (s) => chargeable(s.byProvider[p]));
    capList.push(capEntry({ which: 'provider-daily', provider: p, capUsd: cap, spentUsd: today.byProvider[p]?.usd ?? 0, pace, horizonAt: midnightAt, now }));
  }
  // the session cap is forecast for the session in use; without one (the CLI has no host to ask) for the sessions that made
  // charged calls in the last hour, the one with the most recent charged call first (at most 3), else the newest session of any kind
  const sids = sessionId ? [sessionId] : recentChargedSessions(sums);
  if (!sessionId && !sids.length && all?.latestSession) sids.push(all.latestSession);
  if (caps && caps.sessionUsd > 0) {
    for (const sid of sids) {
      const key = sessionKey(sid);
      const pace = paceOf(sums, (s) => s.bySession[key]?.usd ?? 0, (s) => chargeable(s.bySession[key]));
      capList.push(capEntry({ which: 'session', sessionId: sid, capUsd: caps.sessionUsd, spentUsd: all.bySession[key]?.usd ?? 0, pace, horizonAt: now + SESSION_HORIZON_MS, now }));
    }
  }

  // subscription and credits calls are never charged: their pace is the API-list value, a plain average, and never moves a cap line
  const apiPart = (s) => Object.values(s.byProvider).filter((b) => API_VALUE.has(b.billing));
  const apiSum = (s) => apiPart(s).reduce((a, b) => a + b.apiEquivUsd, 0);
  const apiCalls = apiPart(at(sums, SHORT_MIN)).reduce((a, b) => a + b.calls, 0);
  const apiValue = apiCalls < MIN_CALLS
    ? { label: 'API value, not charged', status: 'suppressed', reason: `fewer than ${MIN_CALLS} subscription or credits calls in the last ${SHORT_MIN} min (${apiCalls})`, calls15: apiCalls, ratePerHour: null }
    : { label: 'API value, not charged', status: 'ok', reason: null, calls15: apiCalls, ratePerHour: { m15: r6(apiSum(at(sums, SHORT_MIN)) / (SHORT_MIN / 60)), m60: r6(apiSum(at(sums, LONG_MIN)) / (LONG_MIN / 60)) } };

  const planList = [];
  for (const st of planStatus(dataDir, plans, now)) {
    const use = (s) => { const b = s.byProvider[st.provider]; return b && PLAN_USE.has(b.billing) ? b : null; };
    const u15 = use(at(sums, SHORT_MIN)), u60 = use(at(sums, LONG_MIN));
    const calls15 = u15?.calls ?? 0;
    const m15 = r6((u15?.apiEquivUsd ?? 0) / (SHORT_MIN / 60)), m60 = r6((u60?.apiEquivUsd ?? 0) / (LONG_MIN / 60));
    const e = { provider: st.provider, name: st.name, includedUsd: st.includedUsd, remainingUsd: st.remainingUsd, resetsAt: st.resetsAt, calls15, ratePerHour: null, runsOutAt: null, range: null, reason: null };
    if (st.remainingUsd <= 0) { planList.push({ ...e, state: 'exhausted' }); continue; }
    if (!st.complete || calls15 < MIN_CALLS) { planList.push({ ...e, state: 'suppressed', reason: st.complete ? suppressedReason(`for ${st.provider} `, calls15) : 'the spend ledger could not be read in full' }); continue; }
    const horizon = Date.parse(st.resetsAt);
    const pace = { high: Math.max(m15, m60), low: Math.min(m15, m60) };
    const runsOutAt = reach(now, st.remainingUsd, m15, horizon);
    planList.push({ ...e, ratePerHour: { m15, m60 }, state: runsOutAt === null ? 'not-before-reset' : 'runs-out', runsOutAt, range: rangeOf(now, st.remainingUsd, pace, horizon) });
  }
  return { ...base, charged, caps: capList, apiValue, plans: planList };
}

/** The full report served by GET /forecast and printed by `dsh-hub forecast`. */
export function buildForecast({ dataDir, caps, plans, sessionId = null, now = Date.now() }) {
  const capsProblem = Array.isArray(caps?.warnings) && caps.warnings.length ? caps.warnings.join('; ') : null; // caps.json trouble: the defaults are in force, say so
  return { estimate: true, generatedAt: now, capsProblem, spend: spendForecast(dataDir, { now, caps, plans, sessionId }), plan: planForecast(dataDir, { now }) };
}
