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
import { MODEL_RE, errMessage, parseGpus } from "./gpu.mjs";
import { redactSecrets } from "../accounts/errors.mjs";
import { isPriceId } from "../cost/prices.mjs";
import { SESSION_ID_RE } from "../cost/turns.mjs";

export const HUB_HEADER = "x-dsh-model-hub";
const SINCE_RE = /^(today|7d|30d|all)$/;
const BY_VALUES = new Set(["provider", "model", "session", "day", "purpose"]);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEMO_POSTS = new Set(["/gpu/switch", "/gpu/unload", "/accounts/refresh"]);
const MAX_BODY = 16 * 1024;
const BODY_TIMEOUT_MS = 10_000;

/** True when two origins are the same DSH instance (127.0.0.1 and localhost are twins). Mirrors the client's sameInstance(), but fails CLOSED on anything unparseable. */
export function sameInstanceOrigin(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    const host = (u) => (u.hostname === "localhost" ? "127.0.0.1" : u.hostname);
    return x.protocol === y.protocol && x.port === y.port && host(x) === host(y);
  } catch { return false; }
}

/** The caps view a page gets: everything but the caps.json path (the CLI shows the path; a page has no use for the user's home directory). */
function pageCapsView(view) {
  const { file, ...rest } = view || {};
  return rest;
}

