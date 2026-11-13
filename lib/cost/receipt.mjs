// lib/cost/receipt.mjs: a session's receipt from the cleaned ledger rows. Pure and dependency-free (no node: import), so the
// CLI, the host route and the browser-side tests all print the same text. It never receives a path, a token, an account
// identity or any prompt/completion text (the ledger has none); every ledger string it prints goes through safe().
import { sessionRows } from './turns.mjs';
import { fmtUsdSmall } from './money.mjs';

const r6 = (x) => Number(x.toFixed(6));
export const MAX_SUB_SESSIONS = 50;
// byte-identical to lib/demo/constants.mjs DEMO_TEXT (a test pins it); duplicated so this module needs no import from the demo code
const DEMO_LINE = 'DEMO DATA: synthetic, nothing is recorded or capped';
const MAX_LINE = 100;
const NOT_ATTRIBUTED = 'not attributed';

const fresh = () => ({ calls: 0, usd: 0, apiEquivUsd: 0, notChargedUsd: 0 });
const add = (a, r) => { a.calls++; a.usd += r.usd; a.apiEquivUsd += r.apiEquivUsd; a.notChargedUsd += Math.max(0, r.apiEquivUsd - r.usd); };
const fin = (a) => ({ calls: a.calls, usd: r6(a.usd), apiEquivUsd: r6(a.apiEquivUsd), notChargedUsd: r6(a.notChargedUsd) });
const mapTo = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, fin(v)]));
const bump = (m, k, r) => { if (!m.has(k)) m.set(k, fresh()); add(m.get(k), r); };

/** Everything the receipt says about one set of rows. */
function summarizeRows(rs) {
  const total = fresh();
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const routes = new Map();
  const purposes = new Map();
  const billings = new Map();
  const turns = new Set();
  const notAttributed = fresh();
  let first = Infinity;
  let last = -Infinity;
  for (const r of rs) {
    add(total, r);
    tok.input += r.input; tok.output += r.output; tok.cacheRead += r.cacheRead; tok.cacheWrite += r.cacheWrite;
    const kind = r.billing || 'unknown';
    const rk = `${r.provider}/${r.model}|${kind}`;
    if (!routes.has(rk)) routes.set(rk, { provider: r.provider, model: r.model, billing: kind, ...fresh() });
    add(routes.get(rk), r);
    bump(billings, kind, r);
    if (r.v === 2) {
      bump(purposes, r.purpose || 'unknown', r);
      if (r.purpose === 'chat' && Number.isInteger(r.turn)) turns.add(r.turn);
    } else add(notAttributed, r);
    const t = Date.parse(r.ts);
    if (Number.isFinite(t)) { if (t < first) first = t; if (t > last) last = t; }
  }
  const prompt = tok.input + tok.cacheRead + tok.cacheWrite;
  return {
    ...fin(total), turns: turns.size,
    firstTs: Number.isFinite(first) ? new Date(first).toISOString() : null,
    lastTs: Number.isFinite(last) ? new Date(last).toISOString() : null,
    cache: { ...tok, readShare: prompt > 0 ? tok.cacheRead / prompt : null },
    byRoute: [...routes.values()].map((x) => ({ provider: x.provider, model: x.model, billing: x.billing, ...fin(x) }))
      .sort((a, b) => b.apiEquivUsd - a.apiEquivUsd || (`${a.provider}/${a.model}|${a.billing}` < `${b.provider}/${b.model}|${b.billing}` ? -1 : 1)),
    byPurpose: mapTo(purposes), byBilling: mapTo(billings), notAttributed: fin(notAttributed),
  };
}

/**
 * buildReceipt(rows, sessionId) -> {
 *   sessionId, calls, usd, apiEquivUsd, notChargedUsd, turns, firstTs, lastTs,
 *   cache{input,output,cacheRead,cacheWrite,readShare|null},
 *   byRoute[{provider,model,billing,calls,usd,apiEquivUsd,notChargedUsd}] (API value, biggest first), byPurpose{purpose:{...}}, byBilling{kind:{...}},
 *   notAttributed{...}   (rows from before ledger v2: in every total, in no purpose),
 *   subagents{ levels:1, sessionCount, calls, usd, apiEquivUsd, notChargedUsd, byRoute, byPurpose, byBilling, notAttributed, sessions[<=50], moreSessions },
 *   withSubagents{ calls, usd, apiEquivUsd } }
 */
