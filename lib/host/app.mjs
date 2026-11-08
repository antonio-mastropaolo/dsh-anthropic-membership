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
  engine = createCostEngine({ dataDir, localProviders: () => getConfig().localProviders }),
  logger = null,
  refreshEnabled = process.env.DSH_HUB_REFRESH !== "0",
} = {}) {
  const statePath = join(dataDir, "accounts-state.json");
  const readOpts = { statePath, ...(credentialsPath ? { credentialsPath } : {}) };
  let watchdog = null;
  let authorization = null;
  const warn = (m) => { try { logger?.warn?.(`model-hub: ${m}`); } catch { /* ignore */ } };

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
    allowedOrigins, port, accounts, signin, gpu, getConfig, engine, legacy, log: warn,
  });

  return {
    handler, engine, accounts, signin, gpu, getConfig,
    setAuthorization(a) { authorization = a; },
    /** Start report-only; upgrade to the DSH-seam refresher when `credentials` is injected. */
    startAccounts() {
      try { startWatchdog(null); } catch (e) { warn(`watchdog (report-only) failed: ${String(e?.message || e).slice(0, 120)}`); }
    },
    upgradeRefresher(credentialsCtx) {
      if (!refreshEnabled) return false;
      let refresher = null;
      try { refresher = makeRefresher(credentialsCtx); } catch (e) { warn(`refresher unavailable: ${String(e?.message || e).slice(0, 120)}`); }
      if (!refresher) return false;
      try { startWatchdog(refresher); return true; } catch (e) { warn(`watchdog (refresh) failed: ${String(e?.message || e).slice(0, 120)}`); return false; }
    },
    stop() { try { watchdog?.stop(); } catch { /* ignore */ } },
  };
}
