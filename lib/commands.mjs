// lib/commands.mjs: the four read-only slash commands (/cost /caps /route /receipt) and the registry that tolerates a name
// collision. The commands take no arguments (any text after the name is ignored), change nothing, and print money, ids and
// model names only: never a key, a token, a URL, an environment variable name or a path. They are meant for the person typing
// them: the handler refuses any invocation whose `source` is present and not {kind: 'user'}.
import { redactSecrets } from './accounts/errors.mjs';
import { capsView, checkCaps } from './cost/caps.mjs';
import { sessionKey } from './cost/ledger.mjs';
import { receiptReplyText, safe } from './cost/receipt.mjs';
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

const BILLING_NAME = { metered: 'Metered', subscription: 'Subscription', credits: 'Credits', local: 'Local', free: 'Free' };
const billingName = (k) => BILLING_NAME[k] || safe(k || 'unknown');
const BILLING_MEANING = {
  metered: 'charged per use',
  subscription: 'covered by your plan',
  credits: 'covered by prepaid credits',
  local: 'runs on your machine, no charge',
  free: 'no charge',
};
const SEP = ' · ';
const padR = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

/** The verdict that opens a reply when the guard is not ok: what it means, from which cap and its action. */
const VERDICT = {
  block: {
    daily: 'Daily cap reached: metered requests are stopped.',
    session: 'Session cap reached: metered requests are stopped.',
    'provider-daily': 'Provider cap reached: metered requests to it are stopped.',
    'unpriced-capped': 'A capped provider has a model with no price: metered requests to it are stopped.',
  },
  warn: {
    daily: 'Near the daily cap: requests still go through.',
    session: 'Near the session cap: requests still go through.',
    'provider-daily': 'Near a provider cap: requests still go through.',
    unpriced: 'A model has no price: its spend is not counted.',
  },
};
const verdict = (action, which) => (action === 'block' || action === 'warn' ? [VERDICT[action][which] || (action === 'block' ? 'Cap reached: metered requests are stopped.' : 'Near a cap: requests still go through.')] : []);
/** The daily line's verdict comes from today's own numbers (the guard reports only the first cap that fired, so a session or
 *  provider block can hide a daily cap that is also reached), and from the guard when it is the daily cap that fired. */
const dailyClause = (action, which, today, daily, warnPct) => {
  if ((action === 'block' && which === 'daily') || (daily > 0 && today >= daily)) return 'cap reached';
  if ((action === 'warn' && which === 'daily') || (daily > 0 && warnPct > 0 && today >= (daily * warnPct) / 100)) return 'near the cap';
  return 'within caps';
};
const guardFail = (onError) => (onError === 'allow' ? 'If the cap check itself fails, requests go through.' : onError === 'block' ? 'If the cap check itself fails, requests are refused.' : 'What happens if the cap check itself fails is not known.');

/** d = { demo, todayUsd, limits:{dailyUsd,sessionUsd}, session:{calls,usd,apiEquivUsd,notChargedUsd}|null, action, which, reason, guard:{onError}, reservedUsd, complete } */
export function costText(d) {
  const lines = [...verdict(d.action, d.which), ...why(d.action, d.reason)];
  const daily = num(d.limits?.dailyUsd);
  const sessionCap = num(d.limits?.sessionUsd);
  const s = d.session;
  const sAmt = s && s.calls ? fmtUsd(s.usd) : null;
  const tAmt = fmtUsd(d.todayUsd);
  const w = Math.max(sAmt ? sAmt.length : 0, tAmt.length);
  if (!s) lines.push(`${padR('This session', 16)}not known.`);
  else if (!s.calls) lines.push(`${padR('This session', 16)}${d.complete === false ? 'not known (the ledger could not be read in full).' : 'no model calls recorded yet.'}`);
  else {
    const notCharged = Number.isFinite(s.notChargedUsd) ? s.notChargedUsd : Math.max(0, num(s.apiEquivUsd) - num(s.usd));
    const parts = [`${padL(sAmt, w)} charged${sessionCap > 0 ? ` of ${fmtCap(sessionCap)}` : ''}`];
    parts.push(sessionCap > 0 ? `${fmtCap(Math.max(0, sessionCap - num(s.usd)))} left` : 'no session cap');
    if (notCharged > 0) parts.push(`${fmtUsd(notCharged)} not charged`);
    parts.push(plural(s.calls, 'call'));
    lines.push(`${padR('This session', 16)}${parts.join(SEP)}.`);
  }
  const t = [`${padL(tAmt, w)} charged${daily > 0 ? ` of ${fmtCap(daily)}` : ''}`];
  t.push(daily > 0 ? `${fmtCap(Math.max(0, daily - num(d.todayUsd)))} left` : 'no daily cap');
  if (daily > 0) t.push(dailyClause(d.action, d.which, num(d.todayUsd), daily, num(d.limits?.warnPct)));
  lines.push(`${padR('Today', 16)}${t.join(SEP)}.`);
  lines.push('', `Held for requests in flight: ${fmtCap(d.reservedUsd)}. ${guardFail(d.guard?.onError)}`);
  lines.push('Not charged is the API value: the list price of calls on plan, credit, free and local routes.');
  if (d.complete === false) lines.push('Ledger read was partial: totals may be low.');
  return finish(lines, d.demo);
}

