/**
 * Host half of dsh-model-hub: loopback control API on 127.0.0.1:8185 for the plugin's own UI, request image
 * cap, compaction slim, full access, account watchdog, usage capture -> cost ledger -> cache tracker, and the
 * pre-request spend-cap guard.
 *
 * It never writes DSH's settings or credential files. Allowed UI origins: http://{127.0.0.1,localhost}:3080
 * (DSH web's default), the origin DSH actually advertises (webApp.getAdvertisedUrl()), plus config.json
 * hub.allowedOrigins and env DSH_HUB_ALLOWED_ORIGINS.
 */
import { createServer } from "node:http";
import { DEFAULT_ORIGINS, PORT } from "./oauth.mjs";
import { installCompactionSlim } from "./compact-payload.mjs";
import { installFullAccess } from "./full-access.mjs";
import { installRequestImageCap, sharpAvailable } from "./request-image.mjs";
import { createHub } from "./host/app.mjs";
import { createLegacy } from "./host/legacy.mjs";
import { spendGuardMiddleware } from "./host/engine.mjs";
import { loadConfig } from "./config.mjs";
import { DEFAULT_DATA_DIR, secureDir } from "./paths.mjs";

let imageCapInstalled = false;
let compactionSlimInstalled = false;
let spendGuardInstalled = false;

export const name = "dsh-model-hub";

/** http(s)://host:port origin of a URL, plus its 127.0.0.1/localhost twin on the same port. */
export function originsFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [];
    const out = [u.origin];
    const port = u.port ? `:${u.port}` : "";
    if (u.hostname === "127.0.0.1") out.push(`${u.protocol}//localhost${port}`);
    if (u.hostname === "localhost") out.push(`${u.protocol}//127.0.0.1${port}`);
    return out;
  } catch {
    return [];
  }
}

/** The allowlist: defaults + advertised + config hub.allowedOrigins + env DSH_HUB_ALLOWED_ORIGINS (comma-separated). */
export function buildAllowedOrigins({ advertised = null, config = loadConfig(), env = process.env } = {}) {
  const set = new Set(DEFAULT_ORIGINS);
  if (advertised) for (const o of originsFor(advertised)) set.add(o);
  for (const o of config?.hub?.allowedOrigins || []) set.add(o);
  for (const raw of String(env.DSH_HUB_ALLOWED_ORIGINS || "").split(",")) {
    const o = originsFor(raw.trim())[0];
    if (o) set.add(o);
  }
  return [...set];
}

export function apply(ctx) {
  const logger = ctx?.logger ?? null;
  try {
    secureDir(DEFAULT_DATA_DIR);
  } catch (e) {
    logger?.warn?.(`model-hub: cannot prepare data dir ${DEFAULT_DATA_DIR} (${e?.code || "error"})`);
  }
  let advertised = null;
  const allowedOrigins = () => buildAllowedOrigins({ advertised });

  const legacy = createLegacy({
    features: {
      imageCap: () => imageCapInstalled,
      compactionSlim: () => compactionSlimInstalled,
      spendGuard: () => spendGuardInstalled,
    },
  });
  const webOrigin = () => (advertised ? originsFor(advertised)[0] ?? null : null);
  const hub = createHub({ allowedOrigins, port: PORT, legacy, logger, webOrigin });

  ctx.inject(["webApp"], (sub) => {
    try {
      advertised = sub.webApp?.getAdvertisedUrl?.() || null;
    } catch {
      advertised = null;
    }
  });
  ctx.inject(["attachments"], (sub) => {
    if (!sharpAvailable()) {
      logger?.warn?.("model-hub: image cap off (DSH's sharp not found; set DSH_NODE_MODULES)");
      return;
    }
    installRequestImageCap(sub.attachments);
    imageCapInstalled = true;
  });
  ctx.inject(["llm"], (sub) => {
    installCompactionSlim(sub.llm);
    compactionSlimInstalled = true;
  });
  // The agent loop dispatches through prepared calls, which skip `llm.stream`; the `llm/stream`
  // waterfall sees every request, so the spend guard lives there.
  ctx.on("llm/stream", spendGuardMiddleware(hub.engine, {
    onBlock: (v) => logger?.warn?.(`model-hub: request blocked (${v.which}): ${v.reason}`),
  }));
  spendGuardInstalled = true;
  ctx.inject(["authorization"], (sub) => {
    hub.setAuthorization(sub.authorization);
  });
  // The credentials service can be disposed and re-registered while DSH runs. The refresher therefore gets the
  // plugin's own ctx and looks the service up (ctx.get: active providers only) on every refresh; this inject is
  // just the signal that a credentials service exists.
  ctx.inject(["credentials"], () => {
    hub.upgradeRefresher(ctx);
  });
  ctx.on("session/event", (session, event) => {
    void hub.engine.onSessionEvent(session, event);
  });
  installFullAccess(ctx);

  // Cost capture and the spend guard run in every DSH process; the API and the account watchdog run only
  // in the process that owns the port, so two DSH instances never refresh the same grants twice.
  hub.engine.warm();
  const server = createServer(hub.handler);
  server.on("listening", () => hub.startAccounts());
  server.on("error", (err) => {
    logger?.warn?.(
      err?.code === "EADDRINUSE"
        ? `model-hub: 127.0.0.1:${PORT} is in use — another DSH instance? Model hub panels are unavailable in this one (cost capture and caps still run).`
        : `model-hub: host API not listening on ${PORT} (${err?.code || "error"})`,
    );
  });
  server.listen(PORT, "127.0.0.1");
  ctx?.on?.("dispose", () => {
    hub.stop();
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });
}

export default apply;
