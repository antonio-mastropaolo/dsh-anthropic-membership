// lib/cost/turns.mjs: the per-turn index of one session, built from the cleaned ledger rows (ledger.mjs ledgerRows()).
// Pure: rows in, plain objects out. It never reads a file and never sees prompt or completion text (the ledger has none).
const r6 = (x) => Number(x.toFixed(6));
export const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MAX_TURNS = 1000;
const kind = (b) => (typeof b === 'string' && b ? b : 'unknown');
const tsMs = (r) => Date.parse(r.ts);

/** Own rows (sessionId === id, exact) and the rows of its direct subagents (parentSessionId === id). One level only. */
export function sessionRows(rows, sessionId) {
  const own = [];
  const sub = [];
  for (const r of rows) {
    if (r.sessionId === sessionId) own.push(r);
    else if (r.parentSessionId === sessionId) sub.push(r);
  }
  return { own, sub };
}

/** The session "last" means: the newest row with a session id; a subagent's row resolves to its parent. null when none. */
export function latestSessionId(rows) {
  let best = null;
  let bestT = -Infinity;
  for (const r of rows) {
    if (!r.sessionId) continue;
    const t = tsMs(r);
    if (Number.isNaN(t)) continue;
    if (t >= bestT) { bestT = t; best = r; }
  }
  return best ? (best.parentSessionId || best.sessionId) : null;
}

const agg = (rs) => {
  let usd = 0, api = 0;
  for (const r of rs) { usd += r.usd; api += r.apiEquivUsd; }
  return { calls: rs.length, usd: r6(usd), apiEquivUsd: r6(api) };
};
const byPurpose = (rs) => {
  const m = new Map();
  for (const r of rs) { const k = r.purpose || 'unknown'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([purpose, list]) => ({ purpose, ...agg(list) }));
};

function oneTurn(turn, rs) {
  rs.sort((a, b) => (tsMs(a) - tsMs(b)) || ((a.step ?? 1e9) - (b.step ?? 1e9)));
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, notCharged = 0, unpriced = 0, dur = 0, durKnown = true;
  const kinds = new Map();
  const routes = new Map();
  const steps = new Set();
  for (const r of rs) {
    input += r.input; output += r.output; cacheRead += r.cacheRead; cacheWrite += r.cacheWrite;
    notCharged += Math.max(0, r.apiEquivUsd - r.usd);
    if (r.priceSource === 'unpriced' && r.billing === 'metered') unpriced++;
    if (r.durationMs === null || r.durationMs === undefined) durKnown = false; else dur += r.durationMs;
    kinds.set(kind(r.billing), (kinds.get(kind(r.billing)) || 0) + 1);
    const rk = `${r.provider}/${r.model}`;
    routes.set(rk, { provider: r.provider, model: r.model, calls: (routes.get(rk)?.calls || 0) + 1 });
    if (r.step !== null && r.step !== undefined) steps.add(r.step);
  }
  const prompt = input + cacheRead + cacheWrite;
  const money = agg(rs);
  const starts = rs.map((r) => tsMs(r) - (r.durationMs || 0)).filter(Number.isFinite);
  const ends = rs.map(tsMs).filter(Number.isFinite);
  return {
    turn, calls: rs.length, steps: steps.size,
    usd: money.usd, apiEquivUsd: money.apiEquivUsd, notChargedUsd: r6(notCharged),
    input, output, cacheRead, cacheWrite, cacheReadShare: prompt > 0 ? cacheRead / prompt : null,
    billing: kinds.size === 1 ? [...kinds.keys()][0] : 'mixed', billings: Object.fromEntries(kinds),
    routes: [...routes.values()], unpricedCalls: unpriced,
    ttftMs: rs[0].ttftMs ?? null, durationMs: durKnown ? dur : null,
    firstTs: rs[0].ts, lastTs: rs[rs.length - 1].ts,
    during: [],
    _window: [starts.length ? Math.min(...starts) : NaN, ends.length ? Math.max(...ends) : NaN],
  };
}

/**
 * buildTurns(rows, sessionId) -> { sessionId, turns[], outside, v1Calls, truncated }
 *  turn: { turn, calls, steps, usd, apiEquivUsd, notChargedUsd, input, output, cacheRead, cacheWrite, cacheReadShare|null,
 *          billing (one kind | "mixed"), billings{kind:calls}, routes[{provider,model,calls}], unpricedCalls, ttftMs|null,
 *          durationMs|null, firstTs, lastTs, during[{purpose,calls,usd,apiEquivUsd}] }   (ascending by turn)
 *  outside: { calls, usd, apiEquivUsd, byPurpose[] }  non-chat (or turn-less) v2 calls not inside any turn's time window
 *  v1Calls: rows without `v` (no turn field): counted here, never given a turn
 */
export function buildTurns(rows, sessionId) {
  const { own } = sessionRows(rows, sessionId);
  const chat = new Map();
  const other = [];
  let v1Calls = 0;
  for (const r of own) {
    if (r.v !== 2) { v1Calls++; continue; }
    if (r.purpose === 'chat' && Number.isInteger(r.turn)) {
      if (!chat.has(r.turn)) chat.set(r.turn, []);
      chat.get(r.turn).push(r);
    } else other.push(r);
  }
  let turns = [...chat.entries()].sort((a, b) => a[0] - b[0]).map(([t, rs]) => oneTurn(t, rs));
  const duringRows = turns.map(() => []);
  const outsideRows = [];
  for (const r of other) {
    const t = tsMs(r);
    const i = Number.isNaN(t) ? -1 : turns.findIndex((x) => t >= x._window[0] && t <= x._window[1]);
    if (i >= 0) duringRows[i].push(r); else outsideRows.push(r);
  }
  turns.forEach((x, i) => { x.during = byPurpose(duringRows[i]); delete x._window; });
  let truncated = false;
  if (turns.length > MAX_TURNS) { turns = turns.slice(turns.length - MAX_TURNS); truncated = true; }
  const out = agg(outsideRows);
  return { sessionId, turns, outside: { ...out, byPurpose: byPurpose(outsideRows) }, v1Calls, truncated };
}