export function buildReceipt(rows, sessionId) {
  const { own, sub } = sessionRows(rows, sessionId);
  const mine = summarizeRows(own);
  const theirs = summarizeRows(sub);
  const per = new Map();
  for (const r of sub) bump(per, r.sessionId, r);
  const list = [...per.entries()].map(([id, a]) => ({ sessionId: id, ...fin(a) }))
    .sort((a, b) => b.apiEquivUsd - a.apiEquivUsd || (a.sessionId < b.sessionId ? -1 : 1));
  return {
    sessionId, ...mine,
    subagents: {
      levels: 1, sessionCount: list.length, calls: theirs.calls, usd: theirs.usd, apiEquivUsd: theirs.apiEquivUsd, notChargedUsd: theirs.notChargedUsd,
      byRoute: theirs.byRoute, byPurpose: theirs.byPurpose, byBilling: theirs.byBilling, notAttributed: theirs.notAttributed,
      sessions: list.slice(0, MAX_SUB_SESSIONS), moreSessions: Math.max(0, list.length - MAX_SUB_SESSIONS),
    },
    withSubagents: { calls: mine.calls + theirs.calls, usd: r6(mine.usd + theirs.usd), apiEquivUsd: r6(mine.apiEquivUsd + theirs.apiEquivUsd) },
  };
}

/** A ledger string made safe to print anywhere: only A-Za-z0-9 space _ . : / + -, 80 characters, never path-like. */
export function safe(s) {
  let t = String(s === undefined || s === null ? '' : s).replace(/[^A-Za-z0-9 _.:/+-]/g, '_').slice(0, 80);
  if (t.startsWith('/') || t.includes('..') || t.startsWith('~')) t = t.replace(/\//g, '_');
  return t;
}

const money = fmtUsdSmall;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const stamp = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : null);
export const NOT_READ = 'The spend ledger could not be read in full, so the calls of this session are not known.';
const PURPOSE_ORDER = ['chat', 'compaction', 'session-title', 'auto-review', 'other'];
const purposeEntries = (m) => Object.entries(m).sort(([a], [b]) => {
  const ia = PURPOSE_ORDER.indexOf(a); const ib = PURPOSE_ORDER.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : a > b ? 1 : 0);
});
const BILLING_MEANING = {
  metered: 'charged per use',
  subscription: 'covered by a plan, not charged here',
  credits: 'covered by prepaid plan credits',
  local: 'no charge (runs on your own hardware)',
  free: 'no charge',
};
const charged = (x) => `${money(x.usd)} charged${x.notChargedUsd > 0 ? `, API value ${money(x.notChargedUsd)} not charged` : ''}`;

