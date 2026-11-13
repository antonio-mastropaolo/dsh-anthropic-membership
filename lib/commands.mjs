// lib/commands.mjs: the four read-only slash commands (/cost /caps /route /receipt) and the registry that tolerates a name
// collision. The commands take no arguments (any text after the name is ignored), change nothing, and print money, ids and
// model names only: never a key, a token, a URL, an environment variable name or a path. They are meant for the person typing
// them: the handler refuses any invocation whose `source` is present and not {kind: 'user'}.
import { redactSecrets } from './accounts/errors.mjs';
import { capsView, checkCaps } from './cost/caps.mjs';
import { sessionKey } from './cost/ledger.mjs';
import { receiptText, safe } from './cost/receipt.mjs';
import { SESSION_ID_RE } from './cost/turns.mjs';
import { fmtUsdSmall } from './cost/money.mjs';

export const COMMAND_NAMES = Object.freeze(['cost', 'caps', 'route', 'receipt']);

// byte-identical to lib/demo/constants.mjs DEMO_TEXT (a test pins it through the demo host); duplicated so this module has no demo import
const DEMO_LINE = 'DEMO DATA: synthetic, nothing is recorded or capped';
const MAX_LINE = 100;
const REFUSED = 'refused: slash commands are for the person typing them.';
const READ_FAILED = 'could not read the ledger (see dsh-hub doctor)';
const NO_ROUTE = "Route: not known (DSH has not reported this session's model yet).";

const num = (x) => (Number.isFinite(x) ? x : 0);
const fmtUsd = fmtUsdSmall;
const fmtCap = (n) => `$${num(n).toFixed(2)}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clamp = (l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 3)}...` : l);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// price per million tokens: at least two decimals, no trailing zeros beyond that ($0.75, $3.75, $0.075)
const fmtM = (n) => `$${num(n).toFixed(4).replace(/(\.\d\d\d?)0+$/, '$1').replace(/(\.\d\d)0$/, '$1')}`;
const finish = (lines, demo) => (demo ? [DEMO_LINE, ...lines] : lines).map(clamp).join('\n');
const why = (action, reason) => (action && action !== 'ok' && reason ? [`Why: ${oneLine(redactSecrets(reason))}`] : []);

const BILLING_MEANING = {
  metered: 'metered (charged per use)',
  subscription: 'subscription (covered by your plan, not charged per use)',
  credits: 'credits (drawn from prepaid credits)',
  local: 'local (runs on your machine, no charge)',
  free: 'free (no charge)',
};

/** d = { demo, todayUsd, limits:{dailyUsd,sessionUsd}, session:{calls,usd,apiEquivUsd,notChargedUsd}|null, action, reason, guard:{onError}, reservedUsd, complete } */
export function costText(d) {
  const lines = [];
  const daily = num(d.limits?.dailyUsd);
  const sessionCap = num(d.limits?.sessionUsd);
  lines.push(`Today: ${fmtUsd(d.todayUsd)} charged. ${daily > 0 ? `Daily cap ${fmtCap(daily)}, ${fmtCap(Math.max(0, daily - num(d.todayUsd)))} left.` : 'Daily cap: off.'}`);
  const s = d.session;
  if (!s) lines.push('This session: not known.');
  else if (!s.calls) lines.push(d.complete === false ? 'This session: not known (the ledger could not be read in full).' : 'This session: no model calls recorded yet.');
  else {
    const notCharged = Number.isFinite(s.notChargedUsd) ? s.notChargedUsd : Math.max(0, num(s.apiEquivUsd) - num(s.usd));
    lines.push(`This session: ${fmtUsd(s.usd)} charged, ${notCharged > 0 ? `API value ${fmtUsd(notCharged)} not charged, ` : ''}${plural(s.calls, 'call')}.`);
  }
  if (sessionCap <= 0) lines.push('Session cap: off.');
  else if (!s) lines.push(`Session cap ${fmtCap(sessionCap)}.`);
  else lines.push(`Session cap ${fmtCap(sessionCap)}, ${fmtCap(Math.max(0, sessionCap - num(s.usd)))} left.`);
  lines.push(`Guard: ${safe(d.action || 'ok')}. On a guard error: ${safe(d.guard?.onError || 'unknown')}. In flight: ${fmtCap(d.reservedUsd)}.`);
  lines.push(...why(d.action, d.reason));
  if (d.complete === false) lines.push('Ledger read was partial: totals may be low.');
  return finish(lines, d.demo);
}

