/**
 * HTTP surface of the host plugin on 127.0.0.1:8185. Pure request handler over injected deps so the
 * whole Origin/CSRF matrix is testable without DSH.
 *
 * Policy (spec "Plugin host API"):
 *  - Host header must be a loopback name on this port (DNS-rebinding defence).
 *  - Any request carrying a disallowed Origin (incl. "null") -> 403, GET/HEAD/OPTIONS included.
 *  - POST needs an allowed Origin (missing -> 403) AND header x-dsh-model-hub: 1, JSON body only.
 *  - CORS headers are emitted only for an allowed Origin; never "*", never a reflected foreign Origin.
 *  - No legacy header: /login and /logout are gone; sign-in/out is DSH-native via /accounts/signin.
 */
import { MODEL_RE, errMessage, parseGpus } from "./rocco.mjs";

export const HUB_HEADER = "x-dsh-model-hub";
const SINCE_RE = /^(today|7d|30d|all)$/;
const BY_VALUES = new Set(["provider", "model", "session", "day"]);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const PRICE_RE = /^[A-Za-z0-9_.:/@-]{1,120}$/;
const MAX_BODY = 16 * 1024;

export function createRoutes({
  allowedOrigins,
  port = 8185,
  accounts,
  signin,
  rocco,
  engine,
  legacy,
  log = () => {},
}) {
  const origins = new Set(allowedOrigins);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function send(res, origin, status, body, extra = {}) {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    };
    if (typeof origin === "string" && origins.has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-allow-headers"] = `${HUB_HEADER}, content-type`;
      headers.vary = "Origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
  const fail = (res, origin, status, error) => send(res, origin, status, { error });

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const len = Number(req.headers["content-length"] || 0);
      if (len > MAX_BODY) { const e = new Error("body too large"); e.status = 413; reject(e); return; }
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) { const e = new Error("body too large"); e.status = 413; reject(e); } return; }
        chunks.push(c);
      });
      req.on("error", reject);
      req.on("end", () => {
        if (size === 0) { resolve({}); return; }
        if (ct !== "application/json") { const e = new Error("content-type must be application/json"); e.status = 415; reject(e); return; }
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
          resolve(v);
        } catch {
          const e = new Error("invalid json");
          e.status = 400;
          reject(e);
        }
      });
    });
  }

  const roccoReply = (res, origin, r) =>
    send(res, origin, r.status, r.status >= 400 ? { error: errMessage(r.body) } : r.body);

  async function getRoute(path, q, res, origin) {
    switch (path) {
      case "/healthz":
        return send(res, origin, 200, { ok: true });
      case "/status":
        return send(res, origin, 200, await legacy.status());
      case "/accounts": {
        const s = accounts.state();
        return send(res, origin, 200, s);
      }
      case "/accounts/flows":
        return send(res, origin, 200, { flows: await signin.flows() });
      case "/rocco/gpus":
        return roccoReply(res, origin, await rocco.gpus());
      case "/rocco/models":
        return roccoReply(res, origin, await rocco.models());
      case "/spend": {
        const since = q.get("since") ?? "today";
        const by = q.get("by") ?? "provider";
        if (!SINCE_RE.test(since)) return fail(res, origin, 400, "since must be today|7d|30d|all");
        if (!BY_VALUES.has(by)) return fail(res, origin, 400, "by must be provider|model|session|day");
        return send(res, origin, 200, await engine.spendReport({ since, by }));
      }
      case "/prices": {
        const raw = q.get("models");
        if (!raw) return fail(res, origin, 400, "models=provider/model,... is required");
        const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length < 1 || list.length > 50 || !list.every((m) => PRICE_RE.test(m))) return fail(res, origin, 400, "models: 1-50 provider/model ids");
        return send(res, origin, 200, await engine.prices(list));
      }
      case "/cache": {
        const session = q.get("session");
        if (session !== null && !ID_RE.test(session)) return fail(res, origin, 400, "bad session id");
        const r = engine.cacheReport(session || undefined);
        if (r === null) return fail(res, origin, 404, "unknown session");
        return send(res, origin, 200, r);
      }
      default: {
        const m = /^\/accounts\/signin\/([a-z0-9-]{1,32})$/.exec(path);
        if (m) return send(res, origin, 200, signin.status(m[1]));
        return fail(res, origin, 404, "not found");
      }
    }
  }

  async function postRoute(path, req, res, origin) {
    switch (path) {
      case "/rocco/switch": {
        const b = await readJson(req);
        if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return fail(res, origin, 400, "model must be a model id");
        const gpus = parseGpus(b.gpus);
        if (b.auto === true && gpus) return fail(res, origin, 400, "auto and gpus are mutually exclusive");
        return roccoReply(res, origin, await rocco.switch(b.model, gpus, { force: b.force === true, auto: b.auto === true }));
      }
      case "/rocco/unload":
        await readJson(req);
        return roccoReply(res, origin, await rocco.unload());
      case "/accounts/signin": {
        const b = await readJson(req);
        if (typeof b.provider !== "string") return fail(res, origin, 400, "provider is required");
        return send(res, origin, 202, signin.start(b.provider, b.method ?? "oauth"));
      }
      case "/accounts/refresh":
        await readJson(req);
        return send(res, origin, 200, await accounts.tick({ force: true }));
      case "/access": {
        const b = await readJson(req);
        return send(res, origin, ...(await legacy.access(b)));
      }
      default: {
        let m = /^\/accounts\/signin\/([a-z0-9-]{1,32})\/answer$/.exec(path);
        if (m) {
          const b = await readJson(req);
          return send(res, origin, 200, signin.answer(m[1], b.text));
        }
        m = /^\/accounts\/signin\/([a-z0-9-]{1,32})\/cancel$/.exec(path);
        if (m) {
          await readJson(req);
          return send(res, origin, 200, await signin.cancel(m[1]));
        }
        return fail(res, origin, 404, "not found");
      }
    }
  }

  return function handle(req, res) {
    const origin = req.headers.origin;
    const method = req.method || "GET";
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      return fail(res, undefined, 400, "bad url");
    }
    if (!hosts.has(String(req.headers.host || "").toLowerCase())) return fail(res, undefined, 403, "host not allowed");
    const originOk = typeof origin === "string" && origins.has(origin);
    if (origin !== undefined && !originOk) return fail(res, undefined, 403, "origin not allowed");

    if (method === "OPTIONS") {
      if (!originOk) { res.writeHead(403); res.end(); return; }
      res.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": `${HUB_HEADER}, content-type`,
        "access-control-max-age": "600",
        vary: "Origin",
      });
      res.end();
      return;
    }

    const path = url.pathname;
    const done = (p) => p.catch((err) => {
      const st = Number.isInteger(err?.status) ? err.status : 500;
      if (st >= 500) log(`route ${method} ${path}: ${String(err?.message || err).slice(0, 120)}`);
      if (res.headersSent) return;
      if (st === 413) {
        res.on("finish", () => req.destroy());
        send(res, origin, st, { error: "body too large" }, { connection: "close" });
        return;
      }
      fail(res, origin, st, st >= 500 && st !== 503 ? "internal error" : String(err?.message || "error"));
    });

    if (method === "GET" || method === "HEAD") return void done(getRoute(path, url.searchParams, res, origin));

    if (method === "POST") {
      if (!originOk) return fail(res, undefined, 403, "origin not allowed");
      const hdr = req.headers[HUB_HEADER] === "1";
      if (!hdr) return fail(res, origin, 403, `missing ${HUB_HEADER} header`);
      return void done(postRoute(path, req, res, origin));
    }
    return fail(res, origin, 405, "method not allowed");
  };
}
