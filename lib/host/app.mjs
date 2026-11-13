/** Assembles the host: engine + accounts watchdog facade + sign-in driver + GPU client + routes. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createWatchdog, makeRefresher, readAccounts } from "../accounts/index.mjs";
import { createCostEngine, DEFAULT_DATA_DIR } from "./engine.mjs";
import { createRoutes } from "./routes.mjs";
import { capsView, loadCaps, setCaps } from "../cost/caps.mjs";
import { buildForecast } from "../cost/forecast.mjs";
import { ledgerRows } from "../cost/ledger.mjs";
import { buildTurns } from "../cost/turns.mjs";
import { buildReceipt, receiptMarkdown } from "../cost/receipt.mjs";
import { loadConfig } from "../config.mjs";
import { createGpuClient } from "./gpu.mjs";
import { createSignIn } from "./signin.mjs";
import { redactSecrets, sanitizeError } from "../accounts/errors.mjs";

export function createHub({
  allowedOrigins,
  port = 8185,
  dataDir = DEFAULT_DATA_DIR,
  credentialsPath,
  legacy,
  getConfig = () => loadConfig({ dataDir }),
  gpu = createGpuClient({ getConfig }),
  engine: engineIn = null,
  logger = null,
  readLedger = ledgerRows, // test seam: the reader behind GET /spend/turns and /spend/session
  webOrigin = () => null,   // the DSH web origin this hub serves (reported by /healthz and /status)
  // provider routes whose DSH profile names an API key (apiKeyEnv); null = unknown (the route config cannot be read)
  apiKeyRoutes = () => [],
  // provider id -> base URL of its DSH route (null = unknown)
  routeBaseURLs = () => null,
  // the opt-in plan stop (lib/cost/plan-guard.mjs); null = off
  planGuard = null,
  now = Date.now,           // test seams: clock and accounts reader
  readAccountsFn = readAccounts,
  refreshEnabled = process.env.DSH_HUB_REFRESH !== "0",
  commands = () => ({ registered: [], collided: [] }), // the slash commands this process registered (reported by /status)
  demo = null,              // demo mode ({ note }): reported by /healthz and /status, POST is deny-by-default
} = {}) {
  const statePath = join(dataDir, "accounts-state.json");
  const readOpts = { statePath, ...(credentialsPath ? { credentialsPath } : {}) };
  let watchdog = null;
  let authorization = null;
  let refresher = null;   // set once DSH's credentials service is injected
  let started = false;    // the watchdog runs only after this process owns the host port
  const warn = (m) => { try { logger?.warn?.(`model-hub: ${redactSecrets(m)}`); } catch { /* ignore */ } };

  // Providers whose calls use an OAuth grant (Claude Pro/Max, ChatGPT/Codex, ...): only those are billed as
  // "subscription". DSH sends a route's API key (apiKeyEnv in its profile) instead of a stored grant, so such a
  // route is metered even when a grant is stored. Whenever the grants or the route config cannot be read, nothing
  // counts as subscription until a read succeeds again: an earlier answer is never reused, so a stale grant can
  // never make paid calls free. Each answer is kept for 30 s.
  let oauthCache = { at: 0, value: [] };
  const routeAuth = () => {
    let keyed;
    try { keyed = apiKeyRoutes(); } catch { keyed = null; }
    return Array.isArray(keyed) ? { known: true, apiKeyRoutes: [...keyed].sort() } : { known: false, apiKeyRoutes: [] };
  };
  const oauthProviders = () => {
    if (now() - oauthCache.at < 30_000) return oauthCache.value;
    let value = [];
    try {
      const ra = routeAuth();
      value = ra.known
        ? readAccountsFn(readOpts).filter((a) => a.signedIn && a.kind === "oauth" && !ra.apiKeyRoutes.includes(a.provider)).map((a) => a.provider)
        : [];
    } catch { value = []; }
    oauthCache = { at: now(), value };
    return value;
  };
  const engine = engineIn ?? createCostEngine({
    dataDir, logger,
    localProviders: () => getConfig().localProviders,
    plans: () => getConfig().plans,
    subscriptions: () => getConfig().subscriptions,
    routeBaseURLs,
    oauthProviders,
    planGuard,
  });

  function startWatchdog(refresh) {
    try { watchdog?.stop(); } catch { /* ignore */ }
    watchdog = createWatchdog({
      read: () => readAccountsFn(readOpts),
      refresh,
      statePath,
      onChange: () => {},
    });
    watchdog.start();
  }

  // Diagnostics for the refresh path: is there a live DSH credential store to write refreshed grants into, and has
  // DSH replaced the one that was registered when the refresher was set up (it may, while it runs)?
  let credsCtx = null;
  let firstCreds = null;
  const credentialStore = () => {
    if (!credsCtx) return { state: "none", replacedSinceStart: false };
    let c;
    try { c = credsCtx.get?.("credentials") ?? credsCtx.credentials; } catch { c = undefined; }
    if (!c) return { state: "none", replacedSinceStart: Boolean(firstCreds) };
    const closed = typeof c.isClosed === "function" ? Boolean(c.isClosed()) : false;
    return { state: closed ? "disposed" : "live", replacedSinceStart: Boolean(firstCreds) && c !== firstCreds };
  };
  const accounts = {
    state() {
      let base;
      if (watchdog) base = watchdog.state();
      else {
        // never a 500: without DSH's yaml (or with an unreadable credential file) the list is empty and says why
        try { base = { running: false, reportOnly: true, lastTickAt: null, accounts: readAccountsFn(readOpts) }; }
        catch (e) { base = { running: false, reportOnly: true, lastTickAt: null, accounts: [], unavailable: sanitizeError(e) }; }
      }
      return { ...base, credentialStore: credentialStore() };
    },
    async tick(opts) {
      if (!watchdog) return accounts.state();
      await watchdog.tick(opts);
      return accounts.state();
    },
  };

  const signin = createSignIn({
    getAuthorization: () => authorization,
    onSettled: () => { accounts.tick({ force: true }).catch(() => {}); },
  });

  const capsApi = {
    view: () => { const v = capsView(dataDir); let status = null; try { status = engine.capsStatus?.() ?? null; } catch { status = null; } return { ...v, status }; },
    set: (input) => setCaps(dataDir, input),
    brief: () => { const v = capsView(dataDir); return { problem: v.problem, fatal: v.fatal, stopAtPlanLimit: v.stopAtPlanLimit }; },
  };
  // GET /forecast: estimates only (never read by the guard). Computed from the ledger, the caps file and config.json
  // plans, and kept for 5 s so a UI poll and a CLI call do not each re-read the ledger.
  let fcMemo = { at: -Infinity, value: null };
  const forecastApi = {
    report: () => {
      const age = now() - fcMemo.at;
      if (fcMemo.value && age >= 0 && age < 5000) return fcMemo.value;
      let session = null; // the session cap is forecast for the session in use; without one, the newest ledger row's
      try { session = engine.capsStatus?.().session ?? null; } catch { session = null; }
      const at = now();
      fcMemo = { at, value: buildForecast({ dataDir, caps: loadCaps(dataDir), plans: getConfig().plans, sessionId: session, now: at }) };
      return fcMemo.value;
    },
  };
  // GET /spend/turns: pure builders over the cleaned ledger rows. The rows are held for 2 s (a UI poll, a CLI call and several
  // browsers share that read). After that they are read again only when a ledger file changed: the files are compared by name,
  // inode, size, mtime and ctime (a handful of stat calls), so an open conversation polling an idle ledger never rebuilds the
  // row list on the host's event loop. A read that was not complete is never held past the 2 s window. The ledger holds no
  // prompt or completion text, so neither does a response.
  const ledgerStamp = () => {
    const missing = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";
    let names;
    try { names = readdirSync(dataDir).filter((f) => /^\.?spend\./.test(f)).sort(); } catch (e) { return missing(e) ? "" : null; }
    const parts = [];
    for (const f of names) {
      try { const st = statSync(join(dataDir, f)); parts.push(`${f}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`); } catch (e) { if (!missing(e)) return null; }
    }
    return parts.join("|");
  };
  let rowsMemo = { at: -Infinity, stamp: null, value: null };
  const ledgerNow = () => {
    const t = now();
    const age = t - rowsMemo.at;
    if (rowsMemo.value && age >= 0 && age < 2000) return rowsMemo.value;
    const stamp = ledgerStamp();
    const whole = rowsMemo.value && rowsMemo.value.complete !== false && !rowsMemo.value.unreadable;
    if (whole && stamp !== null && stamp === rowsMemo.stamp) { rowsMemo.at = t; return rowsMemo.value; }
    rowsMemo = { at: t, stamp, value: readLedger(dataDir) };
    return rowsMemo.value;
  };
  const sessionsApi = {
    turns(id) {
      const { rows, complete, unreadable } = ledgerNow();
      return { ...buildTurns(rows, id), complete: complete !== false && !unreadable, unreadable: Boolean(unreadable) };
    },
    // GET /spend/session: the receipt plus the Markdown built by the same function the CLI uses (one string for the button and
    // the terminal), the caps in numbers only, and whether the ledger was read in full. No prompt text, path or data dir.
    receipt(id) {
      const { rows, complete, unreadable } = ledgerNow();
      const rc = buildReceipt(rows, id);
      let caps = null;
      try {
        const st = engine.capsStatus?.();
        if (st) caps = { dailyUsd: st.limits.dailyUsd, sessionUsd: st.limits.sessionUsd, todayUsd: st.todayUsd, action: st.action };
      } catch { caps = null; }
      return { ...rc, markdown: receiptMarkdown(rc, { demo: Boolean(demo) }), caps, complete: complete !== false && !unreadable, unreadable: Boolean(unreadable) };
    },
  };
  const handler = createRoutes({
    allowedOrigins, port, accounts, signin, gpu, getConfig, engine, legacy, log: warn, webOrigin, routeAuth, caps: capsApi, demo, forecast: forecastApi, sessions: sessionsApi, commandsStatus: commands,
  });

  return {
    handler, engine, accounts, signin, gpu, getConfig, forecast: forecastApi, sessions: sessionsApi, routeAuth,
    /** Providers currently billed as subscription (read-only view, for diagnostics and tests). */
    oauthProviders: () => [...oauthProviders()],
    setAuthorization(a) { authorization = a; },
    /** Start the watchdog (call once this process owns the host port), with the refresher if one is known. */
    startAccounts() {
      started = true;
      try { startWatchdog(refresher); } catch (e) { warn(`watchdog failed: ${String(e?.message || e).slice(0, 120)}`); }
    },
    /** Remember DSH's credential seam; if the watchdog already runs, restart it refreshing (never downgrade). */
    upgradeRefresher(credentialsCtx) {
      if (!refreshEnabled) return false;
      let r = null;
      try { r = makeRefresher(credentialsCtx); } catch (e) { warn(`refresher unavailable: ${String(e?.message || e).slice(0, 120)}`); }
      if (!r) return false;
      refresher = r;
      credsCtx = credentialsCtx;
      if (!firstCreds) { try { firstCreds = credentialsCtx.get?.("credentials") ?? credentialsCtx.credentials ?? null; } catch { firstCreds = null; } }
      if (!started) return true; // picked up by startAccounts() once the port is ours
      try { startWatchdog(refresher); return true; } catch (e) { warn(`watchdog (refresh) failed: ${String(e?.message || e).slice(0, 120)}`); return false; }
    },
    stop() { try { watchdog?.stop(); } catch { /* ignore */ } },
  };
}