/** d = { demo, limits:{dailyUsd,sessionUsd,warnPct}, perProvider:{p:{capUsd,spentUsd}}, stopAtPlanLimit, action, reason, problem } */
export function capsText(d) {
  const cap = (n) => (num(n) > 0 ? fmtCap(n) : 'off');
  const lines = [`Caps in effect: daily ${cap(d.limits?.dailyUsd)}, per session ${cap(d.limits?.sessionUsd)}, warn at ${num(d.limits?.warnPct)}%.`];
  const providers = Object.entries(d.perProvider || {});
  if (!providers.length) lines.push('Per provider: none.');
  else for (const [p, v] of providers) lines.push(`Per provider ${safe(p)}: ${cap(v?.capUsd)} (spent today ${fmtUsd(v?.spentUsd)}).`);
  lines.push(`Today: ${safe(d.action || 'ok')}. Stop at plan limit: ${d.stopAtPlanLimit ? 'on' : 'off'}.`);
  lines.push(...why(d.action, d.reason));
  if (d.problem) lines.push(`A problem with caps.json: ${oneLine(redactSecrets(d.problem))}`);
  lines.push('Read-only here. Change caps in Settings > Models > Model hub or with: dsh-hub caps set dailyUsd=10');
  return finish(lines, d.demo);
}

const AUTH_LINES = {
  'api-key': 'Auth: API key.',
  'stored-sign-in': 'Auth: stored sign-in (grant).',
  none: 'Auth: none needed or none found.',
  unknown: 'Auth: not known (route config unreadable).',
};

/** d = { demo, route:{provider,model}|null, price:{billing,inPerM,outPerM,cacheReadPerM,source,priced}|null, auth } */
export function routeText(d) {
  if (!d.route) return finish([NO_ROUTE], d.demo);
  const lines = [`Route: ${safe(d.route.provider)}/${safe(d.route.model)}.`];
  const p = d.price;
  if (!p) lines.push('Price: not known.');
  else {
    const kind = p.billing || 'unknown';
    lines.push(`Billing: ${BILLING_MEANING[kind] || safe(kind)}.`);
    if (kind === 'metered') {
      if (p.priced === false) lines.push('Price: not known (unpriced).');
      else {
        const parts = [`${fmtM(p.inPerM)} in`, `${fmtM(p.outPerM)} out`];
        if (Number.isFinite(p.cacheReadPerM)) parts.push(`${fmtM(p.cacheReadPerM)} cache read`);
        lines.push(`Price per 1M tokens: ${parts.join(', ')}.`);
        if (p.source) lines.push(`Price source: ${safe(p.source)}.`);
      }
    }
  }
  lines.push(AUTH_LINES[d.auth] || AUTH_LINES.unknown);
  return finish(lines, d.demo);
}

/** The data dir never leaves in a reply. (Secret redaction is applied to the free-text parts that could carry one: reasons and
 *  problems. It is not applied to the whole reply because it would also mask the session id the receipt shows.) */
function scrub(text, dataDir) {
  let t = String(text);
  if (typeof dataDir === 'string' && dataDir.length > 1) t = t.split(dataDir).join('[data dir]');
  return t;
}

/**
 * The guard's verdict for ONE session, from the numbers engine.capsStatus() reports (today's spend, each provider's spend, the
 * caps) and that session's own charged spend. engine.capsStatus() judges the session the host last saw, which need not be the
 * session that typed the command, so its action and reason are not used here. Without a session id the session cap is not
 * applied (the same rule capsStatus uses when it has no session). The worst of the global check and the per-provider checks
 * wins, like capsStatus. -> { action, reason }
 */
function guardFor(cs, sessionId, sessionUsd) {
  const caps = { ...cs.limits, sessionUsd: sessionId ? cs.limits?.sessionUsd : 0 };
  const byProvider = Object.fromEntries(Object.entries(cs.perProvider || {}).map(([p, v]) => [p, { usd: num(v?.spentUsd) }]));
  const base = {
    summary: { totals: { usd: num(cs.todayUsd) }, byProvider },
    sessionSummary: { bySession: { [sessionKey(sessionId)]: { usd: num(sessionUsd) } } },
    billing: 'metered', caps, sessionId: sessionId || '',
  };
  const rank = { block: 2, warn: 1, ok: 0 };
  const res = [checkCaps({ ...base, provider: '' }), ...Object.keys(cs.limits?.perProviderDailyUsd || {}).map((p) => checkCaps({ ...base, provider: p }))]
    .reduce((a, b) => (rank[b.action] > rank[a.action] || (rank[b.action] === rank[a.action] && b.pct > a.pct) ? b : a));
  return { action: res.action, reason: res.reason };
}

