/** Assembles the host: engine + accounts watchdog facade + sign-in driver + GPU client + routes. */
import { join } from "node:path";
import { createWatchdog, makeRefresher, readAccounts } from "../accounts/index.mjs";
import { createCostEngine, DEFAULT_DATA_DIR } from "./engine.mjs";
import { createRoutes } from "./routes.mjs";
import { loadConfig } from "../config.mjs";
import { createGpuClient } from "./gpu.mjs";
import { createSignIn } from "./signin.mjs";

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
  webOrigin = () => null,   // the DSH web origin this hub serves (reported by /healthz and /status)
  now = Date.now,           // test seams: clock and accounts reader
  readAccountsFn = readAccounts,
  refreshEnabled = process.env.DSH_HUB_REFRESH !== "0",
} = {}) {
  const statePath = join(dataDir, "accounts-state.json");
  const readOpts = { statePath, ...(credentialsPath ? { credentialsPath } : {}) };
  let watchdog = null;
  let authorization = null;
  let refresher = null;   // set once DSH's credentials service is injected
  let started = false;    // the watchdog runs only after this process owns the host port
  const warn = (m) => { try { logger?.warn?.(`model-hub: ${m}`); } catch { /* ignore */ } };

  // Providers whose DSH credential is an OAuth grant (Claude Pro/Max, ChatGPT/Codex, ...): only those are billed
  // as "subscription". An API key for the same provider is metered. Whenever the grants cannot be read (DSH's
  // yaml unavailable, unreadable file) nothing counts as subscription until a read succeeds again: an earlier
  // answer is never reused, so a stale grant can never make paid calls free. Each answer is kept for 30 s.
  let oauthCache = { at: 0, value: [] };
  const oauthProviders = () => {
    if (now() - oauthCache.at < 30_000) return oauthCache.value;
    let value = [];
    try { value = readAccountsFn(readOpts).filter((a) => a.signedIn && a.kind === "oauth").map((a) => a.provider); }
    catch { value = []; }
    oauthCache = { at: now(), value };
    return value;
  };
  const engine = engineIn ?? createCostEngine({
    dataDir, logger,
    localProviders: () => getConfig().localProviders,
    oauthProviders,
  });

  function startWatchdog(refresh) {
    try { watchdog?.stop(); } catch { /* ignore */ }
    watchdog = createWatchdog({
      read: () => readAccounts(readOpts),
      refresh,
      statePath,
      onChange: () => {},
    });
    watchdog.start();
  }

  const accounts = {
    state() {
      if (watchdog) return watchdog.state();
      return { running: false, reportOnly: true, lastTickAt: null, accounts: readAccounts(readOpts) };
    },
    async tick(opts) {
      if (!watchdog) return accounts.state();
      await watchdog.tick(opts);
      return watchdog.state();
    },
  };

  const signin = createSignIn({
    getAuthorization: () => authorization,
    onSettled: () => { accounts.tick({ force: true }).catch(() => {}); },
  });

  const handler = createRoutes({
    allowedOrigins, port, accounts, signin, gpu, getConfig, engine, legacy, log: warn, webOrigin,
  });

  return {
    handler, engine, accounts, signin, gpu, getConfig,
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
      if (!started) return true; // picked up by startAccounts() once the port is ours
      try { startWatchdog(refresher); return true; } catch (e) { warn(`watchdog (refresh) failed: ${String(e?.message || e).slice(0, 120)}`); return false; }
    },
    stop() { try { watchdog?.stop(); } catch { /* ignore */ } },
  };
}