const clamp = (l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 3)}...` : l);

/** The plain-text receipt (the body of `dsh-hub receipt` and of the /receipt command): short lines, no tables.
 *  `partial`: the ledger could not be read in full, so an empty receipt means "not known", never "no calls". */
export function receiptText(rc, { demo = false, partial = false } = {}) {
  const lines = demo ? [DEMO_LINE] : [];
  lines.push(`Session ${safe(rc.sessionId)}`);
  if (rc.calls === 0 && rc.subagents.calls === 0) {
    lines.push(partial ? NOT_READ : 'No model calls recorded for this session yet.');
    return lines.join('\n');
  }
  const head = [`charged ${money(rc.usd)}`];
  head[0] += rc.notChargedUsd > 0 ? ` · API value ${money(rc.notChargedUsd)}, not charged` : '';
  head.push(plural(rc.calls, 'call'), plural(rc.turns, 'turn'));
  if (rc.cache.readShare !== null) head.push(`cache read ${Math.round(rc.cache.readShare * 100)}%`);
  lines.push(head.join(' · '));
  if (rc.firstTs) lines.push(`first call ${stamp(rc.firstTs)} · last call ${stamp(rc.lastTs)}`);
  if (rc.byRoute.length) {
    lines.push('by route:');
    for (const r of rc.byRoute) {
      const tail = ` (${safe(r.billing)}): ${plural(r.calls, 'call')}, ${charged(r)}`;
      const label = `${safe(r.provider)}/${safe(r.model)}`;
      const room = MAX_LINE - 2 - tail.length;
      lines.push(`  ${label.length > room && room > 3 ? `${label.slice(0, room - 3)}...` : label}${tail}`);
    }
  }
  const purposes = purposeEntries(rc.byPurpose).map(([k, v]) => `${safe(k)} ${v.calls}`);
  if (rc.notAttributed.calls > 0) purposes.push(`${NOT_ATTRIBUTED} ${rc.notAttributed.calls}`);
  if (purposes.length) lines.push(`by purpose: ${purposes.join(' · ')}`);
  if (rc.subagents.calls > 0) lines.push(`subagents (one level): ${plural(rc.subagents.sessionCount, 'session')}, ${plural(rc.subagents.calls, 'call')}, ${charged(rc.subagents)}`);
  if (rc.notAttributed.calls > 0) lines.push(`${NOT_ATTRIBUTED} (rows from before ledger v2, no purpose or turn): ${plural(rc.notAttributed.calls, 'call')}, ${money(rc.notAttributed.usd)} charged`);
  return lines.map(clamp).join('\n');
}

const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
const routeTable = (byRoute) => table(['Route', 'Billing', 'Calls', 'Charged', 'API value, not charged'], byRoute.map((r) => [`${safe(r.provider)}/${safe(r.model)}`, safe(r.billing), r.calls, money(r.usd), money(r.notChargedUsd)]));
const purposeTable = (s) => table(['Purpose', 'Calls', 'Charged', 'API value'], [
  ...purposeEntries(s.byPurpose).map(([k, v]) => [safe(k), v.calls, money(v.usd), money(v.apiEquivUsd)]),
  ...(s.notAttributed.calls > 0 ? [[NOT_ATTRIBUTED, s.notAttributed.calls, money(s.notAttributed.usd), money(s.notAttributed.apiEquivUsd)]] : []),
]);

/** The Markdown receipt: what the Cost tab's "Copy as Markdown" button copies and `dsh-hub receipt --md` prints. */
export function receiptMarkdown(rc, { demo = false } = {}) {
  const out = demo ? [DEMO_LINE, ''] : [];
  out.push('# Session receipt', '', `Session: \`${safe(rc.sessionId)}\``, '');
  const kv = [['Charged', money(rc.usd)]];
  if (rc.subagents.calls > 0) kv.push(['Charged including subagents', money(rc.withSubagents.usd)]);
  kv.push(['API value, not charged', money(rc.notChargedUsd)], ['Model calls', rc.calls], ['Turns', rc.turns],
    ['Cache-read share', rc.cache.readShare === null ? 'n/a' : `${Math.round(rc.cache.readShare * 100)}%`],
    ['First call', stamp(rc.firstTs) || 'n/a'], ['Last call', stamp(rc.lastTs) || 'n/a']);
  out.push('| | |', '|---|---|', ...kv.map((r) => `| ${r[0]} | ${r[1]} |`), '');
  out.push('## By model / route', '', ...routeTable(rc.byRoute), '');
  out.push('## By purpose', '', ...purposeTable(rc), '');
  const kinds = Object.entries(rc.byBilling).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  out.push('## Billing kinds', '', ...table(['Billing', 'Calls', 'Charged', 'API value'], kinds.map(([k, v]) => [safe(k), v.calls, money(v.usd), money(v.apiEquivUsd)])), '');
  const meanings = kinds.filter(([k]) => BILLING_MEANING[k]).map(([k]) => `- ${k}: ${BILLING_MEANING[k]}`);
  if (meanings.length) out.push(...meanings, '');
  if (rc.subagents.calls > 0) {
    const s = rc.subagents;
    out.push('## Subagents (one level)', '', ...table(['Session', 'Calls', 'Charged', 'API value'], s.sessions.map((x) => [safe(x.sessionId), x.calls, money(x.usd), money(x.apiEquivUsd)])), '');
    if (s.moreSessions > 0) out.push(`and ${s.moreSessions} more subagent sessions.`, '');
    out.push('### Subagents by model / route', '', ...routeTable(s.byRoute), '');
    out.push('### Subagents by purpose', '', ...purposeTable(s), '');
    out.push('Subagents of subagents are not rolled up here.', '');
  }
  out.push('Money comes from the local spend ledger of dsh-model-hub. "API value" is what the calls would cost at list prices; it was not charged on subscription, credits, free or local routes. No prompt or completion text is recorded or shown.');
  return out.join('\n');
}