/** d = { demo, limits:{dailyUsd,sessionUsd,warnPct}, perProvider:{p:{capUsd,spentUsd}}, stopAtPlanLimit, action, which, reason, problem } */
export function capsText(d) {
  const daily = num(d.limits?.dailyUsd);
  const sess = num(d.limits?.sessionUsd);
  const warn = num(d.limits?.warnPct);
  const providers = Object.entries(d.perProvider || {});
  const lines = [...verdict(d.action, d.which), ...why(d.action, d.reason)];
  const head = ['Caps: ' + (daily > 0 ? `${fmtCap(daily)} a day` : 'no daily cap')];
  head.push(sess > 0 ? `${fmtCap(sess)} a session` : 'no session cap');
  head.push(warn > 0 ? `warning at ${warn}%` : 'no warning level');
  head.push(providers.length ? 'provider caps below' : 'no provider caps');
  head.push(`today ${d.action === 'block' ? 'at a cap' : d.action === 'warn' ? 'near a cap' : 'within caps'}`);
  lines.push(`${head.join(SEP)}.`);
  if (providers.length) {
    const nameW = Math.max(...providers.map(([p]) => safe(p).length));
    const capW = Math.max(...providers.map(([, v]) => fmtCap(v?.capUsd).length));
    for (const [p, v] of providers) {
      const cap = num(v?.capUsd) > 0 ? `${padL(fmtCap(v.capUsd), capW)} a day` : `${padL('no cap', capW)}      `;
      lines.push(`${padR(safe(p), nameW)}  ${cap}${SEP}${fmtUsd(v?.spentUsd)} spent today`.trimEnd());
    }
  }
  lines.push(d.stopAtPlanLimit ? 'Claude plan stop is on: DSH refuses Claude requests when a plan window is full.' : 'Claude plan stop is off: DSH keeps sending Claude requests when a plan window is full.');
  if (d.problem) lines.push(`A problem with caps.json: ${oneLine(redactSecrets(d.problem))}`);
  lines.push('Read-only here. Change caps in Settings > Models > Model hub, or run: dsh-hub caps set dailyUsd=10');
  return finish(lines, d.demo);
}

const AUTH_LINES = {
  'api-key': 'Signed in with an API key.',
  'stored-sign-in': 'Signed in with a stored sign-in.',
  none: 'No sign-in needed or found.',
  unknown: 'Sign-in not known (route config unreadable).',
};

/** d = { demo, route:{provider,model}|null, price:{billing,inPerM,outPerM,cacheReadPerM,source,priced}|null, auth } */
export function routeText(d) {
  if (!d.route) return finish([NO_ROUTE], d.demo);
  const p = d.price;
  const kind = p ? p.billing || 'unknown' : null;
  const first = [`${safe(d.route.provider)}/${safe(d.route.model)}`];
  if (p) first.push(BILLING_MEANING[kind] ? `${billingName(kind)}: ${BILLING_MEANING[kind]}` : billingName(kind));
  first.push((AUTH_LINES[d.auth] || AUTH_LINES.unknown).replace(/\.$/, ''));
  const lines = [`${first.join(SEP)}.`];
  if (!p) lines.push('Price: not known.');
  else if (kind === 'metered') {
    if (p.priced === false) lines.push('Price: not known (unpriced).');
    else {
      const parts = [`${fmtM(p.inPerM)} in`, `${fmtM(p.outPerM)} out`];
      if (Number.isFinite(p.cacheReadPerM)) parts.push(`${fmtM(p.cacheReadPerM)} cache read`);
      if (p.source) parts.push(`source: ${safe(p.source)}`);
      lines.push(`Price per 1M tokens: ${parts.join(SEP)}.`);
    }
  }
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
  return { action: res.action, reason: res.reason, which: res.which };
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
      return costText({ demo, todayUsd: cs.todayUsd, limits: cs.limits, session, action: g.action, which: g.which, reason: g.reason, guard: cs.guard, reservedUsd: cs.reserved?.usd ?? 0, complete });
    },
    async caps() {
      const cs = engine.capsStatus();
      const view = capsView(dataDir);
      const g = guardFor(cs, null, 0); // "Today": the daily and per-provider caps, which are the same for every session
      return capsText({ demo, limits: cs.limits, perProvider: cs.perProvider, stopAtPlanLimit: view.stopAtPlanLimit, action: g.action, which: g.which, reason: g.reason, problem: view.problem });
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
      const t = receiptReplyText(rc, { demo, partial: !complete });
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
