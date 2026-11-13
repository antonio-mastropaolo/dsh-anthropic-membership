// lib/demo/host.mjs: demo mode served by the host. DSH_HUB_DEMO names a sealed demo folder (see gate.mjs); the host then
// reads only that folder and serves fixtures. It registers no llm/stream guard, no usage capture, no session hook, no
// watchdog and no credentials seam, so nothing is recorded, capped or written. The only DSH seams used are webApp and
// commands (the four read-only slash commands, which read this demo folder only).
import { createServer } from "node:http";
import { join } from "node:path";
import { createHub } from "../host/app.mjs";
import { PORT } from "../oauth.mjs";
import { readDemoAccounts } from "./accounts.mjs";
import { createDemoEngine, demoConfig, replayDemoCache } from "./engine.mjs";
import { createDemoGpuClient } from "./gpu.mjs";
import { createDemoLegacy } from "./legacy.mjs";
import { createCommandDefs, registerCommands } from "../commands.mjs";

/** The hub on a demo folder: the real routes and client code over fixtures; POST is deny-by-default (see routes.mjs). */
export function createDemoHub({ demo, allowedOrigins, port = PORT, logger = null, webOrigin = () => null, onError = () => {}, commands }) {
  const engine = createDemoEngine(demo);
  // the cache tracker is filled from demo-cache.json; a failure only leaves /cache empty
  const replayed = replayDemoCache(engine, demo.dir).catch((e) => { onError(`demo cache replay failed (${e?.code || "error"})`); });
  const hub = createHub({
    allowedOrigins,
    port,
    dataDir: demo.dir,
    credentialsPath: join(demo.dir, "demo-accounts.json"),
    legacy: createDemoLegacy({ manifest: demo.manifest }),
    getConfig: () => demoConfig(demo.dir),
    gpu: createDemoGpuClient(),
    engine,
    readAccountsFn: () => readDemoAccounts({ dir: demo.dir, manifest: demo.manifest }),
    refreshEnabled: false,
    apiKeyRoutes: () => [],
    routeBaseURLs: () => null,
    webOrigin,
    logger,
    ...(commands ? { commands } : {}),
    demo: { note: demo.note },
  });
  return { ...hub, replayed };
}

/** Called by lib/index.js apply() instead of the normal host when resolveDemo accepted DSH_HUB_DEMO. */
export function applyDemoHost(ctx, demo, { hubWarn, buildAllowedOrigins, port = PORT }) {
  hubWarn(`model-hub: DEMO MODE ON (${demo.dir}): synthetic data; spend capture and caps are OFF; nothing is written to the demo folder; unset DSH_HUB_DEMO to leave it`);
  let advertised = null;
  const allowedOrigins = () => buildAllowedOrigins({ advertised, config: demoConfig(demo.dir), env: process.env });
  const webOrigin = () => {
    if (!advertised) return null;
    try { return new URL(advertised).origin; } catch { return null; }
  };
  const cmdState = { registered: [], collided: [] };
  const hub = createDemoHub({ demo, allowedOrigins, port, webOrigin, onError: hubWarn, commands: () => cmdState });
  ctx.inject(["webApp"], (sub) => {
    try { advertised = sub.webApp?.getAdvertisedUrl?.() ?? null; } catch { advertised = null; }
  });
  // the same four read-only commands over the demo engine and the demo folder; every reply starts with the DEMO line
  ctx.inject(["commands"], (sub) => {
    const r = registerCommands(sub.commands, createCommandDefs({
      engine: hub.engine, dataDir: demo.dir, sessions: hub.sessions, routeAuth: hub.routeAuth, oauthProviders: hub.oauthProviders, demo: true,
    }), { warn: hubWarn });
    cmdState.registered = r.registered;
    cmdState.collided = r.collided;
  });
  const server = createServer(hub.handler);
  server.on("error", (err) => {
    hubWarn(
      err?.code === "EADDRINUSE"
        ? `model-hub: 127.0.0.1:${port} is in use: another DSH instance? Stop it first, the hub port is fixed. The demo is not served.`
        : `model-hub: demo host API not listening on ${port} (${err?.code || "error"})`,
    );
  });
  server.listen(port, "127.0.0.1");
  ctx.on("dispose", () => {
    hub.stop();
    try { server.close(); } catch { /* ignore */ }
  });
  return { server, hub };
}
