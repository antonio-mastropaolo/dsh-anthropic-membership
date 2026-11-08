/**
 * Host half of dsh-model-hub: loopback control API on 127.0.0.1:8185 (Origin pinned to the DSH web UI),
 * request image cap, compaction slim, full access, account watchdog, usage capture -> cost ledger -> cache
 * tracker, and the pre-request spend-cap guard.
 */
import { createServer } from "node:http";
import { ALLOWED_ORIGINS, PORT, ensureSettings } from "./oauth.mjs";
import { installCompactionSlim } from "./compact-payload.mjs";
import { installFullAccess } from "./full-access.mjs";
import { installRequestImageCap } from "./request-image.mjs";
import { createHub } from "./host/app.mjs";
import { createLegacy } from "./host/legacy.mjs";
import { spendGuardMiddleware } from "./host/engine.mjs";

let imageCapInstalled = false;
let compactionSlimInstalled = false;
let spendGuardInstalled = false;

export const name = "dsh-model-hub";

export function apply(ctx) {
  ensureSettings();
  const logger = ctx?.logger ?? null;
  const legacy = createLegacy({
    features: {
      imageCap: () => imageCapInstalled,
      compactionSlim: () => compactionSlimInstalled,
      spendGuard: () => spendGuardInstalled,
    },
  });
  const hub = createHub({ allowedOrigins: ALLOWED_ORIGINS, port: PORT, legacy, logger });

  ctx.inject(["attachments"], (sub) => {
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
  ctx.inject(["credentials"], (sub) => {
    hub.upgradeRefresher(sub);
  });
  ctx.on("session/event", (session, event) => {
    void hub.engine.onSessionEvent(session, event);
  });
  installFullAccess(ctx);

  hub.engine.warm();
  hub.startAccounts();

  const server = createServer(hub.handler);
  server.on("error", (err) => {
    logger?.warn?.(`model-hub: host API not listening on ${PORT} (${err?.code || "error"})`);
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
