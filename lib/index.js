/**
 * Host half: loopback control API for Claude Pro/Max membership.
 * Bound to 127.0.0.1. Origin pinned to the DSH web UI.
 */
import { createServer } from "node:http";
import { ALLOWED_ORIGINS, PORT, ensureSettings, login, logout, status } from "./oauth.mjs";
import { installCompactionSlim } from "./compact-payload.mjs";
import { installRequestImageCap } from "./request-image.mjs";

const HEADER = "x-dsh-membership";

function allowOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.includes(origin);
}

function send(res, origin, statusCode, body) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (allowOrigin(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["access-control-allow-headers"] = HEADER;
    headers.vary = "Origin";
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

function reject(res, origin, statusCode, error) {
  send(res, origin, statusCode, { error });
}

let loginInFlight = null;
let imageCapInstalled = false;
let compactionSlimInstalled = false;

function handle(req, res) {
  const origin = req.headers.origin;
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    if (!allowOrigin(origin)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(204, {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": HEADER,
      "access-control-max-age": "600",
      vary: "Origin",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/status") {
    if (origin !== undefined && !allowOrigin(origin)) {
      reject(res, origin, 403, "origin not allowed");
      return;
    }
    send(res, origin, 200, {
      ...status(),
      imageCap: imageCapInstalled,
      compactionSlim: compactionSlimInstalled,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    send(res, origin, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/login" || url.pathname === "/logout")) {
    if (!allowOrigin(origin)) {
      reject(res, origin, 403, "origin not allowed");
      return;
    }
    if (req.headers[HEADER] !== "1") {
      reject(res, origin, 403, "missing membership header");
      return;
    }
    if (url.pathname === "/logout") {
      send(res, origin, 200, logout());
      return;
    }
    if (loginInFlight) {
      reject(res, origin, 409, "login already in progress");
      return;
    }
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
    loginInFlight.then(
      (st) => send(res, origin, 200, st),
      (err) => reject(res, origin, 500, String(err?.message || err)),
    );
    return;
  }

  reject(res, origin, 404, "not found");
}

export const name = "anthropic-membership";

export function apply(ctx) {
  ensureSettings();
  ctx.inject(["attachments"], (sub) => {
    installRequestImageCap(sub.attachments);
    imageCapInstalled = true;
  });
  ctx.inject(["llm"], (sub) => {
    installCompactionSlim(sub.llm);
    compactionSlimInstalled = true;
  });
  const server = createServer(handle);
  server.listen(PORT, "127.0.0.1");
  ctx?.on?.("dispose", () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });
}

export default apply;