/** createCommandDefs({ engine, dataDir, sessions, routeAuth, oauthProviders, demo }) -> CommandDefinition[] */
export function createCommandDefs({ engine, dataDir, sessions, routeAuth, oauthProviders, demo = false } = {}) {
  const sessionIdOf = (inv) => { const id = inv?.agent?.id; return typeof id === 'string' && SESSION_ID_RE.test(id) ? id : null; };
  const routeOf = (inv) => {
    try {
      const r = inv?.agent?.model?.current?.();
      return r && typeof r.provider === 'string' && typeof r.model === 'string' && r.provider && r.model ? { provider: r.provider, model: r.model } : null;
    } catch { return null; }
  };
  const authOf = (provider) => {
    let ra;
    try { ra = routeAuth(); } catch { ra = { known: false, apiKeyRoutes: [] }; }
    if (ra?.known && ra.apiKeyRoutes.includes(provider)) return 'api-key';
    let oauth = [];
    try { oauth = oauthProviders(); } catch { oauth = []; }
    if (oauth.includes(provider)) return 'stored-sign-in';
    return ra?.known === false ? 'unknown' : 'none';
  };
  const receiptOf = async (id) => {
    const rc = await sessions.receipt(id);
    return { rc, complete: rc.complete !== false && !rc.unreadable };
  };

  const bodies = {
    async cost(inv) {
      const cs = engine.capsStatus();
      const id = sessionIdOf(inv);
      let session = null;
      let complete = cs.complete !== false && !cs.unreadable;
      if (id) {
        const r = await receiptOf(id);
        session = { calls: r.rc.calls, usd: r.rc.usd, apiEquivUsd: r.rc.apiEquivUsd, notChargedUsd: r.rc.notChargedUsd };
        complete = complete && r.complete;
      }
      const g = guardFor(cs, id, session?.usd ?? 0);
      return costText({ demo, todayUsd: cs.todayUsd, limits: cs.limits, session, action: g.action, reason: g.reason, guard: cs.guard, reservedUsd: cs.reserved?.usd ?? 0, complete });
    },
    async caps() {
      const cs = engine.capsStatus();
      const view = capsView(dataDir);
      const g = guardFor(cs, null, 0); // "Today": the daily and per-provider caps, which are the same for every session
      return capsText({ demo, limits: cs.limits, perProvider: cs.perProvider, stopAtPlanLimit: view.stopAtPlanLimit, action: g.action, reason: g.reason, problem: view.problem });
    },
    async route(inv) {
      const route = routeOf(inv);
      if (!route) return routeText({ demo, route: null, price: null, auth: 'unknown' });
      let price = null;
      try {
        const id = `${route.provider}/${route.model}`;
        price = (await engine.prices([id]))?.models?.[id] ?? null;
      } catch { price = null; }
      return routeText({ demo, route, price, auth: authOf(route.provider) });
    },
    async receipt(inv) {
      const id = sessionIdOf(inv);
      if (!id) return finish(['This session: not known.'], demo);
      const { rc, complete } = await receiptOf(id);
      const empty = rc.calls === 0 && rc.subagents.calls === 0;
      const t = receiptText(rc, { demo, partial: !complete });
      return complete || empty ? t : `${t}\nLedger read was partial: totals may be low.`;
    },
  };
  const descriptions = {
    cost: 'Show what this session and today cost, and the caps that apply (read-only).',
    caps: 'Show the spend caps in effect and where to change them (read-only).',
    route: 'Show the provider and model in use, how it is billed and its price (read-only).',
    receipt: "Show this session's cost receipt by route, purpose and subagent (read-only).",
  };

  return COMMAND_NAMES.map((name) => ({
    name,
    description: descriptions[name],
    recordInput: false,
    // `source` is not a field of DSH's CommandInvocation today (the registry stamps {kind: 'user'} on the log line itself); if a
    // context ever exposes one, anything but a user source is refused. Arguments (rawInput) are never read.
    async handler(inv) {
      const src = inv && inv.source;
      if (src !== undefined && (!src || src.kind !== 'user')) return { kind: 'error', text: REFUSED };
      try {
        return { kind: 'success', text: scrub(await bodies[name](inv), dataDir) };
      } catch {
        return { kind: 'error', text: READ_FAILED };
      }
    },
  }));
}

/**
 * registerCommands(commandsService, defs, { warn }) -> { registered: string[], collided: string[] }
 * Each register runs in its own try/catch: a name another plugin already holds (or any other failure) is one warning that names
 * the command, and never stops the others or the plugin.
 */
export function registerCommands(commandsService, defs, { warn = () => {} } = {}) {
  const registered = [];
  const collided = [];
  for (const def of defs) {
    try {
      commandsService.register(def);
      registered.push(def.name);
    } catch (e) {
      collided.push(def.name);
      const msg = redactSecrets(String(e?.message ?? e)).replace(/\s+/g, ' ').slice(0, 120);
      try { warn(`model-hub: slash command /${def.name} was not registered (${msg}); another plugin may already use that name`); } catch { /* a failing logger must not stop the others */ }
    }
  }
  return { registered, collided };
}