export function createRoutes({
  allowedOrigins,
  port = 8185,
  accounts,
  signin,
  gpu,
  getConfig = () => ({ gpuServer: null }),
  engine,
  legacy,
  log = () => {},
  // the DSH web origin this hub belongs to (null until DSH advertises it): lets a UI on another port notice
  webOrigin = () => null,
  routeAuth = () => ({ known: false, apiKeyRoutes: [] }),
  // spend caps: { view(), set(input), brief() } (null: the /caps routes answer 503)
  caps = null,
  // demo mode ({ note }): reported by /healthz and /status, and every POST outside DEMO_POSTS is refused with 409
  demo = null,
  // spend forecast (estimates only): { report() } (null: GET /forecast answers 503)
  forecast = null,
  // per-session views over the ledger: { turns(sessionId), receipt(sessionId) } (null: GET /spend/turns and /spend/session answer 503)
  sessions = null,
  // the slash commands this process registered: () => { registered: [name], collided: [name] } (a throw or junk reads as empty)
  commandsStatus = () => ({ registered: [], collided: [] }),
}) {
  // allowedOrigins: an array, or a function returning one (the host adds DSH's advertised origin after boot).
  const originList = typeof allowedOrigins === "function" ? allowedOrigins : () => allowedOrigins || [];
  const originAllowed = (o) => typeof o === "string" && originList().includes(o);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function send(res, origin, status, body, extra = {}) {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    };
    if (originAllowed(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      headers["access-control-allow-headers"] = `${HUB_HEADER}, content-type`;
      headers.vary = "Origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
  const fail = (res, origin, status, error) => send(res, origin, status, { error });
  // the spend guard's policy and error count (this DSH process); null when the engine cannot report it
  const guardStatus = () => { try { return engine?.guardStatus?.() ?? null; } catch { return null; } };
  // command names only (a short lowercase word each), never anything else a dependency might hand over
  const commandNames = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(n)).slice(0, 16) : []);
  const commandsInfo = () => { try { const c = commandsStatus() || {}; return { registered: commandNames(c.registered), collided: commandNames(c.collided) }; } catch { return { registered: [], collided: [] }; } };

  function readJson(req) {
    return new Promise((resolveP, rejectP) => {
      // settle exactly once, even if the client aborts or stalls mid-body
      let settled = false;
      const timer = setTimeout(() => { const e = new Error("request body timeout"); e.status = 408; reject(e); req.destroy(); }, BODY_TIMEOUT_MS);
      const resolve = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(v); } };
      const reject = (e) => { if (!settled) { settled = true; clearTimeout(timer); rejectP(e); } };
      req.on("aborted", () => { const e = new Error("request aborted"); e.status = 400; reject(e); });
      req.on("close", () => { if (!req.complete) { const e = new Error("request aborted"); e.status = 400; reject(e); } });
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
        if (ct !== "application/json") { const e = new Error("content-type must be application/json"); e.status = 415; reject(e); return; }
        if (size === 0) { const e = new Error("a JSON object body is required"); e.status = 400; reject(e); return; }
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

  const gpuReply = (res, origin, r) =>
    send(res, origin, r.status, r.status >= 400 ? { error: errMessage(r.body) } : r.body);
  // /rocco/* are kept as aliases of the canonical /gpu/* paths (the author's CLI and older UI use them).
  const canon = (p) => (/^\/rocco\/(gpus|models|switch|unload)$/.test(p) ? `/gpu/${p.slice(7)}` : p);
  const gpuServer = () => { try { return getConfig()?.gpuServer ?? null; } catch { return null; } };

  async function getRoute(rawPath, q, res, origin) {
    const path = canon(rawPath);
    switch (path) {
      case "/healthz":
        return send(res, origin, 200, { ok: true, webOrigin: webOrigin(), demo: Boolean(demo) });
      case "/status":
        return send(res, origin, 200, { ...(await legacy.status()), webOrigin: webOrigin(), routeAuth: routeAuth(), caps: caps ? caps.brief() : null, guard: guardStatus(), commands: commandsInfo(), demo: Boolean(demo), ...(demo ? { demoNote: demo.note } : {}) });
      case "/caps":
        return caps ? send(res, origin, 200, pageCapsView(caps.view())) : fail(res, origin, 503, "caps unavailable");
      case "/forecast":
        // no query parameter is read: the report is the same for every caller
        return forecast ? send(res, origin, 200, forecast.report()) : fail(res, origin, 503, "forecast unavailable");
      case "/accounts": {
        const s = accounts.state();
        // identity (email, plan) per provider where it is known; never fails the list
        let ids = {};
        try { ids = (await legacy?.identities?.()) || {}; } catch { ids = {}; }
        return send(res, origin, 200, { ...s, accounts: Array.isArray(s.accounts) ? s.accounts.map((x) => (x && ids[x.provider] ? { ...x, identity: ids[x.provider] } : x)) : s.accounts, ...(demo ? { demo: true } : {}) });
      }
      case "/accounts/flows":
        // demo mode has no DSH authorization service (so signin.flows would answer 503): no sign-in is ever pending
        return send(res, origin, 200, { flows: demo ? [] : await signin.flows() });
      case "/hub/config": {
        // UI-relevant, non-secret config: always-shown price rows. (The GPU server has its own /gpu/config.)
        const c = getConfig() || {};
        return send(res, origin, 200, { priceModels: Array.isArray(c.priceModels) ? [...c.priceModels] : [], subscriptions: Array.isArray(c.subscriptions) ? [...c.subscriptions] : [] });
      }
      case "/gpu/config": {
        const g = gpuServer();
        return send(res, origin, 200, g ? { configured: true, id: g.id, name: g.name, icon: g.icon, hideModels: g.hideModels || [], defaultModel: g.defaultModel || null } : { configured: false });
      }
      case "/gpu/gpus":
        if (!gpuServer()) return send(res, origin, 200, { ok: false, configured: false });
        return gpuReply(res, origin, await gpu.gpus());
      case "/gpu/models":
        if (!gpuServer()) return send(res, origin, 200, { ok: false, configured: false });
        return gpuReply(res, origin, await gpu.models());
      case "/spend": {
        const since = q.get("since") ?? "today";
        const by = q.get("by") ?? "provider";
        if (!SINCE_RE.test(since)) return fail(res, origin, 400, "since must be today|7d|30d|all");
        if (!BY_VALUES.has(by)) return fail(res, origin, 400, "by must be provider|model|session|day|purpose");
        return send(res, origin, 200, await engine.spendReport({ since, by }));
      }
      case "/spend/turns": {
        // the session id is an opaque exact-match string: validated here, never joined to a path
        const id = q.get("session");
        if (id === null || !SESSION_ID_RE.test(id)) return fail(res, origin, 400, "session must be a session id (1-128 characters of A-Za-z0-9_.:-)");
        if (!sessions) return fail(res, origin, 503, "sessions unavailable");
        const r = sessions.turns(id);
        return send(res, origin, 200, demo ? { ...r, demo: true } : r);
      }
      case "/spend/session": {
        // same rule as /spend/turns, but the parameter is named id: an opaque exact-match string, never a path
        const id = q.get("id");
        if (id === null || !SESSION_ID_RE.test(id)) return fail(res, origin, 400, "id must be a session id (1-128 characters of A-Za-z0-9_.:-)");
        if (!sessions) return fail(res, origin, 503, "sessions unavailable");
        const r = sessions.receipt(id);
        return send(res, origin, 200, demo ? { ...r, demo: true } : r);
      }
      case "/ledger/verify": {
        const since = q.get("since") ?? "all";
        if (!SINCE_RE.test(since)) return fail(res, origin, 400, "since must be today|7d|30d|all");
        return send(res, origin, 200, await engine.ledgerVerify({ since }));
      }
      case "/prices": {
        const raw = q.get("models");
        if (!raw) return fail(res, origin, 400, "models=provider/model,... is required");
        const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length < 1 || list.length > 50 || !list.every(isPriceId)) return fail(res, origin, 400, "models: 1-50 provider/model ids");
        return send(res, origin, 200, await engine.prices(list));
      }
      case "/cache": {
        const session = q.get("session");
        if (session !== null && !ID_RE.test(session)) return fail(res, origin, 400, "bad session id");
        const r = engine.cacheReport(session || undefined);
        if (r === null) return fail(res, origin, 404, "unknown session");
        // demo: the CLI prints its DEMO banner for any host-sourced body that says so
        return send(res, origin, 200, demo ? { ...r, demo: true } : r);
      }
      default: {
        const m = /^\/accounts\/signin\/([a-z0-9-]{1,32})$/.exec(path);
        if (m) return send(res, origin, 200, signin.status(m[1]));
        return fail(res, origin, 404, "not found");
      }
    }
  }

  async function postRoute(rawPath, req, res, origin) {
    const path = canon(rawPath);
    // same field as the GET routes, so a client can tell "not configured" from any other refusal
    if ((path === "/gpu/switch" || path === "/gpu/unload") && !gpuServer()) return send(res, origin, 409, { error: "no GPU server configured", configured: false });
    // Changing caps is the one POST that must come from the page of the DSH instance this hub belongs to: another
    // instance's page is on the allow-list too (other ports), but must not edit this instance's limits.
    if (path === "/caps") {
      if (!caps) return fail(res, origin, 503, "caps unavailable");
      const owner = webOrigin();
      if (!owner) return fail(res, origin, 409, "the model hub has not reported which DSH instance it belongs to yet; try again in a moment");
      if (!sameInstanceOrigin(origin, owner)) return fail(res, origin, 403, `this page is not the DSH instance that owns the model hub; open ${owner} to change caps`);
    }
    switch (path) {
      case "/caps": {
        const b = await readJson(req);
        const keys = Object.keys(b);
        if (keys.length !== 1 || keys[0] !== "set" || b.set === null || typeof b.set !== "object" || Array.isArray(b.set)) return fail(res, origin, 400, 'body must be {"set": {...}}');
        const r = caps.set(b.set);
        if (!r.ok) return send(res, origin, 400, { error: r.errors.join("; "), errors: r.errors });
        return send(res, origin, 200, pageCapsView(caps.view()));
      }
      case "/gpu/switch": {
        const b = await readJson(req);
        if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return fail(res, origin, 400, "model must be a model id");
        const gpus = parseGpus(b.gpus);
        if (b.auto === true && gpus) return fail(res, origin, 400, "auto and gpus are mutually exclusive");
        return gpuReply(res, origin, await gpu.switch(b.model, gpus, { force: b.force === true, auto: b.auto === true }));
      }
      case "/gpu/unload":
        await readJson(req);
        return gpuReply(res, origin, await gpu.unload());
      case "/accounts/signin": {
        const b = await readJson(req);
        if (typeof b.provider !== "string") return fail(res, origin, 400, "provider is required");
        return send(res, origin, 202, signin.start(b.provider, b.method ?? "oauth"));
      }
      case "/accounts/refresh":
        await readJson(req);
        return send(res, origin, 200, await accounts.tick({ force: true }));
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
    const originOk = originAllowed(origin);
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
      if (st >= 500) log(`route ${method} ${path}: ${redactSecrets(String(err?.message || err).slice(0, 120))}`);
      if (res.headersSent) return;
      if (st === 413) {
        res.on("finish", () => req.destroy());
        send(res, origin, st, { error: "body too large" }, { connection: "close" });
        return;
      }
      fail(res, origin, st, st >= 500 && st !== 503 ? "internal error" : redactSecrets(String(err?.message || "error")));
    });

    if (method === "GET" || method === "HEAD") {
      // Every GET but /healthz needs the hub header. A web page's <img>/<script>/<link> request carries no Origin and
      // cannot set a header, so it can never trigger /status (a Claude usage call) or GPU-server proxying.
      if (path !== "/healthz" && req.headers[HUB_HEADER] !== "1") return fail(res, originOk ? origin : undefined, 403, `missing ${HUB_HEADER} header`);
      // a pending sign-in's notices carry the authorize URL (state + PKCE challenge): browser-UI callers only
      if (path.startsWith("/accounts/signin") && !originOk) return fail(res, undefined, 403, "origin not allowed");
      return void done(getRoute(path, url.searchParams, res, origin));
    }

    if (method === "POST") {
      if (!originOk) return fail(res, undefined, 403, "origin not allowed");
      const hdr = req.headers[HUB_HEADER] === "1";
      if (!hdr) return fail(res, origin, 403, `missing ${HUB_HEADER} header`);
      // demo mode is read-only: deny by default, so a route added later can never write while a demo is served
      if (demo && !DEMO_POSTS.has(canon(path))) return fail(res, origin, 409, "demo mode: read-only (nothing is recorded or changed)");
      return void done(postRoute(path, req, res, origin));
    }
    return fail(res, origin, 405, "method not allowed");
  };
}
